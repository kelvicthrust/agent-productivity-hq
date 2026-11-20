import { join, relative } from 'node:path';
import { defineExperiment, runIfMain, STANDARD_FLAGS } from './lib/cli.ts';
import { isIdentifier, safeText } from './lib/redact.ts';
import { FieldInventory } from './lib/shape.ts';
import type { ExperimentContext, Verdict } from './lib/types.ts';

// E1: does the Claude Code transcript on this machine have the shape the adapter assumes, and does the dedupe rule give
// the same totals as ccusage? Everything is parsed in memory. What leaves memory is a count, a field name, a token number
// or a time gap; never a line, a title, an id, a path or a token.

const CRITERIA = {
  fields: 'field-list-confirmed',
  reconcile: 'reconcile-three-sessions',
  parent: 'subagent-parent-mapping',
  title: 'title-presence-recorded',
  start: 'session-start-before-first-usage',
} as const;

/** What the normalization cannot work without, on every line that carries usage (TECH, Claude Code transcripts). */
const REQUIRED_FIELDS = [
  'type',
  'timestamp',
  'message.id',
  'message.model',
  'requestId',
  'message.usage.input_tokens',
  'message.usage.cache_creation_input_tokens',
  'message.usage.cache_read_input_tokens',
  'message.usage.output_tokens',
] as const;
/** Documented too, but only recorded: a line may legitimately lack them (no git branch, an older version). */
const RECORDED_FIELDS = ['sessionId', 'cwd', 'gitBranch', 'version', 'isSidechain'] as const;

const TRANSCRIPT_FILE = /\.jsonl(?:\.zst)?$|\.jsonl\.superseded-/;
/** TECH: set-aside copies are skipped, because reading them would double count (R3). */
const SET_ASIDE_FILE = /\.orphaned-[^/]*\.jsonl(?:\.zst)?$|\.jsonl\.superseded-/;
const TITLE_TYPE = /^(?:summary|title|(?:custom|ai)-title|session[-_]name)$/i;
const TITLE_KEYS = ['summary', 'title', 'customTitle', 'aiTitle', 'sessionName', 'session_name'];
/** A line type that is safe to use as a label in the findings; anything else is grouped as `other`. */
const LABEL_TYPE = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;

const MIN_SESSIONS = 3;
const MAX_INVENTORY_RECORDS_PER_TYPE = 300;

interface Usage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}
const CATEGORIES = ['input', 'cacheWrite', 'cacheRead', 'output'] as const;
const CATEGORY_LABEL: Record<(typeof CATEGORIES)[number] | 'total', string> = {
  input: 'input',
  cacheWrite: 'cache-write',
  cacheRead: 'cache-read',
  output: 'output',
  total: 'total',
};
const zero = (): Usage => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
const sum = (u: Usage): number => u.input + u.cacheWrite + u.cacheRead + u.output;
const plus = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  cacheRead: a.cacheRead + b.cacheRead,
  output: a.output + b.output,
});

/**
 * Which line of a message that was streamed over several lines counts. TECH proposes the last one and leaves "the exact
 * rule" to E1, so every candidate is tried and the findings say which reproduce the oracle. Real streamed output only
 * grows, so `last` and `highest-output` are the same on real data; they differ only when a later line has less.
 */
const RULES = ['last', 'highest-output', 'first'] as const;
type Rule = (typeof RULES)[number];
type Form = 'with-subagents' | 'own';
const FORMS: readonly Form[] = ['with-subagents', 'own'];

interface Located {
  path: string;
  kind: 'main' | 'subagent';
  /** The session this file belongs to, from where it lives (R3: parentage is recorded by location). */
  session: string;
  /** Where the parent's main transcript would be, for a subagent file. */
  parentPath: string | null;
  compressed: boolean;
}

interface FileScan {
  located: Located;
  state: 'ok' | 'unsupported' | 'unreadable';
  lines: number;
  unreadable: number;
  earliest: number | null;
  firstUsage: number | null;
  usageLines: number;
  /** Per dedupe key: the first and the last line seen in this file. */
  /** Per dedupe key: the first, last and highest-output line in this file, and the earliest time it was written. */
  entries: Map<string, { first: Usage; last: Usage; highest: Usage; at: number | null }>;
  /** Usage lines with no message id, which cannot be deduplicated. */
  keyless: Usage[];
  /** Lines keyed by message id alone because the request id is missing. */
  withoutRequestId: number;
  titleLines: number;
  sessionFieldSame: number;
  sessionFieldOther: number;
  sidechainLines: number;
}

interface Session {
  id: string;
  main: FileScan | null;
  subagents: FileScan[];
}

