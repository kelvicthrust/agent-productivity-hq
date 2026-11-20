import { CLAUDE_HOOK_EVENTS } from '../../../shared/contracts/hq.ts';
import { isRecord } from '../claudeCapture/files.ts';
import { HOOK_TIMEOUT_SECONDS, parseHookCommand } from './command.ts';
import { ClaudeHooksError } from './errors.ts';

// What HQ's entries look like in a user-level settings file, and how they are added and removed. Pure: text in, text out.
//
//   "hooks": { "<Event>": [ { "hooks": [ { "type": "command", "command": "<HQ's command>", "timeout": 3 } ] } ] }
//
// Merge, never replace. Every other key, every other event and every handler that is not HQ's is kept as it is. This module only
// says WHAT changes (`planEntries`); splice.ts is the only writer and makes that change in the file's own text. A handler is HQ's
// only when its command is in exactly the shape command.ts writes. A file that cannot be understood is refused, never treated as empty.
//
// Repeated keys: the parsed value holds the LAST member of a key (the one Claude Code sees), so that is the one inspected and planned.

export type Json = Record<string, unknown>;
export type EntryState = 'absent' | 'present' | 'needs_repair';

/** A settings file larger than this is not a settings file Claude Code wrote; it is refused rather than read. */
export const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;

const BOM = '﻿';

/** The deepest nesting HQ reads (splice.ts holds the same bound). */
const MAX_DEPTH = 64;

/** How deep the arrays and objects of `text` nest, outside strings. Iterative, so a hostile file cannot exhaust the stack. */
function depthOf(text: string): number {
  let depth = 0;
  let deepest = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (inString) {
      if (char === '\\') i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{' || char === '[') {
      depth += 1;
      if (depth > deepest) deepest = depth;
    } else if (char === '}' || char === ']') depth -= 1;
  }
  return deepest;
}

/**
 * The parsed file, or the fixed reason it cannot be changed. `null` text is a file that does not exist yet. A number that does not
 * fit a double (`1e999`) or a `-0` is read as `JSON.parse` reads it: the text is never printed back from this value, so nothing about
 * it is lost.
 */
export function parseSettings(text: string | null): Json {
  if (text === null) return {};
  if (Buffer.byteLength(text, 'utf8') > MAX_SETTINGS_BYTES)
    throw new ClaudeHooksError('unreadable');
  const body = text.startsWith(BOM) ? text.slice(1) : text;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new ClaudeHooksError('not_json');
  }
  if (!isRecord(value)) throw new ClaudeHooksError('not_an_object');
  if (depthOf(body) > MAX_DEPTH) throw new ClaudeHooksError('unsupported_layout');
  return value;
}

/**
 * Whether the settings reader (the one every read of a settings file goes through: the size cap in bytes, strict UTF-8 text, valid
 * JSON, an object, the depth bound) accepts `text`, which a change is about to write. HQ never writes a file it could not read back.
 */
export function assertReadableByHq(text: string): void {
  try {
    parseSettings(text);
  } catch {
    throw new ClaudeHooksError('unsupported_layout');
  }
}

/**
 * What the file's text looks like where it matters to the plan (read from the text by splice.ts: the parsed value cannot tell). Where a
 * key is repeated, the member the parser keeps is the last; cutting it out would bring an earlier one back, so the plan leaves an
 * empty `{}` or `[]` in its place instead of removing it.
 */
export interface Layout {
  /** An earlier `hooks` member exists beside the effective one. */
  hooksShadowed: boolean;
  /** Events (of the effective `hooks`) that have an earlier member of the same key. */
  shadowedEvents: ReadonlySet<string>;
  /** `<event>:<index>` of groups whose text repeats a key: dead text in them is the owner's, so the group is never cut out whole. */
  dirtyGroups: ReadonlySet<string>;
}
export const PLAIN_LAYOUT: Layout = {
  hooksShadowed: false,
  shadowedEvents: new Set(),
  dirtyGroups: new Set(),
};

const eventsOf = (value: Json): Json | null => {
  const hooks = value['hooks'];
  if (hooks === undefined) return null;
  if (!isRecord(hooks)) throw new ClaudeHooksError('unsupported_shape');
  return hooks;
};

