import { isDeepStrictEqual } from 'node:util';
import { ClaudeHooksError } from './errors.ts';
import type { EntryPlan, Json, Layout, PlannedGroup } from './settings.ts';

// The only writer of a settings file's text. HQ never rewrites a settings file from a parsed copy: parsing and printing changes things
// nobody asked to change (number spellings, string escapes, repeated keys, key order, the layout of every owner entry). So HQ's change
// is made as a few LOCAL text edits to the file as the owner wrote it: an entry HQ adds is inserted, an entry HQ removes is cut out,
// and every other byte (the byte-order mark, line endings, final newline, indentation, key order, the owner's other settings and hooks,
// dead text of a repeated key) stays exactly as it was.
//
// Repeated keys. `JSON.parse` (and so Claude Code) keeps the LAST member of a key, so that member is the effective one and the only
// one HQ reads or edits: an earlier member of the same key is dead text and is never touched. Cutting out an effective member that
// has an earlier twin would make the twin effective and change the settings, so `layoutOf` tells the plan (settings.ts) to leave an
// empty `{}` or `[]` there instead.
//
// The check. After the edits the result is parsed again, with the same last-key-wins reading, and must be exactly the settings the plan
// meant (`plan.next`). If the text cannot be edited into that, `spliceSettings` returns null and the caller refuses the file as
// `unsupported_layout`; there is no other way to write one. A file that is nested deeper than `MAX_DEPTH` is refused the same way.
//
// The scanner below reads text that `JSON.parse` has already accepted, so it only has to find where values start and end.

/** The deepest nesting HQ reads. Claude Code's settings are a few levels deep; anything beyond this is not edited. */
export const MAX_DEPTH = 64;

const WS = new Set([' ', '\t', '\n', '\r']);
const unsupported = (): never => {
  throw new ClaudeHooksError('unsupported_layout');
};

interface Style {
  /** The line ending the file uses (the first one it has). */
  nl: string;
  /** One level of indentation; null for a file written on one line. */
  unit: string | null;
}

interface Node {
  kind: 'object' | 'array' | 'scalar';
  start: number;
  /** One past the last character. */
  end: number;
  members: Member[];
  items: Node[];
}
interface Member {
  key: string;
  keyStart: number;
  value: Node;
}
/** A child of an object (a member) or of a list (an item), by where its text starts and ends. */
interface Child {
  from: number;
  to: number;
}

const childrenOf = (node: Node): Child[] =>
  node.kind === 'object'
    ? node.members.map((member) => ({ from: member.keyStart, to: member.value.end }))
    : node.items.map((item) => ({ from: item.start, to: item.end }));

function skip(text: string, from: number): number {
  let i = from;
  while (i < text.length && WS.has(text[i]!)) i += 1;
  return i;
}

function endOfString(text: string, from: number): number {
  let i = from + 1;
  while (i < text.length) {
    if (text[i] === '\\') i += 2;
    else if (text[i] === '"') return i + 1;
    else i += 1;
  }
  return unsupported();
}

/** The tree of `text`, which `JSON.parse` accepted. Nested deeper than `MAX_DEPTH` is refused. */
function parseTree(text: string): Node {
  const value = (from: number, depth: number): Node => {
    if (depth > MAX_DEPTH) return unsupported();
    const first = text[from];
    if (first === '{') {
      const members: Member[] = [];
      let i = skip(text, from + 1);
      while (text[i] !== '}') {
        const keyStart = i;
        const keyEnd = endOfString(text, i);
        const key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
        i = skip(text, keyEnd);
        if (text[i] !== ':') return unsupported();
        i = skip(text, i + 1);
        const child = value(i, depth + 1);
        members.push({ key, keyStart, value: child });
        i = skip(text, child.end);
        if (text[i] === ',') i = skip(text, i + 1);
        else if (text[i] !== '}') return unsupported();
      }
      return { kind: 'object', start: from, end: i + 1, members, items: [] };
    }
    if (first === '[') {
      const items: Node[] = [];
      let i = skip(text, from + 1);
      while (text[i] !== ']') {
        const child = value(i, depth + 1);
        items.push(child);
        i = skip(text, child.end);
        if (text[i] === ',') i = skip(text, i + 1);
        else if (text[i] !== ']') return unsupported();
      }
      return { kind: 'array', start: from, end: i + 1, members: [], items };
    }
    let end = from;
    if (first === '"') end = endOfString(text, from);
    else while (end < text.length && !WS.has(text[end]!) && !',]}'.includes(text[end]!)) end += 1;
    return { kind: 'scalar', start: from, end, members: [], items: [] };
  };
  const start = skip(text, 0);
  return value(start, 1);
}

/** The member the parser would see for `key`: the last one, when a key is repeated. */
const effective = (node: Node, key: string): Member | undefined =>
  node.kind === 'object' ? node.members.findLast((member) => member.key === key) : undefined;

