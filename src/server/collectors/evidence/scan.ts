// Evidence extraction, the pure half (data-and-sources › Evidence extraction; TECH › Security and privacy, P-31).
//
// `scanLine` looks at ONE line of a transcript or rollout, as it was read (the raw JSON text, so a newline inside a tool result is
// the two characters `\n`), and returns only identifiers: PR references as lowercase `owner/name#number` and commit ids as lowercase
// hex. Nothing else in the line is kept. It never throws, never logs, and holds nothing between calls, so there is no line text
// for an error message or a log entry to carry. Branches are not scanned for: they come from the adapter's metadata
// (Claude `gitBranch`, Codex `git.branch`), and `collect.ts` takes them from there.
//
// Ported from `extractRefs` in scripts/experiments/e5-evidence.ts, with the number tightened to the shape the database accepts
// (`[1-9]\d{0,6}`): a URL ending in `/pull/007` yields no reference instead of one the store would refuse.

const OWNER = '[A-Za-z0-9][A-Za-z0-9-]{0,38}';
const NAME = '[A-Za-z0-9._-]{1,100}';
const NUMBER = '([1-9]\\d{0,6})(?!\\d)';

/** `https://github.com/{owner}/{name}/pull/{number}`. */
const PR_URL = new RegExp(
  `https:\\/\\/github\\.com\\/(${OWNER}\\/${NAME})\\/pull\\/${NUMBER}`,
  'g',
);
/** The REST form: `https://api.github.com/repos/{owner}/{name}/pulls/{number}`. */
const PR_API = new RegExp(
  `https:\\/\\/api\\.github\\.com\\/repos\\/(${OWNER}\\/${NAME})\\/pulls\\/${NUMBER}`,
  'g',
);
/** git's commit summary line: `[branch( extra)? sha7-40] subject`, e.g. `[main (root-commit) 1a2b3c4] …`. */
const COMMIT_SUMMARY =
  /\[(?:detached HEAD|[A-Za-z0-9._/-]{1,100})(?: \([^)\]]{1,30}\))? ([0-9a-f]{7,40})\]/g;
/** `git rev-parse HEAD` output: a whole 40-hex string inside a quoted tool result, ended by a quote or an escaped newline. */
const BARE_SHA = /(?:"|\\n)([0-9a-f]{40})(?:"|\\n)/g;

export interface LineRefs {
  /** `owner/name#number`, lowercase, each once. */
  prs: string[];
  /** Lowercase hex, 7 to 40 characters, each once. */
  commits: string[];
}

/**
 * The PR references and commit ids in one line of text. Everything else in the line is ignored, and a value that is not a string
 * (a field the adapter did not find) yields nothing.
 */
export function scanLine(text: unknown): LineRefs {
  if (typeof text !== 'string' || text.length < 7) return { prs: [], commits: [] };
  const prs = new Set<string>();
  const commits = new Set<string>();
  for (const pattern of [PR_URL, PR_API]) {
    for (const match of text.matchAll(pattern)) prs.add(`${match[1]!.toLowerCase()}#${match[2]!}`);
  }
  for (const match of text.matchAll(COMMIT_SUMMARY)) commits.add(match[1]!);
  for (const match of text.matchAll(BARE_SHA)) commits.add(match[1]!);
  return { prs: [...prs], commits: [...commits] };
}