/** The groups of one event of ours. A value that is not a list cannot be merged into, so the file is refused. */
function groupsOf(hooks: Json | null, event: string): unknown[] | null {
  const groups = hooks?.[event];
  if (groups === undefined) return null;
  if (!Array.isArray(groups)) throw new ClaudeHooksError('unsupported_shape');
  return groups;
}

/** A handler is HQ's when its command is exactly HQ's shape, whatever else it says (a changed `type` or timeout still makes it HQ's, to be repaired). */
export type ScriptScope = (script: string) => boolean;

const isHqHandler = (handler: unknown, scope?: ScriptScope): handler is Json => {
  if (!isRecord(handler)) return false;
  const parsed = parseHookCommand(handler['command']);
  return parsed !== null && (scope === undefined || scope(parsed.script));
};

/**
 * A matcher that filters nothing. The documentation (code.claude.com/docs/en/hooks) lists three: `"*"`, `""` and no matcher at all.
 * Anything else, on any event, narrows when the handler runs, so a handler of HQ's inside such a group is not a complete install.
 */
const isMatchAll = (matcher: unknown): boolean =>
  matcher === undefined || matcher === '' || matcher === '*';

/** A group that holds nothing but `hooks` (and, at most, a match-all matcher): the shape HQ writes, and the only one it ever deletes. */
const isPlainGroup = (group: Json): boolean =>
  Object.keys(group).every(
    (key) => key === 'hooks' || (key === 'matcher' && isMatchAll(group[key])),
  );

interface Found {
  event: string;
  group: Json;
  handler: Json;
}

/** Every handler that is HQ's, anywhere under `hooks` (an event HQ no longer uses included), with the group it sits in. */
function* hqHandlers(hooks: Json | null, scope?: ScriptScope): Generator<Found> {
  if (hooks === null) return;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group['hooks'])) continue;
      for (const handler of group['hooks'] as unknown[])
        if (isHqHandler(handler, scope)) yield { event, group, handler };
    }
  }
}

const isExact = (handler: Json, command: string): boolean => {
  const keys = Object.keys(handler);
  return (
    keys.length === 3 &&
    handler['type'] === 'command' &&
    handler['command'] === command &&
    handler['timeout'] === HOOK_TIMEOUT_SECONDS
  );
};

/**
 * `absent` (no HQ handler anywhere) or `present`, else `needs_repair`. Present means that on each of HQ's events there is exactly one
 * HQ handler, exact (type, command, timeout and nothing else), alone in a group that filters nothing and has no other key; and that
 * HQ has no handler anywhere else. A handler of HQ's inside a group with a matcher, or beside the owner's own handlers, is not present:
 * its reach is not what HQ reports.
 */
export function inspect(value: Json, command: string, scope?: ScriptScope): EntryState {
  const hooks = eventsOf(value);
  for (const event of CLAUDE_HOOK_EVENTS) groupsOf(hooks, event);
  const found = [...hqHandlers(hooks, scope)];
  if (found.length === 0) return 'absent';
  const complete = CLAUDE_HOOK_EVENTS.every((event) => {
    const here = found.filter((entry) => entry.event === event);
    const [only] = here;
    return (
      here.length === 1 &&
      only !== undefined &&
      isExact(only.handler, command) &&
      isPlainGroup(only.group) &&
      (only.group['hooks'] as unknown[]).length === 1
    );
  });
  return complete && found.length === CLAUDE_HOOK_EVENTS.length ? 'present' : 'needs_repair';
}

/** One group of an event's list after a change: the index it had in the file's list (null for a new group), its value, and which of its handlers were taken out. */
export interface PlannedGroup {
  src: number | null;
  value: unknown;
  /** Indexes (in the group's own `hooks` list) of the HQ handlers taken out of it; always empty for a new group. */
  removed: number[];
}

export interface EntryPlan {
  /** The whole settings value after the change. */
  next: Json;
  /** The events whose list of groups changed, in the order they are written; `groups: null` removes the event's key. */
  events: { event: string; groups: PlannedGroup[] | null }[];
  /** The `hooks` section did not exist and now does. */
  createHooks: boolean;
  /** The `hooks` section held only what HQ's removal took out, and goes. */
  dropHooks: boolean;
}

