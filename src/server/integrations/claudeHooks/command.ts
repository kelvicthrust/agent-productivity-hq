import { HOOK_SCRIPT } from './paths.ts';

// The command each Claude Code hook entry runs, and the one place that both writes it and recognises it:
//
//   : agent-productivity-hq-hook; if [ -x "<node>" ] && [ -f "<script>" ]; then "<node>" "<script>"; fi
//
// A command is described by two paths, `{ node, script }`. `buildHookCommand` renders that description; `parseHookCommand` reads a
// command back into it, and accepts a command ONLY when rendering what it read gives the very same text. So the two cannot disagree
// about a command they handle: whatever HQ writes, it recognises (and never writes a second one beside it), and a command someone
// edited by hand is not HQ's and is left alone.
//
// The leading no-op is how HQ recognises its own entries later, even after its data folder moved. The `if` keeps Claude Code quiet
// when Node or the script has gone: the entry then does nothing and exits 0 (the shell hands the script Claude Code's stdin
// untouched, because the two tests read nothing).
//
// Supported paths. A path must be absolute (start with `/`), at most 1024 UTF-16 units, and made of characters HQ can quote for `sh`
// and read back: any character EXCEPT a control character (U+0000-U+001F, U+007F, U+0080-U+009F: a line break or NUL cannot be put in
// one shell word and read back by every tool that reads the file), a line or paragraph separator (U+2028, U+2029), or a lone
// surrogate. Spaces, quotes, `$`, backticks, backslashes, `!` and every other character, any alphabet and emoji are supported, and
// run correctly under a real `sh -c` (a test executes them). Any other path is refused before anything is written (`unsupported_path`).

export const HOOK_MARKER = ': agent-productivity-hq-hook;';
/** Seconds Claude Code waits for the command (its `timeout` is in seconds). The script gives up after about 1.5 s on its own. */
export const HOOK_TIMEOUT_SECONDS = 3;
/** The longest path HQ puts in a command (UTF-16 units). */
export const HOOK_PATH_MAX = 1024;
/** The longest command HQ recognises: two copies of each of two longest paths, quoted, and the fixed words around them. */
const COMMAND_MAX = 4 * HOOK_PATH_MAX * 4 + 256;

export interface HookCommand {
  node: string;
  script: string;
}

// eslint-disable-next-line no-control-regex
const UNSUPPORTED_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ud800-\udfff]/u;
// Characters inside double quotes that the shell would still act on (or that a reader would take for an escape): those paths are
// single-quoted instead.
const NEEDS_SINGLE_QUOTES = /["\\$`!']/;

/** True when HQ can put `path` in a command and read it back: an absolute path of supported characters. */
export function isSupportedPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > HOOK_PATH_MAX) return false;
  if (!path.startsWith('/')) return false;
  // `u` makes a lone surrogate match the class above (an astral character is one code point, not two surrogates).
  return !UNSUPPORTED_CHARACTER.test(path);
}

/** True when both paths of `command` are supported. */
export const isSupportedCommand = (command: HookCommand): boolean =>
  isSupportedPath(command.node) &&
  isSupportedPath(command.script) &&
  command.script.split('/').at(-1) === HOOK_SCRIPT;

/** One shell word for `path`: "…" when nothing in it is special to the shell, else '…' with each quote written as '\''. */
function quote(path: string): string {
  return NEEDS_SINGLE_QUOTES.test(path) ? `'${path.replaceAll("'", `'\\''`)}'` : `"${path}"`;
}

/** The command for `command`. Throws for a path `isSupportedPath` refuses: check first (nothing unsupported is ever written). */
export function renderHookCommand({ node, script }: HookCommand): string {
  if (!isSupportedPath(node) || !isSupportedPath(script))
    throw new Error('a path HQ cannot put in a command');
  const q = { node: quote(node), script: quote(script) };
  return `${HOOK_MARKER} if [ -x ${q.node} ] && [ -f ${q.script} ]; then ${q.node} ${q.script}; fi`;
}

export const buildHookCommand = (node: string, script: string): string =>
  renderHookCommand({ node, script });

/** A cursor over the command's text: reads fixed words and shell words, one after another. */
class Reader {
  private readonly text: string;
  private at = 0;

  constructor(text: string) {
    this.text = text;
  }

  literal(word: string): boolean {
    if (!this.text.startsWith(word, this.at)) return false;
    this.at += word.length;
    return true;
  }

  atEnd(): boolean {
    return this.at === this.text.length;
  }

  /** One word as `quote` writes it, or null. */
  word(): string | null {
    const first = this.text[this.at];
    if (first === '"') {
      const close = this.text.indexOf('"', this.at + 1);
      if (close === -1) return null;
      const value = this.text.slice(this.at + 1, close);
      this.at = close + 1;
      return value;
    }
    if (first !== "'") return null;
    let value = '';
    let i = this.at + 1;
    for (;;) {
      const close = this.text.indexOf("'", i);
      if (close === -1) return null;
      value += this.text.slice(i, close);
      // `'\''` ends the word's quote, writes one quote and opens the next.
      if (this.text.startsWith("\\''", close + 1)) {
        value += "'";
        i = close + 4;
        continue;
      }
      this.at = close + 1;
      return value;
    }
  }
}

/**
 * The Node and script a command of HQ's shape runs, or null when `command` is not exactly what `renderHookCommand` writes for them:
 * the text is read, then written again, and only an identical text is accepted.
 */
export function parseHookCommand(command: unknown): HookCommand | null {
  if (typeof command !== 'string' || command.length > COMMAND_MAX) return null;
  const reader = new Reader(command);
  if (!reader.literal(`${HOOK_MARKER} if [ -x `)) return null;
  const node = reader.word();
  if (node === null || !reader.literal(' ] && [ -f ')) return null;
  const script = reader.word();
  if (script === null || !reader.literal(' ]; then ')) return null;
  if (reader.word() === null || !reader.literal(' ') || reader.word() === null) return null;
  if (!reader.literal('; fi') || !reader.atEnd()) return null;
  const found = { node, script };
  if (!isSupportedCommand(found)) return null;
  return renderHookCommand(found) === command ? found : null;
}

export const isHookCommand = (command: unknown): boolean => parseHookCommand(command) !== null;