interface OracleEntry {
  id: string;
  usage: Usage;
  total: number;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Parses one line. Any failure is a count, never a message: a parse error can quote the line. */
function parseObject(raw: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

function timeOf(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function pathValue(record: Record<string, unknown>, path: string): unknown {
  let current: unknown = record;
  for (const part of path.split('.')) {
    const next = asRecord(current);
    if (!next) return undefined;
    current = next[part];
  }
  return current;
}

/** The earlier of two times, either of which may be missing. */
const earlier = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.min(a, b);

const seconds = (ms: number): number => Math.round(ms / 100) / 10;

/** `3` when every value is the same, else `3 to 8`. */
const spread = (values: number[]): string => {
  const low = Math.min(...values);
  const high = Math.max(...values);
  return low === high ? `${low}` : `${low} to ${high}`;
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Field paths with arrays written as `.item` and folded keys as `any`, so every path is identifier-shaped and can be a finding. */
const plainPath = (path: string): string => path.replaceAll('[]', '.item').replaceAll('*', 'any');

/** The shared state the line reader fills in as it goes. */
class Observations {
  readonly inventories = new Map<string, FieldInventory>();
  readonly inventoryCounts = new Map<string, number>();
  readonly requiredSeen = new Map<string, number>();
  readonly recordedSeen = new Map<string, number>();
  readonly titleTypes = new Set<string>();
  readonly titleKeys = new Set<string>();
  usageLines = 0;

  inventory(type: string, record: Record<string, unknown>): void {
    const name = LABEL_TYPE.test(type) ? type : 'other';
    const seen = this.inventoryCounts.get(name) ?? 0;
    if (seen >= MAX_INVENTORY_RECORDS_PER_TYPE) return;
    this.inventoryCounts.set(name, seen + 1);
    let inventory = this.inventories.get(name);
    if (!inventory) {
      inventory = new FieldInventory();
      this.inventories.set(name, inventory);
    }
    inventory.add(record);
  }

  fields(record: Record<string, unknown>, hasUsage: boolean): void {
    for (const field of RECORDED_FIELDS)
      if (pathValue(record, field) !== undefined)
        this.recordedSeen.set(field, (this.recordedSeen.get(field) ?? 0) + 1);
    if (!hasUsage) return;
    this.usageLines++;
    for (const field of REQUIRED_FIELDS) {
      const value = pathValue(record, field);
      const present = field.startsWith('message.usage.')
        ? typeof value === 'number'
        : value !== undefined && value !== null && value !== '';
      if (present) this.requiredSeen.set(field, (this.requiredSeen.get(field) ?? 0) + 1);
    }
  }
}

function ingest(scan: FileScan, record: Record<string, unknown>, seen: Observations): void {
  const at = timeOf(record['timestamp']);
  if (at !== null && (scan.earliest === null || at < scan.earliest)) scan.earliest = at;
  const type = typeof record['type'] === 'string' ? record['type'] : '';
  seen.inventory(type, record);

  const titleKey = TITLE_KEYS.find((key) => {
    const value = record[key];
    return typeof value === 'string' && value !== '';
  });
  if (TITLE_TYPE.test(type) || titleKey !== undefined) {
    scan.titleLines++;
    if (TITLE_TYPE.test(type)) seen.titleTypes.add(type);
    if (titleKey !== undefined) seen.titleKeys.add(titleKey);
  }

  if (typeof record['sessionId'] === 'string') {
    if (record['sessionId'] === scan.located.session) scan.sessionFieldSame++;
    else scan.sessionFieldOther++;
  }
  if (record['isSidechain'] === true) scan.sidechainLines++;

  const message = asRecord(record['message']);
  const usage = message ? asRecord(message['usage']) : null;
  seen.fields(record, usage !== null);
  if (!message || !usage) return;

  scan.usageLines++;
  if (at !== null && (scan.firstUsage === null || at < scan.firstUsage)) scan.firstUsage = at;
  const entry: Usage = {
    input: count(usage['input_tokens']),
    cacheWrite: count(usage['cache_creation_input_tokens']),
    cacheRead: count(usage['cache_read_input_tokens']),
    output: count(usage['output_tokens']),
  };
  // TECH: dedupeKey = message.id + ':' + requestId. A line with no request id is keyed by the message id alone
  // (what ccusage 20.0.48 does too); a line with no message id cannot be deduplicated and counts as it stands.
  const id = message['id'];
  if (typeof id === 'string' && id !== '') {
    if (typeof record['requestId'] !== 'string' || record['requestId'] === '')
      scan.withoutRequestId++;
    const key = `${id}:${typeof record['requestId'] === 'string' ? record['requestId'] : ''}`;
    const before = scan.entries.get(key);
    scan.entries.set(key, {
      first: before?.first ?? entry,
      last: entry,
      highest: before && before.highest.output > entry.output ? before.highest : entry,
      at: earlier(before?.at ?? null, at),
    });
  } else {
    scan.keyless.push(entry);
  }
}

function scanFile(ctx: ExperimentContext, located: Located, seen: Observations): FileScan {
  const scan: FileScan = {
    located,
    state: 'ok',
    lines: 0,
    unreadable: 0,
    earliest: null,
    firstUsage: null,
    usageLines: 0,
    entries: new Map(),
    keyless: [],
    withoutRequestId: 0,
    titleLines: 0,
    sessionFieldSame: 0,
    sessionFieldOther: 0,
    sidechainLines: 0,
  };
  if (located.compressed && !ctx.fs.zstdAvailable()) {
    scan.state = 'unsupported';
    return scan;
  }
  try {
    for (const raw of ctx.fs.lines(located.path)) {
      scan.lines++;
      const record = parseObject(raw);
      if (record) ingest(scan, record, seen);
      else scan.unreadable++;
    }
  } catch {
    scan.state = 'unreadable';
  }
  return scan;
}

function locate(root: string, path: string): Located | 'set-aside' | 'other' {
  const parts = relative(root, path).split('/');
  const name = parts.at(-1) ?? '';
  if (SET_ASIDE_FILE.test(name)) return 'set-aside';
  const compressed = name.endsWith('.zst');
  const base = name.replace(/\.jsonl(?:\.zst)?$/, '');
  const project = parts[0] ?? '';
  if (parts.length === 2)
    return { path, kind: 'main', session: base, parentPath: null, compressed };
  if (parts.length === 4 && parts[2] === 'subagents' && parts[1])
    return {
      path,
      kind: 'subagent',
      session: parts[1],
      parentPath: join(root, project, `${parts[1]}.jsonl`),
      compressed,
    };
  return 'other';
}

/** Folders to read: --claude-root (repeatable), else $CLAUDE_CONFIG_DIR entries, else both default homes. */
function transcriptRoots(ctx: ExperimentContext): string[] {
  const flagged = ctx.args.all('claude-root');
  if (flagged.some((value) => value === 'true')) throw new Error('--claude-root needs a folder.');
  if (flagged.length > 0) return flagged;
  const configured = ctx.env['CLAUDE_CONFIG_DIR'];
  if (configured)
    return configured
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
      .map((entry) => join(entry, 'projects'));
  return [join(ctx.home, '.config/claude/projects'), join(ctx.home, '.claude/projects')];
}

function checkFlags(ctx: ExperimentContext): void {
  const known = new Set<string>([...STANDARD_FLAGS, 'claude-root', 'oracle']);
  const unknown = ctx.args.names().find((name) => !known.has(name));
  if (unknown !== undefined)
    throw new Error(`Unknown flag --${isIdentifier(unknown) ? unknown : 'name'}. See --help.`);
  if (ctx.args.get('oracle') === 'true') throw new Error('--oracle needs the path of a file.');
}

/** The sessions in a `ccusage ... session --json` result: the Claude report, or the unified one (`session`, `period`). */
function oracleEntries(json: unknown): OracleEntry[] {
  const top = asRecord(json);
  const list = Array.isArray(json)
    ? json
    : top && Array.isArray(top['sessions'])
      ? top['sessions']
      : top && Array.isArray(top['session'])
        ? top['session']
        : [];
  const out: OracleEntry[] = [];
  for (const item of list) {
    const record = asRecord(item);
    if (!record) continue;
    if (typeof record['agent'] === 'string' && record['agent'] !== 'claude') continue;
    const id = [record['sessionId'], record['period'], record['id']].find(
      (value): value is string => typeof value === 'string' && value !== '',
    );
    if (id === undefined || typeof record['inputTokens'] !== 'number') continue;
    const usage: Usage = {
      input: count(record['inputTokens']),
      cacheWrite: count(record['cacheCreationTokens']),
      cacheRead: count(record['cacheReadTokens']),
      output: count(record['outputTokens']),
    };
    out.push({
      id,
      usage,
      total: typeof record['totalTokens'] === 'number' ? record['totalTokens'] : sum(usage),
    });
  }
  return out;
}

type OracleResult =
  | { state: 'ok'; entries: OracleEntry[]; source: 'file' | 'ccusage' }
  | { state: 'none'; reason: string };

/** The oracle: the file given with --oracle, else ccusage if it is on PATH (never npx), else nothing to compare with. */
async function loadOracle(ctx: ExperimentContext): Promise<OracleResult> {
  const given = ctx.args.get('oracle');
  let text: string;
  let source: 'file' | 'ccusage';
  if (given !== undefined) {
    source = 'file';
    try {
      text = ctx.fs.readText(ctx.willRead('ccusage oracle file', given), { maxBytes: 64 << 20 });
    } catch {
      return { state: 'none', reason: 'the --oracle file could not be read' };
    }
  } else {
    source = 'ccusage';
    const version = await ctx.spawn('ccusage', ['--version'], { timeoutMs: 30_000 });
    if (!version.found)
      return { state: 'none', reason: 'ccusage is not on PATH and no --oracle file was given' };
    const number = version.stdout.match(/\b\d+\.\d+\.\d+[\w.+-]*/)?.[0];
    if (number) ctx.findings.tool('ccusage', number);
    const run = await ctx.spawn('ccusage', ['claude', 'session', '--json', '--offline'], {
      timeoutMs: 180_000,
      maxOutputBytes: 64 << 20,
    });
    if (!run.found || run.timedOut || run.status !== 0)
      return { state: 'none', reason: 'ccusage did not finish a session report' };
    text = run.stdout;
  }
  try {
    const entries = oracleEntries(JSON.parse(text));
    return entries.length > 0
      ? { state: 'ok', entries, source }
      : { state: 'none', reason: 'the ccusage output lists no sessions' };
  } catch {
    return { state: 'none', reason: 'the ccusage output is not JSON' };
  }
}

interface Verdicted {
  verdict: Verdict;
  detail: string;
}

interface Difference {
  ordinal: number;
  diffs: { label: string; by: number }[];
}

export const experiment = defineExperiment({
  meta: {
    id: 'E1',
    script: 'scripts/experiments/e1-claude.ts',
    title: 'Claude Code transcript shape and ccusage totals',
    question:
      "What is the Claude Code transcript shape on the installed version, and does the message id + request id dedupe rule reproduce ccusage's session totals?",
    criteria: [
      {
        id: CRITERIA.fields,
        text: 'Field list confirmed: the type, timestamp, message id, model, request id and the four usage fields are present on lines that carry usage.',
      },
      {
        id: CRITERIA.reconcile,
        text: 'The `message.id` + `requestId` dedupe rule reproduces `ccusage claude session --json` totals for 3 sessions to within 0 tokens.',
      },
      { id: CRITERIA.parent, text: 'Subagent files map to their parent.' },
      { id: CRITERIA.title, text: 'Title presence recorded.' },
      {
        id: CRITERIA.start,
        text: "The earliest line's `timestamp` is present on the main transcript and on a subagent file, and is at or before the first usage event; the gap between the two is recorded.",
      },
    ],
    reads: [
      'Claude Code transcripts: every `*.jsonl` and `*.jsonl.zst` below `projects/`, in each folder given with `--claude-root`, else in each comma-separated entry of `$CLAUDE_CONFIG_DIR` (its `projects/` folder), else in `~/.config/claude/projects` and `~/.claude/projects`. Only those folders are opened (never settings or credentials). Lines are parsed in memory and never printed.',
      'ccusage oracle file: the file given with `--oracle` (the output of `ccusage claude session --json --offline`), when you give one.',
    ],
    prints: [
      'The folders it will read, counts of sessions, subagent files, lines and unreadable lines, whether a zstd decoder is present, and one verdict line per criterion. Never a line, title, id, path or token.',
    ],
    writes: [
      'docs/implementation/experiments/E1.md (the findings: field names, counts, token differences and time gaps only)',
    ],
    network: [],
    spawns: ['ccusage'],
    example:
      'node scripts/experiments/e1-claude.ts --oracle <file from ccusage claude session --json --offline>',
    selftest: [
      {
        name: 'three sessions reconcile with the oracle and every criterion passes',
        args: [
          '--claude-root',
          '{fixtures}/claude/projects',
          '--oracle',
          '{fixtures}/claude/oracle.json',
        ],
        expect: {
          exit: 0,
          verdicts: {
            [CRITERIA.fields]: 'pass',
            [CRITERIA.reconcile]: 'pass',
            [CRITERIA.parent]: 'pass',
            [CRITERIA.title]: 'pass',
            [CRITERIA.start]: 'pass',
          },
          stdoutIncludes: ['Will read: Claude Code transcripts', 'Unreadable lines: 0'],
        },
      },
      {
        name: 'a one-token difference from the oracle fails the reconciliation',
        args: [
          '--claude-root',
          '{fixtures}/claude/projects',
          '--oracle',
          '{fixtures}/claude/oracle-one-token-off.json',
        ],
        expect: {
          exit: 1,
          verdicts: {
            [CRITERIA.fields]: 'pass',
            [CRITERIA.reconcile]: 'fail',
            [CRITERIA.parent]: 'pass',
            [CRITERIA.title]: 'pass',
            [CRITERIA.start]: 'pass',
          },
          stdoutIncludes: ['output +1'],
        },
      },
      {
        name: 'a subagent file whose parent transcript is missing fails the mapping',
        args: [
          '--claude-root',
          '{fixtures}/claude/projects',
          '--claude-root',
          '{fixtures}/claude/projects-orphan',
          '--oracle',
          '{fixtures}/claude/oracle.json',
        ],
        expect: {
          exit: 1,
          verdicts: {
            [CRITERIA.fields]: 'pass',
            [CRITERIA.reconcile]: 'pass',
            [CRITERIA.parent]: 'fail',
            [CRITERIA.title]: 'pass',
            [CRITERIA.start]: 'pass',
          },
        },
      },
      {
        name: 'no oracle file and no ccusage: the reconciliation is not run',
        args: [
          '--claude-root',
          '{fixtures}/claude/projects',
          '--bin',
          'ccusage={fixtures}/claude/no-ccusage-here',
        ],
        expect: {
          exit: 0,
          verdicts: {
            [CRITERIA.fields]: 'pass',
            [CRITERIA.reconcile]: 'not-run',
            [CRITERIA.parent]: 'pass',
            [CRITERIA.title]: 'pass',
            [CRITERIA.start]: 'pass',
          },
          stdoutIncludes: ['Will start: ccusage', 'ccusage is not on PATH'],
        },
      },
      {
        name: 'ccusage on PATH is started when there is no oracle file',
        args: [
          '--claude-root',
          '{fixtures}/claude/projects',
          '--bin',
          'ccusage={fixtures}/claude/fake-ccusage.ts',
        ],
        expect: {
          exit: 0,
          verdicts: {
            [CRITERIA.fields]: 'pass',
            [CRITERIA.reconcile]: 'pass',
            [CRITERIA.parent]: 'pass',
            [CRITERIA.title]: 'pass',
            [CRITERIA.start]: 'pass',
          },
          stdoutIncludes: ['Will start: ccusage claude session --json --offline'],
        },
      },
      {
        name: 'unreadable lines are counted and never shown',
        args: [
          '--claude-root',
          '{fixtures}/claude/projects-corrupt',
          '--bin',
          'ccusage={fixtures}/claude/no-ccusage-here',
        ],
        expect: {
          exit: 0,
          verdicts: {
            [CRITERIA.fields]: 'pass',
            [CRITERIA.reconcile]: 'not-run',
            [CRITERIA.parent]: 'not-run',
            [CRITERIA.title]: 'pass',
            [CRITERIA.start]: 'not-run',
          },
          stdoutIncludes: ['Unreadable lines: 2'],
        },
      },
      {
        name: 'no zstd decoder is reported, and the other criteria still run',
        args: [
          '--claude-root',
          '{fixtures}/claude/projects',
          '--oracle',
          '{fixtures}/claude/oracle.json',
        ],
        env: { EXPERIMENTS_FORCE_NO_ZSTD: '1' },
        expect: {
          exit: 0,
          verdicts: {
            [CRITERIA.fields]: 'pass',
            [CRITERIA.reconcile]: 'pass',
            [CRITERIA.parent]: 'pass',
            [CRITERIA.title]: 'pass',
            [CRITERIA.start]: 'pass',
          },
          stdoutIncludes: ['Zstandard decoder: not available'],
        },
      },
      {
        name: 'no transcripts in the folder: nothing can be judged',
        args: [
          '--claude-root',
          '{fixtures}/claude/no-such-projects-folder',
          '--bin',
          'ccusage={fixtures}/claude/no-ccusage-here',
        ],
        expect: {
          exit: 0,
          verdicts: {
            [CRITERIA.fields]: 'not-run',
            [CRITERIA.reconcile]: 'not-run',
            [CRITERIA.parent]: 'not-run',
            [CRITERIA.title]: 'not-run',
            [CRITERIA.start]: 'not-run',
          },
          stdoutIncludes: ['Transcript files found: 0'],
        },
      },
    ],
  },

  async run(ctx) {
    checkFlags(ctx);
    const say = (text: string) => ctx.out.line(text);
    const decoder = ctx.fs.zstdAvailable();
    ctx.findings.fact('Environment', 'zstd decoder present', decoder);
    say(`Zstandard decoder: ${decoder ? 'present' : 'not available'}`);

    // 1. Find and read the transcripts.
    const roots = transcriptRoots(ctx).map((root) => ctx.willRead('Claude Code transcripts', root));
    const seen = new Observations();
    const scans: FileScan[] = [];
    const taken = new Set<string>();
    let rootsFound = 0;
    let setAside = 0;
    let other = 0;
    let duplicates = 0;
    let truncated = false;
    for (const root of roots) {
      if (!ctx.fs.exists(root)) continue;
      rootsFound++;
      const walked = ctx.fs.walk(root, { match: TRANSCRIPT_FILE, maxDepth: 6 });
      truncated ||= walked.truncated;
      for (const path of walked.files) {
        const located = locate(root, path);
        if (located === 'set-aside') setAside++;
        else if (located === 'other') other++;
        else {
          // The same transcript can be reachable from two roots (a symlinked config folder): read it once.
          const identity = `${located.kind}:${located.session}:${path.split('/').at(-1)}`;
          if (taken.has(identity)) duplicates++;
          else {
            taken.add(identity);
            scans.push(scanFile(ctx, located, seen));
          }
        }
      }
    }
    const mains = scans.filter((s) => s.located.kind === 'main');
    const subagents = scans.filter((s) => s.located.kind === 'subagent');
    const lines = scans.reduce((n, s) => n + s.lines, 0);
    const unreadable = scans.reduce((n, s) => n + s.unreadable, 0);
    const unsupported = scans.filter((s) => s.state === 'unsupported').length;
    const failedFiles = scans.filter((s) => s.state === 'unreadable').length;

    say(`Transcript folders: ${roots.length} checked, ${rootsFound} found`);
    say(`Transcript files found: ${scans.length}`);
    say(
      `Main transcripts: ${mains.length}; subagent files: ${subagents.length}; set-aside copies skipped: ${setAside}`,
    );
    say(`Lines read: ${lines}`);
    say(`Unreadable lines: ${unreadable} (counted, never shown)`);

    ctx.findings.fact('Files', 'folders checked', roots.length);
    ctx.findings.fact('Files', 'folders found', rootsFound);
    ctx.findings.fact('Files', 'main transcripts', mains.length);
    ctx.findings.fact('Files', 'subagent files', subagents.length);
    ctx.findings.fact('Files', 'set-aside copies skipped', setAside);
    ctx.findings.fact('Files', 'files in an unexpected place', other);
    ctx.findings.fact('Files', 'same transcript reached twice', duplicates);
    ctx.findings.fact(
      'Files',
      'compressed transcripts',
      scans.filter((s) => s.located.compressed).length,
    );
    ctx.findings.fact('Files', 'compressed transcripts without a decoder', unsupported);
    ctx.findings.fact('Files', 'files that stopped being readable', failedFiles);
    ctx.findings.fact('Files', 'walk stopped at the file limit', truncated);
    ctx.findings.fact('Lines', 'lines read', lines);
    ctx.findings.fact('Lines', 'unreadable lines', unreadable);
    ctx.findings.fact('Lines', 'lines with usage', seen.usageLines);

    // 2. Field list.
    for (const [type, inventory] of [...seen.inventories].slice(0, 12))
      ctx.findings.fact(
        'Field list by line type',
        `type ${type}`,
        inventory.paths().map((path) => plainPath(path)),
      );
    const missingRequired = REQUIRED_FIELDS.filter((f) => !seen.requiredSeen.has(f));
    const missingRecorded = RECORDED_FIELDS.filter((f) => !seen.recordedSeen.has(f));
    for (const field of REQUIRED_FIELDS)
      ctx.findings.fact(
        'Field presence on lines with usage',
        field,
        `${seen.requiredSeen.get(field) ?? 0}/${seen.usageLines}`,
      );
    ctx.findings.fact('Field list', 'documented fields not observed', [
      ...missingRequired,
      ...missingRecorded,
    ]);
    const fields: Verdicted =
      seen.usageLines === 0
        ? { verdict: 'not-run', detail: 'No line with usage was read.' }
        : missingRequired.length > 0
          ? {
              verdict: 'fail',
              detail: safeText`Fields never seen on a line with usage: ${[...missingRequired]}. Return to Product if usage fields are absent (P-02).`,
            }
          : {
              verdict: 'pass',
              detail: safeText`All ${REQUIRED_FIELDS.length} required fields were present on the lines with usage (lines with usage: ${seen.usageLines}). Documented but not seen: ${missingRecorded.length > 0 ? [...missingRecorded] : ['none']}.`,
            };
    ctx.findings.criterion(CRITERIA.fields, fields.verdict, fields.detail);

    // 3. Sessions, and the dedupe rule across files (a key belongs to the first file, in time order, that has it).
    const sessions = new Map<string, Session>();
    for (const scan of scans) {
      const id = scan.located.session;
      let session = sessions.get(id);
      if (!session) {
        session = { id, main: null, subagents: [] };
        sessions.set(id, session);
      }
      if (scan.located.kind === 'main') session.main = scan;
      else session.subagents.push(scan);
    }
    // A message that appears in several files (a resumed session copies earlier lines) counts once, in the file that
    // holds its earliest copy; copies with the same time go to the file that sorts first by path (ccusage 20.0.48 does
    // the same, checked against its output).
    const byPath = [...scans].sort((a, b) =>
      a.located.path < b.located.path ? -1 : a.located.path > b.located.path ? 1 : 0,
    );
    const owner = new Map<string, { scan: FileScan; at: number | null }>();
    let sharedKeys = 0;
    for (const scan of byPath)
      for (const [key, entry] of scan.entries) {
        const current = owner.get(key);
        if (!current) owner.set(key, { scan, at: entry.at });
        else {
          sharedKeys++;
          if (entry.at !== null && (current.at === null || entry.at < current.at))
            owner.set(key, { scan, at: entry.at });
        }
      }
    ctx.findings.fact('Dedupe', 'usage keys seen in more than one file', sharedKeys);
    ctx.findings.fact(
      'Dedupe',
      'usage lines without a message id (counted as they stand)',
      scans.reduce((n, s) => n + s.keyless.length, 0),
    );
    ctx.findings.fact(
      'Dedupe',
      'usage lines without a request id (keyed by message id alone)',
      scans.reduce((n, s) => n + s.withoutRequestId, 0),
    );

    const totalOf = (scan: FileScan, rule: Rule): Usage => {
      let total = zero();
      for (const [key, entry] of scan.entries)
        if (owner.get(key)?.scan === scan)
          total = plus(
            total,
            rule === 'last' ? entry.last : rule === 'first' ? entry.first : entry.highest,
          );
      for (const entry of scan.keyless) total = plus(total, entry);
      return total;
    };
    const sessionTotal = (session: Session, rule: Rule, form: Form): Usage => {
      let total = session.main ? totalOf(session.main, rule) : zero();
      if (form === 'with-subagents')
        for (const sub of session.subagents) total = plus(total, totalOf(sub, rule));
      return total;
    };

    // 4. Reconciliation with the oracle.
    const oracle = await loadOracle(ctx);
    let reconcile: Verdicted;
    if (oracle.state === 'none') {
      reconcile = { verdict: 'not-run', detail: `No oracle to compare with: ${oracle.reason}.` };
      say(`Oracle: ${oracle.reason}`);
    } else {
      say(
        `Oracle: ${oracle.entries.length} sessions from ${oracle.source === 'file' ? 'the --oracle file' : 'ccusage'}`,
      );
      const comparable = oracle.entries.filter((entry) => {
        const session = sessions.get(entry.id);
        return (
          session !== undefined &&
          [session.main, ...session.subagents].every((s) => s === null || s.state === 'ok')
        );
      });
      const differences = (rule: Rule, form: Form): Difference[] =>
        comparable.flatMap((entry, index): Difference[] => {
          const local = sessionTotal(sessions.get(entry.id)!, rule, form);
          const diffs = [
            ...CATEGORIES.map((c) => ({ label: CATEGORY_LABEL[c], by: local[c] - entry.usage[c] })),
            { label: CATEGORY_LABEL.total, by: sum(local) - entry.total },
          ].filter((d) => d.by !== 0);
          return diffs.length > 0 ? [{ ordinal: index + 1, diffs }] : [];
        });
      // Every way of counting is tried; the findings follow the one closest to the oracle (ties: the first listed).
      const tried = FORMS.flatMap((form) =>
        RULES.map((rule) => ({ form, rule, wrong: differences(rule, form) })),
      );
      const closest = tried.reduce((a, b) => (b.wrong.length < a.wrong.length ? b : a));
      const foldsSubagents = closest.form === 'with-subagents';
      const form = closest.form;
      const wrong = closest.wrong;
      const reproducing = tried
        .filter((t) => t.form === form && t.wrong.length === 0)
        .map((t) => t.rule);

      ctx.findings.fact('Reconciliation', 'oracle sessions', oracle.entries.length);
      ctx.findings.fact('Reconciliation', 'sessions found in both', comparable.length);
      ctx.findings.fact(
        'Reconciliation',
        'sessions only in the oracle',
        oracle.entries.length - comparable.length,
      );
      ctx.findings.fact('Reconciliation', 'sessions that differ (closest rule)', wrong.length);
      const anySubagents = comparable.some((e) => (sessions.get(e.id)?.subagents.length ?? 0) > 0);
      ctx.findings.fact(
        'Reconciliation',
        'oracle counts subagent usage under the parent',
        anySubagents ? foldsSubagents : 'n/a',
      );
      for (const t of tried.filter((x) => x.form === form))
        ctx.findings.fact(
          'Dedupe rules tried',
          `sessions matching, ${t.rule} line per key`,
          comparable.length - t.wrong.length,
        );
      ctx.findings.fact(
        'Dedupe rules tried',
        'rules that reproduce the oracle',
        reproducing.length > 0 ? reproducing : ['nothing-matches'],
      );
      for (const d of wrong.slice(0, 20))
        ctx.findings.fact(
          'Reconciliation',
          `session ${d.ordinal} difference`,
          d.diffs.map((x) => `${x.label}${x.by > 0 ? '+' : ''}${x.by}`),
        );

      if (wrong.length > 0) {
        const shown = wrong
          .slice(0, 3)
          .map(
            (d) =>
              `session ${d.ordinal}: ${d.diffs.map((x) => `${x.label} ${x.by > 0 ? '+' : ''}${x.by}`).join(', ')}`,
          )
          .join('; ');
        reconcile = {
          verdict: 'fail',
          detail: `Sessions that differ from the oracle: ${wrong.length} of ${comparable.length}, under the closest rule ${closest.rule} (${shown}).`,
        };
        ctx.findings.note(
          'A session that Claude Code is still writing to can differ by a few tokens between the two reads. Run again when it is idle before changing the parser.',
        );
      } else if (comparable.length < MIN_SESSIONS) {
        reconcile = {
          verdict: 'not-run',
          detail: `Sessions in both the transcripts and the oracle: ${comparable.length}; ${MIN_SESSIONS} are needed.`,
        };
      } else {
        reconcile = {
          verdict: 'pass',
          detail: safeText`Sessions compared: ${comparable.length}; all match the oracle to 0 tokens${foldsSubagents ? ' (subagent usage counted under the parent)' : ''}. Lines that reproduce it: ${reproducing}.`,
        };
      }
      say(`Sessions in both: ${comparable.length}; differing: ${wrong.length}`);
      say(`Dedupe rules that reproduce the oracle: ${reproducing.join(', ') || 'none'}`);
      for (const d of wrong.slice(0, 3))
        say(
          `Session ${d.ordinal} differs: ${d.diffs.map((x) => `${x.label} ${x.by > 0 ? '+' : ''}${x.by}`).join(', ')}`,
        );
    }
    ctx.findings.criterion(CRITERIA.reconcile, reconcile.verdict, reconcile.detail);

    // 5. Subagent files map to their parent (by location, R3), with the lines' own sessionId as a cross-check.
    const mainPaths = new Set(mains.map((s) => s.located.path));
    const unmapped = subagents.filter(
      (s) => s.located.parentPath === null || !mainPaths.has(s.located.parentPath),
    );
    ctx.findings.fact('Subagents', 'subagent files', subagents.length);
    ctx.findings.fact(
      'Subagents',
      'subagent files with a parent transcript',
      subagents.length - unmapped.length,
    );
    ctx.findings.fact('Subagents', 'subagent files without a parent transcript', unmapped.length);
    ctx.findings.fact(
      'Subagents',
      'subagent lines whose sessionId is the parent folder name',
      subagents.reduce((n, s) => n + s.sessionFieldSame, 0),
    );
    ctx.findings.fact(
      'Subagents',
      'subagent lines whose sessionId is something else',
      subagents.reduce((n, s) => n + s.sessionFieldOther, 0),
    );
    ctx.findings.fact(
      'Subagents',
      'subagent lines marked isSidechain',
      subagents.reduce((n, s) => n + s.sidechainLines, 0),
    );
    const parent: Verdicted =
      subagents.length === 0
        ? { verdict: 'not-run', detail: 'No subagent file was found.' }
        : unmapped.length > 0
          ? {
              verdict: 'fail',
              detail: `Subagent files with no parent transcript: ${unmapped.length} of ${subagents.length}.`,
            }
          : {
              verdict: 'pass',
              detail: `Subagent files: ${subagents.length}; all sit under a parent session whose transcript exists.`,
            };
    ctx.findings.criterion(CRITERIA.parent, parent.verdict, parent.detail);

    // 6. Title presence (recorded, not judged).
    const readableMains = mains.filter((s) => s.state === 'ok');
    const titled = readableMains.filter((s) => s.titleLines > 0).length;
    ctx.findings.fact('Titles', 'main transcripts read', readableMains.length);
    ctx.findings.fact('Titles', 'main transcripts with a title line', titled);
    ctx.findings.fact('Titles', 'title line types seen', [...seen.titleTypes].sort());
    ctx.findings.fact('Titles', 'title fields seen', [...seen.titleKeys].sort());
    const title: Verdicted =
      readableMains.length === 0
        ? { verdict: 'not-run', detail: 'No main transcript was read.' }
        : {
            verdict: 'pass',
            detail: safeText`Main transcripts with a title line: ${titled} of ${readableMains.length} (line types seen: ${seen.titleTypes.size > 0 ? [...seen.titleTypes].sort() : ['none']}).`,
          };
    ctx.findings.criterion(CRITERIA.title, title.verdict, title.detail);

    // 7. Session start: the earliest line's timestamp against the first usage event.
    const judged = scans.filter((s) => s.state === 'ok' && s.usageLines > 0);
    const gap = (s: FileScan): number | null =>
      s.earliest !== null && s.firstUsage !== null ? s.firstUsage - s.earliest : null;
    const late = judged.filter((s) => {
      const g = gap(s);
      return g === null || g < 0;
    });
    const gapsOf = (kind: 'main' | 'subagent'): number[] =>
      judged
        .filter((s) => s.located.kind === kind)
        .map(gap)
        .filter((g): g is number => g !== null && g >= 0)
        .map(seconds);
    const mainGaps = gapsOf('main');
    const subGaps = gapsOf('subagent');
    for (const [label, gaps] of [
      ['main', mainGaps],
      ['subagent', subGaps],
    ] as const) {
      ctx.findings.fact('Session start', `${label} files judged`, gaps.length);
      if (gaps.length > 0) {
        ctx.findings.fact('Session start', `${label} gap seconds, first three`, gaps.slice(0, 3));
        ctx.findings.fact('Session start', `${label} gap seconds, smallest`, Math.min(...gaps));
        ctx.findings.fact('Session start', `${label} gap seconds, median`, median(gaps));
        ctx.findings.fact('Session start', `${label} gap seconds, largest`, Math.max(...gaps));
      }
    }
    ctx.findings.fact('Session start', 'files with usage but no usable timestamp', late.length);
    const start: Verdicted =
      late.length > 0
        ? {
            verdict: 'fail',
            detail: `Files with no timestamp at or before their first usage event: ${late.length} of ${judged.length}.`,
          }
        : mainGaps.length === 0 || subGaps.length === 0
          ? {
              verdict: 'not-run',
              detail: `Needs a main transcript and a subagent file with usage; main files judged: ${mainGaps.length}, subagent files judged: ${subGaps.length}.`,
            }
          : {
              verdict: 'pass',
              detail: safeText`Main files judged: ${mainGaps.length}; subagent files judged: ${subGaps.length}; every one starts at or before its first usage; the gap is ${spread([...mainGaps, ...subGaps])} seconds.`,
            };
    ctx.findings.criterion(CRITERIA.start, start.verdict, start.detail);

    if (!decoder && scans.some((s) => s.located.compressed))
      ctx.findings.note(
        'Some transcripts are zstd-compressed and this Node has no zstd decoder, so they were counted as unsupported and left out.',
      );
    if (scans.length === 0)
      ctx.findings.note('No Claude Code transcript was found in the folders checked.');
  },
});

runIfMain(import.meta, experiment);