/** On `event`, exactly one HQ handler, exact, alone in a group that filters nothing: what a complete install leaves there. */
function eventIsComplete(hooks: Json | null, event: string, command: string): boolean {
  const here = [...hqHandlers(hooks)].filter((entry) => entry.event === event);
  const [only] = here;
  return (
    here.length === 1 &&
    only !== undefined &&
    isExact(only.handler, command) &&
    isPlainGroup(only.group) &&
    (only.group['hooks'] as unknown[]).length === 1
  );
}

/**
 * What to do to the settings so HQ's entries are (enabled) or are not (disabled) there. HQ's removal takes out HQ's handler OBJECTS only:
 * the owner's other handlers, their matchers and every key of a group stay. A group is deleted only when it is the shape HQ writes
 * (see `isPlainGroup`, and no repeated key in its text) and the removal left it empty; an event key only when that left its list
 * empty and no earlier member of that key exists; `hooks` only when that left it empty and no earlier `hooks` member exists. A group
 * of the owner's that the removal left with no handler (a matcher, or another key, is the sign) stays as `"hooks": []`: the
 * documentation defines a group's `hooks` as a list of handlers and does not forbid an empty one, which runs nothing. Turning on
 * leaves an event alone when it already holds exactly HQ's one entry, and otherwise takes out every HQ handler there and adds one
 * group, so there is never a second. `value` is not touched.
 */
export function planEntries(
  value: Json,
  command: string,
  enabled: boolean,
  layout: Layout = PLAIN_LAYOUT,
  scope?: ScriptScope,
): EntryPlan {
  const next = structuredClone(value);
  const hooks = eventsOf(next);
  const original = eventsOf(value);
  for (const event of CLAUDE_HOOK_EVENTS) groupsOf(hooks, event);
  const settled = (event: string): boolean =>
    enabled &&
    (CLAUDE_HOOK_EVENTS as readonly string[]).includes(event) &&
    eventIsComplete(original, event, command);
  const lists = new Map<string, PlannedGroup[]>();
  if (hooks !== null) {
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups) || settled(event)) continue;
      const kept: PlannedGroup[] = [];
      let removedAny = false;
      groups.forEach((group: unknown, src) => {
        if (!isRecord(group) || !Array.isArray(group['hooks'])) {
          kept.push({ src, value: group, removed: [] });
          return;
        }
        const handlers = group['hooks'] as unknown[];
        const removed: number[] = [];
        handlers.forEach((handler, index) => {
          if (isHqHandler(handler, scope)) removed.push(index);
        });
        if (removed.length === 0) {
          kept.push({ src, value: group, removed: [] });
          return;
        }
        removedAny = true;
        group['hooks'] = handlers.filter((handler) => !isHqHandler(handler, scope));
        const rest = group['hooks'] as unknown[];
        if (rest.length === 0 && isPlainGroup(group) && !layout.dirtyGroups.has(`${event}:${src}`))
          return;
        kept.push({ src, value: group, removed });
      });
      if (removedAny) lists.set(event, kept);
    }
  }
  if (enabled) {
    for (const event of CLAUDE_HOOK_EVENTS) {
      if (settled(event)) continue;
      const existing = hooks?.[event];
      const list =
        lists.get(event) ??
        (Array.isArray(existing)
          ? existing.map((group: unknown, src: number) => ({ src, value: group, removed: [] }))
          : []);
      list.push({
        src: null,
        value: { hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }] },
        removed: [],
      });
      lists.set(event, list);
    }
  }
  const hadHooks = hooks !== null;
  const section: Json = hooks ?? {};
  for (const [event, list] of lists) {
    if (list.length > 0) section[event] = list.map((group) => group.value);
    else if (layout.shadowedEvents.has(event)) section[event] = [];
    else delete section[event];
  }
  const dropHooks =
    hadHooks && lists.size > 0 && Object.keys(section).length === 0 && !layout.hooksShadowed;
  const createHooks = !hadHooks && lists.size > 0;
  if (dropHooks) delete next['hooks'];
  else if (createHooks) next['hooks'] = section;
  return {
    next,
    events: [...lists].map(([event, list]) => ({
      event,
      groups: list.length === 0 && !layout.shadowedEvents.has(event) ? null : list,
    })),
    createHooks,
    dropHooks,
  };
}

/** The settings with HQ's entries (and no other change) for `enabled`, or with none of them. Returns a new value; `value` is not touched. */
export const applyEntries = (value: Json, command: string, enabled: boolean): Json =>
  planEntries(value, command, enabled).next;