/** How the file's text is laid out, for the parts of the plan that depend on repeated keys (see settings.ts). Throws `unsupported_layout`. */
export function layoutOf(text: string): Layout {
  const body = text.startsWith('\ufeff') ? text.slice(1) : text;
  const root = parseTree(body);
  const count = (node: Node, key: string): number =>
    node.members.filter((member) => member.key === key).length;
  const hooks = effective(root, 'hooks');
  const shadowedEvents = new Set<string>();
  const dirtyGroups = new Set<string>();
  if (hooks !== undefined && hooks.value.kind === 'object') {
    for (const event of new Set(hooks.value.members.map((member) => member.key))) {
      if (count(hooks.value, event) > 1) shadowedEvents.add(event);
      const list = effective(hooks.value, event)?.value;
      if (list === undefined || list.kind !== 'array') continue;
      list.items.forEach((group, index) => {
        if (
          group.kind === 'object' &&
          group.members.length !== new Set(group.members.map((m) => m.key)).size
        )
          dirtyGroups.add(`${event}:${index}`);
      });
    }
  }
  return { hooksShadowed: count(root, 'hooks') > 1, shadowedEvents, dirtyGroups };
}

/** The whitespace before `at` on its line, when nothing else is before it on that line; else null. */
function lineIndent(text: string, at: number): string | null {
  let i = at;
  while (i > 0 && (text[i - 1] === ' ' || text[i - 1] === '\t')) i -= 1;
  return i === 0 || text[i - 1] === '\n' ? text.slice(i, at) : null;
}

/** The leading whitespace of the line `at` is on, whatever else is on it. */
function indentOfLine(text: string, at: number): string {
  let begin = at;
  while (begin > 0 && text[begin - 1] !== '\n') begin -= 1;
  let end = begin;
  while (text[end] === ' ' || text[end] === '\t') end += 1;
  return text.slice(begin, end);
}

function styleOf(body: string): Style {
  const firstBreak = body.indexOf('\n');
  const nl = firstBreak > 0 && body[firstBreak - 1] === '\r' ? '\r\n' : '\n';
  const trimmed = body.trim();
  if (!trimmed.includes('\n') && trimmed.length > 2) return { nl, unit: null };
  const lead = body.match(/\n([ \t]+)\S/);
  return { nl, unit: lead?.[1] ?? '  ' };
}

/** `JSON.stringify` in the file's style, every line after the first starting at `indent`. */
function print(value: unknown, style: Style, indent: string): string {
  const text = JSON.stringify(value, null, style.unit ?? undefined);
  if (style.unit === null) return text;
  return text.split('\n').join(`${style.nl}${indent}`);
}

const cut = (text: string, start: number, end: number, insert = ''): string =>
  text.slice(0, start) + insert + text.slice(end);

/**
 * Cuts child `index` out of `node`: its text and one separator, so that what was there before the child was added is what is left.
 * The only child of a container laid out on lines of its own leaves `[]` (`{}`); any other only child leaves the container's own
 * whitespace.
 */
function removeChild(body: string, node: Node, index: number): string {
  const kids = childrenOf(node);
  const kid = kids[index]!;
  if (kids.length === 1) {
    const before = body.slice(node.start + 1, kid.from);
    const after = body.slice(kid.to, node.end - 1);
    return before.includes('\n') && after.includes('\n')
      ? cut(body, node.start + 1, node.end - 1)
      : cut(body, kid.from, kid.to);
  }
  const next = kids[index + 1];
  if (next !== undefined) return cut(body, kid.from, next.from);
  return cut(body, kids[index - 1]!.to, kid.to);
}

/** Adds `text` (a member or an item, already printed) after the last child of `node`, in the layout the children already have. */
function insertChild(body: string, node: Node, text: string, style: Style): string {
  const kids = childrenOf(node);
  const last = kids.at(-1);
  const base = indentOfLine(body, node.start);
  if (last === undefined) {
    const inner = body.slice(node.start + 1, node.end - 1);
    // Whitespace the owner left in an empty container stays where it is: the new child goes before it.
    if (inner !== '' || style.unit === null) return cut(body, node.start + 1, node.start + 1, text);
    return cut(
      body,
      node.start + 1,
      node.end - 1,
      `${style.nl}${base}${style.unit}${text}${style.nl}${base}`,
    );
  }
  const inline = !body.slice(node.start, node.end).includes('\n');
  if (inline || style.unit === null) {
    const second = kids[1];
    const spaced =
      style.unit === null && second === undefined
        ? false
        : second === undefined || /\s/.test(body.slice(kids[0]!.to, second.from));
    return cut(body, last.to, last.to, `${spaced ? ', ' : ','}${text}`);
  }
  const indent = lineIndent(body, kids[0]!.from) ?? base + style.unit;
  return cut(body, last.to, last.to, `,${style.nl}${indent}${text}`);
}

