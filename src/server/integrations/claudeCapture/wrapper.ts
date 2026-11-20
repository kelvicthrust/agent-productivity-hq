// The command Claude Code runs as the user-level status line (data-and-sources › Wrapper command):
//
//   : kelvin-agent-crew-hook; if [ -x "<node>" ] && [ -f "<data>/claude-statusline.mjs" ]; then "<node>" "<script>"; else <previous or true>; fi
//
// The leading no-op is how the dashboard recognises its own wrapper later, even after its data folder is gone. The `else`
// branch keeps the owner's own status line working when Node or the script disappears; the shell hands it Claude Code's stdin
// untouched, because the two tests before it read nothing.

// Keep the original marker to recognize retired hooks in existing Claude Code settings.
export const WRAPPER_MARKER = ': kelvin-agent-crew-hook;';

/**
 * A path as one shell word. Double quotes when nothing in the path is special inside them (the macOS data folder has a space and
 * nothing else), so the common case reads as the contract shows it; single quotes otherwise, which is always safe.
 */
export function shellQuote(path: string): string {
  return /^[^"\\$`!\n']*$/.test(path) ? `"${path}"` : `'${path.replaceAll("'", `'\\''`)}'`;
}

export interface WrapperInput {
  /** The Node that runs the dashboard, absolute: Claude Code's shell may not have `node` on its PATH. */
  node: string;
  script: string;
  /** The owner's own status line, or null when there is none (the `else` branch is then `true`). */
  previousCommand: string | null;
}

export function buildWrapper({ node, script, previousCommand }: WrapperInput): string {
  const fallback = previousCommand === null ? 'true' : previousCommand.trimEnd();
  // A trailing `# comment` or a command that spans lines would swallow a `; fi` on the same line, so `fi` goes on its own line.
  const end = /[#\n]/.test(fallback) ? '\nfi' : '; fi';
  const q = { node: shellQuote(node), script: shellQuote(script) };
  return (
    `${WRAPPER_MARKER} if [ -x ${q.node} ] && [ -f ${q.script} ]; ` +
    `then ${q.node} ${q.script}; else ${fallback}${end}`
  );
}

/** True for any command this module wrote, whichever Node or data folder it names. */
export const isWrapper = (command: string): boolean =>
  command.trimStart().startsWith(WRAPPER_MARKER);

// One quoted word as `shellQuote` writes it: "…" or '…' where an inner quote is the four characters '\''.
const WORD = String.raw`(?:"[^"]*"|'(?:[^']|'\\'')*')`;
const MARKER = WRAPPER_MARKER.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
const SHAPE = new RegExp(
  String.raw`^${MARKER} if \[ -x ${WORD} \] && \[ -f ${WORD} \]; then ${WORD} ${WORD}; else ([\s\S]*?)(?:; |\n)fi$`,
);

/**
 * The status line inside a wrapper's `else` branch: its text, or null when the branch is the plain `true` that stands for
 * "none". Undefined when the command is not in the shape `buildWrapper` writes (someone edited it by hand).
 */
export function previousCommandOf(wrapper: string): string | null | undefined {
  const found = wrapper.trim().match(SHAPE);
  if (found === null) return undefined;
  const text = found[1] ?? '';
  return text === 'true' ? null : text;
}