/** The indentation a child added to `node` would have (and so what its printed lines continue from), and whether it is printed compactly. */
function childLayout(body: string, node: Node, style: Style): { indent: string; style: Style } {
  const kids = childrenOf(node);
  const first = kids[0];
  const inline = !body.slice(node.start, node.end).includes('\n');
  const compact: Style = { nl: style.nl, unit: null };
  if (style.unit === null) return { indent: '', style: compact };
  if (first === undefined) {
    const inner = body.slice(node.start + 1, node.end - 1);
    return inner === ''
      ? { indent: indentOfLine(body, node.start) + style.unit, style }
      : { indent: '', style: compact };
  }
  if (inline) return { indent: '', style: compact };
  return {
    indent: lineIndent(body, first.from) ?? indentOfLine(body, node.start) + style.unit,
    style,
  };
}

const memberText = (key: string, value: string, style: Style): string =>
  `${JSON.stringify(key)}${style.unit === null ? ':' : ': '}${value}`;

/** Where in the tree: object members by key (the last of a repeated key), list items by index. */
type Path = (string | number)[];

function resolve(root: Node, path: Path): Node | undefined {
  let at: Node | undefined = root;
  for (const step of path) {
    if (at === undefined) return undefined;
    at = typeof step === 'string' ? effective(at, step)?.value : at.items[step];
  }
  return at;
}

/** `member` of `parent`'s effective one: where it is in `parent.members`. */
const indexOfEffective = (parent: Node, key: string): number =>
  parent.members.findLastIndex((member) => member.key === key);

/**
 * `text` (a settings file, BOM included) with `plan` written into it, or null when this could not be done to the text as it is (the
 * caller then refuses the file: HQ never prints a whole file). `before` is the parsed settings the plan was computed from.
 */
export function spliceSettings(text: string, before: Json, plan: EntryPlan): string | null {
  try {
    const bom = text.startsWith('\ufeff') ? '\ufeff' : '';
    let body = text.slice(bom.length);
    // The plan must have been computed from this very text.
    if (!isDeepStrictEqual(JSON.parse(body), before)) return null;
    const style = styleOf(body);
    // The text is re-read after every edit, so no position is ever stale.
    const edit = (change: (root: Node) => string): void => {
      body = change(parseTree(body));
    };
    const hooksPath: Path = ['hooks'];

    if (plan.createHooks) {
      edit((root) => {
        const layout = childLayout(body, root, style);
        const section: Json = {};
        for (const { event, groups } of plan.events)
          if (groups !== null) section[event] = groups.map((group) => group.value);
        const value = print(section, layout.style, layout.indent);
        return insertChild(body, root, memberText('hooks', value, style), style);
      });
    } else {
      // Each event: take HQ's handlers out of the groups they were in, cut out the groups the plan dropped, add the groups it adds,
      // and cut out the event when the plan removes it.
      for (const { event, groups } of plan.events) {
        const path: Path = [...hooksPath, event];
        const kept: PlannedGroup[] = groups ?? [];
        const existing = resolve(parseTree(body), path);
        if (existing !== undefined) {
          if (existing.kind !== 'array') return null;
          const keptSrc = new Set(kept.flatMap((group) => (group.src === null ? [] : [group.src])));
          // Handlers first (the groups keep their places), then whole groups from the end, so every index is still the file's own.
          for (const group of kept) {
            if (group.src === null) continue;
            for (const handler of [...group.removed].sort((a, b) => b - a)) {
              const list = resolve(parseTree(body), [...path, group.src, 'hooks']);
              if (list === undefined || list.kind !== 'array') return null;
              body = removeChild(body, list, handler);
            }
          }
          for (let src = existing.items.length - 1; src >= 0; src -= 1) {
            if (keptSrc.has(src)) continue;
            const list = resolve(parseTree(body), path);
            if (list === undefined || list.kind !== 'array') return null;
            body = removeChild(body, list, src);
          }
        }
        for (const group of kept) {
          if (group.src !== null) continue;
          edit((root) => {
            const hooks = resolve(root, hooksPath);
            if (hooks === undefined || hooks.kind !== 'object') throw new Error('no hooks');
            const list = resolve(root, path);
            const layout = childLayout(body, list ?? hooks, style);
            if (list !== undefined)
              return insertChild(
                body,
                list,
                print(group.value, layout.style, layout.indent),
                style,
              );
            // The event has no list yet: it is made with this group in it.
            const value = print([group.value], layout.style, layout.indent);
            return insertChild(body, hooks, memberText(event, value, style), style);
          });
        }
        if (groups === null) {
          edit((root) => {
            const hooks = resolve(root, hooksPath);
            if (hooks === undefined || hooks.kind !== 'object') throw new Error('no hooks');
            const at = indexOfEffective(hooks, event);
            return at === -1 ? body : removeChild(body, hooks, at);
          });
        }
      }
    }
    if (plan.dropHooks) {
      edit((root) => {
        const at = indexOfEffective(root, 'hooks');
        return at === -1 ? body : removeChild(body, root, at);
      });
    }

    // The text must say exactly what the plan says.
    const parsed: unknown = JSON.parse(body);
    return isDeepStrictEqual(parsed, plan.next) ? bom + body : null;
  } catch {
    return null;
  }
}
