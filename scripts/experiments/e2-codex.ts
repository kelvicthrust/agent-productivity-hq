import { join, relative } from 'node:path';
import { defineExperiment, runIfMain, STANDARD_FLAGS } from './lib/cli.ts';
import { isIdentifier, safeText } from './lib/redact.ts';
import { FieldInventory } from './lib/shape.ts';
import type { ExperimentContext, ProcessSession, Verdict } from './lib/types.ts';

// E2: does the Codex rollout on this machine have the shape the adapter assumes (fields, replayed parent prefix, the
// parent reference, `.jsonl.zst`), and do the cumulative-snapshot deltas give the same totals as ccusage? Everything is
// parsed in memory. What leaves memory is a count, a field name, a token number or a time gap; never a line, a title, an
// id, a path or a token.

const CRITERIA = {
  fields: 'field-list-confirmed',
  reconcile: 'reconcile-three-sessions',
  zst: 'zst-rollouts-readable',
  parent: 'parent-reference-located',
  names: 'thread-list-name',
  start: 'session-start-before-first-usage',
  createdAt: 'thread-created-at-compared',
} as const;

/** What the normalization cannot work without (TECH, Codex local rollouts). Paths are `<line type>.<payload path>`. */
const TOKEN_FIELDS = [
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
] as const;
const REQUIRED_FIELDS = [
  'session_meta.id',
  'turn_context.model',
  ...TOKEN_FIELDS.map((f) => `token_count.info.total_token_usage.${f}`),
] as const;
/** Documented too, but only recorded: a rollout may lack them (no git repository, an older version). */
const RECORDED_FIELDS = [
  'session_meta.timestamp',
  'session_meta.cwd',
  'session_meta.originator',
  'session_meta.cli_version',
  'session_meta.source',
  'session_meta.git.repository_url',
  'session_meta.git.branch',
  'session_meta.git.commit_hash',
  ...TOKEN_FIELDS.map((f) => `token_count.info.last_token_usage.${f}`),
] as const;

const ROLLOUT_FILE = /\.jsonl(?:\.zst)?$/;
const FOLDERS = ['sessions', 'archived_sessions'] as const;
const PARENT_KEY = /parent|forked_from/i;
const CHILD_SOURCE = /sub[_-]?agent|thread_spawn/i;
const LABEL_KIND = /^[A-Za-z][A-Za-z0-9_/-]{0,60}$/;

const MIN_SESSIONS = 3;
const MAX_INVENTORY_RECORDS_PER_KIND = 300;
const MAX_THREAD_PAGES = 50;
const REPLY_TIMEOUT_MS = 20_000;

interface Snapshot {
  at: number | null;
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  total: number;
  /** The last request's input + output from `last_token_usage`, when the line has it. */
  lastRequest: number | null;
}
const EMPTY: Snapshot = {
  at: null,
  input: 0,
  cached: 0,
  output: 0,
  reasoning: 0,
  total: 0,
  lastRequest: null,
};

/**
 * Ways to tell which snapshots of a spawned child are the replayed parent prefix. TECH leaves the exact marker to E2, so
 * every candidate is tried and the findings say which one reproduces the oracle. Codex writes each line with the time it
 * is written, so a replayed line may carry an older time or a new one; that is why there is more than one candidate.
 */
const MARKERS = [
  'older-than-start',
  'equals-a-parent-snapshot',
  'before-first-turn',
  'none',
] as const;
type Marker = (typeof MARKERS)[number];
const MARKER_TEXT: Record<Marker, string> = {
  'older-than-start': "stamped before the child's own session_meta timestamp",
  'equals-a-parent-snapshot': "the same cumulative totals as a snapshot in the parent's rollout",
  'before-first-turn': "before the child's first turn_context line",
  none: 'never (no baseline is used)',
};

interface Rollout {
  path: string;
  /** The file name without `.jsonl` or `.jsonl.zst`, which is also how ccusage names the session. */
  base: string;
  folder: (typeof FOLDERS)[number];
  compressed: boolean;
  state: 'ok' | 'unsupported' | 'unreadable';
  lines: number;
  unreadable: number;
  metaId: string | null;
  metaAt: number | null;
  isChild: boolean;
  parent: { field: string; value: string } | null;
  snapshots: Snapshot[];
  /** How many snapshots came before the first `turn_context` line (null when there is no such line). */
  snapshotsBeforeTurn: number | null;
  withoutTotals: number;
  compactionRecords: number;
}

interface Totals {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  /** The owner's rule: input + output. */
  total: number;
  inherited: number;
  resets: number;
  duplicates: number;
  unclassified: number;
  /** The snapshots that are the rollout's own, and when the first of them was written. */
  ownSnapshots: number;
  ownFirstAt: number | null;
}

interface OracleEntry {
  names: string[];
  input: number;
  cached: number;
  output: number;
  reasoning: number;
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

/** Field paths with arrays written as `.item` and folded keys as `any`, so every path is identifier-shaped. */
const plainPath = (path: string): string => path.replaceAll('[]', '.item').replaceAll('*', 'any');

/** The first key below `value` (to a small depth) that names a parent or a fork source, with its string value. */
function findParent(
  value: unknown,
  prefix = '',
  depth = 0,
): { field: string; value: string } | null {
  const record = asRecord(value);
  if (!record || depth > 5) return null;
  for (const [key, child] of Object.entries(record)) {
    const field = prefix === '' ? key : `${prefix}.${key}`;
    if (PARENT_KEY.test(key) && typeof child === 'string' && child !== '')
      return { field, value: child };
    const deeper = findParent(child, field, depth + 1);
    if (deeper) return deeper;
  }
  return null;
}

/** The shared state the line reader fills in as it goes. */
class Observations {
  readonly inventories = new Map<string, FieldInventory>();
  readonly inventoryCounts = new Map<string, number>();
  /** Field paths seen with a usable value, as `<line type>.<payload path>`. */
  readonly present = new Set<string>();
  readonly sourceKinds = new Set<string>();
  readonly parentFields = new Set<string>();
  metaTimeInPayload = 0;
  metaTimeOnLine = 0;
  legacyMeta = 0;
  totalTokensDiffers = false;

  inventory(kind: string, record: Record<string, unknown>): void {
    const name = LABEL_KIND.test(kind) ? kind : 'other';
    const used = this.inventoryCounts.get(name) ?? 0;
    if (used >= MAX_INVENTORY_RECORDS_PER_KIND) return;
    this.inventoryCounts.set(name, used + 1);
    let inventory = this.inventories.get(name);
    if (!inventory) {
      inventory = new FieldInventory();
      this.inventories.set(name, inventory);
    }
    inventory.add(record);
  }

  /** Notes which of `paths` exist in `record` (a number where `numeric`, else any value but null), under `label.`. */
  note(
    label: string,
    record: Record<string, unknown>,
    paths: readonly string[],
    numeric = false,
  ): void {
    for (const path of paths) {
      const value = pathValue(record, path);
      const usable = numeric ? typeof value === 'number' : value !== undefined && value !== null;
      if (usable) this.present.add(`${label}.${path}`);
    }
  }
}

function snapshotOf(
  usage: Record<string, unknown>,
  last: Record<string, unknown> | null,
  at: number | null,
  seen: Observations,
): Snapshot {
  const input = count(usage['input_tokens']);
  const output = count(usage['output_tokens']);
  const total = typeof usage['total_tokens'] === 'number' ? usage['total_tokens'] : input + output;
  if (total !== input + output) seen.totalTokensDiffers = true;
  return {
    at,
    input,
    cached: count(usage['cached_input_tokens']),
    output,
    reasoning: count(usage['reasoning_output_tokens']),
    total,
    lastRequest: last ? count(last['input_tokens']) + count(last['output_tokens']) : null,
  };
}

function ingest(rollout: Rollout, record: Record<string, unknown>, seen: Observations): void {
  const lineAt = timeOf(record['timestamp']);
  const payload = asRecord(record['payload']);
  const type = typeof record['type'] === 'string' ? record['type'] : '';
  const inner = payload && typeof payload['type'] === 'string' ? payload['type'] : '';
  seen.inventory(type === 'event_msg' && inner !== '' ? `event_msg/${inner}` : type, record);

  // The first line of an older rollout is the metadata itself, with no `type` and no `payload`.
  const legacy = type === '' && typeof record['id'] === 'string' && 'timestamp' in record;
  if ((type === 'session_meta' && payload) || (legacy && rollout.metaId === null)) {
    const meta = legacy ? record : (payload ?? {});
    if (legacy) seen.legacyMeta++;
    if (rollout.metaId === null && typeof meta['id'] === 'string') rollout.metaId = meta['id'];
    const inPayload = timeOf(meta['timestamp']);
    if (inPayload !== null) seen.metaTimeInPayload++;
    else if (lineAt !== null && !legacy) seen.metaTimeOnLine++;
    rollout.metaAt ??= inPayload ?? lineAt;
    seen.note('session_meta', meta, [
      'id',
      'timestamp',
      'cwd',
      'originator',
      'cli_version',
      'source',
      'git.repository_url',
      'git.branch',
      'git.commit_hash',
    ]);
    const source = meta['source'];
    const kind = typeof source === 'string' ? source : Object.keys(asRecord(source) ?? {})[0];
    if (kind !== undefined && LABEL_KIND.test(kind)) seen.sourceKinds.add(kind);
    const parent = findParent(meta);
    const spawned = CHILD_SOURCE.test(JSON.stringify(source ?? ''));
    if (spawned || (parent !== null && /^parent/i.test(parent.field.split('.').at(-1) ?? '')))
      rollout.isChild = true;
    if (parent) {
      rollout.parent ??= parent;
      if (isIdentifier(plainPath(parent.field))) seen.parentFields.add(plainPath(parent.field));
    }
    return;
  }
  if (!payload) return;
  if (type === 'turn_context') {
    seen.note('turn_context', payload, ['model']);
    rollout.snapshotsBeforeTurn ??= rollout.snapshots.length;
  } else if (type === 'event_msg' && inner === 'token_count') {
    const info = asRecord(payload['info']);
    const total = info ? asRecord(info['total_token_usage']) : null;
    if (!info || !total) {
      rollout.withoutTotals++;
      return;
    }
    seen.note(
      'token_count',
      payload,
      [
        ...TOKEN_FIELDS.map((f) => `info.total_token_usage.${f}`),
        ...TOKEN_FIELDS.map((f) => `info.last_token_usage.${f}`),
      ],
      true,
    );
    rollout.snapshots.push(
      snapshotOf(
        total,
        asRecord(info['last_token_usage']),
        lineAt ?? timeOf(payload['timestamp']),
        seen,
      ),
    );
  } else if (type === 'token_usage_record' || inner === 'token_usage_record') {
    rollout.compactionRecords++;
  }
}

function scanFile(ctx: ExperimentContext, rollout: Rollout, seen: Observations): void {
  if (rollout.compressed && !ctx.fs.zstdAvailable()) {
    rollout.state = 'unsupported';
    return;
  }
  try {
    for (const raw of ctx.fs.lines(rollout.path)) {
      rollout.lines++;
      const record = parseObject(raw);
      if (record) ingest(rollout, record, seen);
      else rollout.unreadable++;
    }
  } catch {
    rollout.state = 'unreadable';
  }
}

const snapshotKey = (s: Snapshot): string =>
  `${s.input}/${s.cached}/${s.output}/${s.reasoning}/${s.total}`;

/**
 * Totals for one rollout by TECH's normalization: deltas between cumulative snapshots. In a spawned child the snapshots
 * of the replayed parent prefix are not its usage; the last of them is the baseline. `marker` says which snapshots those
 * are (see MARKERS). A snapshot the marker cannot classify is counted, not guessed.
 */
function totalsOf(rollout: Rollout, marker: Marker, parentKeys: Set<string> | null): Totals {
  const t: Totals = {
    input: 0,
    cached: 0,
    output: 0,
    reasoning: 0,
    total: 0,
    inherited: 0,
    resets: 0,
    duplicates: 0,
    unclassified: 0,
    ownSnapshots: 0,
    ownFirstAt: null,
  };
  const turnAt = rollout.snapshotsBeforeTurn;
  const verdictOf = (s: Snapshot, index: number): 'inherited' | 'own' | 'unknown' => {
    if (!rollout.isChild || marker === 'none') return 'own';
    if (marker === 'older-than-start') {
      if (s.at === null || rollout.metaAt === null) return 'unknown';
      return s.at < rollout.metaAt ? 'inherited' : 'own';
    }
    if (marker === 'equals-a-parent-snapshot') {
      if (parentKeys === null) return 'unknown';
      return parentKeys.has(snapshotKey(s)) ? 'inherited' : 'own';
    }
    if (turnAt === null) return 'unknown';
    return index < turnAt ? 'inherited' : 'own';
  };
  let previous: Snapshot | null = null;
  let baseline: Snapshot | null = null;
  let first = true;
  rollout.snapshots.forEach((s, index) => {
    const kind = verdictOf(s, index);
    if (kind === 'unknown') {
      t.unclassified++;
      return;
    }
    if (kind === 'inherited') {
      baseline = s;
      t.inherited++;
      return;
    }
    t.ownSnapshots++;
    if (first) {
      t.ownFirstAt = s.at;
      first = false;
    }
    const ref: Snapshot = previous ?? baseline ?? EMPTY;
    let d = {
      input: s.input - ref.input,
      cached: s.cached - ref.cached,
      output: s.output - ref.output,
      reasoning: s.reasoning - ref.reasoning,
      total: s.total - ref.total,
    };
    if (Object.values(d).some((n) => n < 0)) {
      t.resets++;
      d = {
        input: s.input,
        cached: s.cached,
        output: s.output,
        reasoning: s.reasoning,
        total: s.total,
      };
    }
    if (d.total === 0) {
      t.duplicates++;
      return;
    }
    t.input += d.input;
    t.cached += d.cached;
    t.output += d.output;
    t.reasoning += d.reasoning;
    t.total += d.input + d.output;
    previous = s;
  });
  return t;
}

function codexHomes(ctx: ExperimentContext): string[] {
  const flagged = ctx.args.all('codex-home');
  if (flagged.some((value) => value === 'true')) throw new Error('--codex-home needs a folder.');
  if (flagged.length > 0) return flagged;
  const configured = ctx.env['CODEX_HOME'];
  if (configured) {
    const entries = configured
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    if (entries.length > 0) return entries;
  }
  return [join(ctx.home, '.codex')];
}

function checkFlags(ctx: ExperimentContext): void {
  const known = new Set<string>([...STANDARD_FLAGS, 'codex-home', 'oracle']);
  const unknown = ctx.args.names().find((name) => !known.has(name));
  if (unknown !== undefined)
    throw new Error(`Unknown flag --${isIdentifier(unknown) ? unknown : 'name'}. See --help.`);
  if (ctx.args.get('oracle') === 'true') throw new Error('--oracle needs the path of a file.');
}

/**
 * The sessions in a `ccusage codex session --json` result (or the unified report: `session`, `period`, `agent`).
 * Checked against ccusage 20.0.48: `inputTokens` is the uncached input and `cacheReadTokens` the cached part of it.
 * A report with `cachedInputTokens` is read the older way (unverified): `inputTokens` already includes the cached part.
 */
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
    if (typeof record['agent'] === 'string' && record['agent'] !== 'codex') continue;
    const names = [record['sessionFile'], record['sessionId'], record['period'], record['id']]
      .filter((value): value is string => typeof value === 'string' && value !== '')
      .map((value) => value.split('/').at(-1) ?? value);
    if (names.length === 0 || typeof record['inputTokens'] !== 'number') continue;
    const older = typeof record['cachedInputTokens'] === 'number';
    const cached = count(older ? record['cachedInputTokens'] : record['cacheReadTokens']);
    const input = count(record['inputTokens']) + (older ? 0 : cached);
    const output = count(record['outputTokens']);
    out.push({
      names,
      input,
      cached,
      output,
      reasoning: count(record['reasoningOutputTokens']),
      total: typeof record['totalTokens'] === 'number' ? record['totalTokens'] : input + output,
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
    const run = await ctx.spawn('ccusage', ['codex', 'session', '--json', '--offline'], {
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

interface ThreadInfo {
  id: string | null;
  named: boolean;
  createdAt: number | null;
}

type ThreadResult =
  | { state: 'ok'; threads: ThreadInfo[]; pages: number }
  | { state: 'absent' }
  | { state: 'failed'; reason: string };

/** One JSON-RPC request over the app-server's standard input and output; notifications on the way are skipped. */
async function call(
  session: ProcessSession,
  id: number,
  method: string,
  params: unknown,
): Promise<Record<string, unknown> | null> {
  session.send(JSON.stringify({ method, id, params }));
  for (let i = 0; i < 200; i++) {
    const line = await session.nextLine(REPLY_TIMEOUT_MS);
    if (line === null) return null;
    const message = parseObject(line);
    if (message && message['id'] === id) return message;
  }
  return null;
}

/** `thread/list` over `codex app-server` (live and archived, all source kinds). Titles are only counted, never kept. */
async function listThreads(ctx: ExperimentContext): Promise<ThreadResult> {
  const session = await ctx.session('codex', ['app-server']);
  if (!session.found) return { state: 'absent' };
  try {
    const hello = await call(session, 1, 'initialize', {
      clientInfo: { name: 'experiment_e2', title: 'Experiment E2', version: '0.0.0' },
    });
    if (!hello || hello['error'] !== undefined)
      return { state: 'failed', reason: 'the app-server did not answer initialize' };
    const agent = asRecord(hello['result'])?.['userAgent'];
    const version =
      typeof agent === 'string' ? agent.match(/\b\d+\.\d+\.\d+[\w.+-]*/)?.[0] : undefined;
    if (version) ctx.findings.tool('codex', version);
    session.send(JSON.stringify({ method: 'initialized', params: {} }));

    const threads: ThreadInfo[] = [];
    let id = 2;
    let pages = 0;
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      for (let page = 0; page < MAX_THREAD_PAGES; page++) {
        const params: Record<string, unknown> = { archived, sourceKinds: [], limit: 100 };
        if (cursor !== null) params['cursor'] = cursor;
        const reply = await call(session, id++, 'thread/list', params);
        if (!reply || reply['error'] !== undefined)
          return { state: 'failed', reason: 'the app-server did not answer thread/list' };
        pages++;
        const result = asRecord(reply['result']);
        const data = result?.['data'] ?? result?.['threads'];
        for (const item of Array.isArray(data) ? data : []) {
          const thread = asRecord(item);
          if (!thread) continue;
          const created = thread['createdAt'] ?? thread['created_at'];
          threads.push({
            id: typeof thread['id'] === 'string' ? thread['id'] : null,
            named: typeof thread['name'] === 'string' && thread['name'] !== '',
            createdAt: typeof created === 'number' && Number.isFinite(created) ? created : null,
          });
        }
        const next = result?.['nextCursor'];
        cursor = typeof next === 'string' && next !== '' ? next : null;
        if (cursor === null) break;
      }
    }
    return { state: 'ok', threads, pages };
  } finally {
    session.kill();
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

const signed = (n: number): string => `${n > 0 ? '+' : ''}${n}`;

export const experiment = defineExperiment({
  meta: {
    id: 'E2',
    script: 'scripts/experiments/e2-codex.ts',
    title: 'Codex rollout shape, replay baseline, parent reference and zstd',
    question:
      "What is the Codex rollout shape on the installed version: the replay baseline for spawned subagents, the parent reference, `.zst` support and session titles, and do the snapshot deltas reproduce ccusage's session totals?",
    criteria: [
      {
        id: CRITERIA.fields,
        text: 'Field list confirmed: the session id, the turn model and the five `total_token_usage` fields are present.',
      },
      {
        id: CRITERIA.reconcile,
        text: '3 sessions (one with a spawned subagent, one archived) reconcile with `ccusage codex session --json` to within 0 tokens.',
      },
      {
        id: CRITERIA.zst,
        text: '`.jsonl.zst` rollouts are read with the Node zstd decoder (a missing decoder is reported, not hidden).',
      },
      {
        id: CRITERIA.parent,
        text: "Parent reference located: a spawned subagent's rollout names its parent, and the parent is one of the rollouts read.",
      },
      { id: CRITERIA.names, text: '`thread/list.name` returned.' },
      {
        id: CRITERIA.start,
        text: '`session_meta.timestamp` is present and at or before the first `token_count`; the gap is recorded.',
      },
      {
        id: CRITERIA.createdAt,
        text: "If `codex` is available, `thread/list`'s `createdAt` is compared with `session_meta.timestamp`; the gap is recorded.",
      },
    ],
    reads: [
      'Codex rollouts: every `*.jsonl` and `*.jsonl.zst` below `sessions/` and `archived_sessions/`, in each folder given with `--codex-home`, else in each comma-separated entry of `$CODEX_HOME`, else in `~/.codex`. Only those two folders are opened (never `auth.json` or `config.toml`). A plain file wins over its `.zst` twin, and a `sessions/` copy over an `archived_sessions/` copy. Lines are parsed in memory and never printed.',
      'ccusage oracle file: the file given with `--oracle` (the output of `ccusage codex session --json --offline`), when you give one.',
    ],
    prints: [
      'The folders it will read, counts of rollouts, lines and unreadable lines, whether a zstd decoder is present, and one verdict line per criterion. Never a line, title, id, path or token.',
    ],
    writes: [
      'docs/implementation/experiments/E2.md (the findings: field names, counts, token differences and time gaps only)',
    ],
    network: [],
    spawns: ['ccusage', 'codex'],
    example:
      'node scripts/experiments/e2-codex.ts --oracle <file from ccusage codex session --json --offline>',
    selftest: [
      {
        name: 'three sessions reconcile, the parent is found and every criterion passes',
        args: [
          '--codex-home',
          '{fixtures}/codex/home',
          '--oracle',
          '{fixtures}/codex/oracle.json',
          '--bin',
          'codex={fixtures}/codex/fake-codex.ts',
        ],
        expect: {
          exit: 0,
          verdicts: {
            [CRITERIA.fields]: 'pass',
            [CRITERIA.reconcile]: 'pass',
            [CRITERIA.zst]: 'pass',
            [CRITERIA.parent]: 'pass',
            [CRITERIA.names]: 'pass',
            [CRITERIA.start]: 'pass',
            [CRITERIA.createdAt]: 'pass',
          },
          stdoutIncludes: [
            'Will read: Codex rollouts',
            'Will start: codex app-server',
            'Unreadable lines: 0',
          ],
        },
      },
      {
        name: 'a one-token difference from the oracle fails the reconciliation',
        args: [
          '--codex-home',
          '{fixtures}/codex/home',
          '--oracle',
          '{fixtures}/codex/oracle-one-token-off.json',
          '--bin',
          'codex={fixtures}/codex/fake-codex.ts',
        ],
        expect: {
          exit: 1,
          verdicts: {
            [CRITERIA.fields]: 'pass',
            [CRITERIA.reconcile]: 'fail',
            [CRITERIA.zst]: 'pass',
            [CRITERIA.parent]: 'pass',
            [CRITERIA.names]: 'pass',
            [CRITERIA.start]: 'pass',
            [CRITERIA.createdAt]: 'pass',
          },
          stdoutIncludes: ['output +1'],
        },
      },
      {
        name: 'a spawned subagent whose rollout names no parent fails the parent reference',
        args: [
          '--codex-home',
          '{fixtures}/codex/home',
          '--codex-home',
          '{fixtures}/codex/home-orphan',
          '--oracle',
          '{fixtures}/codex/oracle.json',
          '--bin',
          'codex={fixtures}/codex/fake-codex.ts',
        ],
        expect: {
          exit: 1,
          verdicts: {
            [CRITERIA.fields]: 'pass',
            [CRITERIA.reconcile]: 'pass',
            [CRITERIA.zst]: 'pass',
            [CRITERIA.parent]: 'fail',
            [CRITERIA.names]: 'pass',
            [CRITERIA.start]: 'pass',
            [CRITERIA.createdAt]: 'pass',
          },
        },
      },
      {
        name: 'no zstd decoder is reported and the compressed rollout is left out',
        args: [
          '--codex-home',
          '{fixtures}/codex/home',
          '--oracle',
          '{fixtures}/codex/oracle.json',
          '--bin',
          'codex={fixtures}/codex/fake-codex.ts',
        ],
        env: { EXPERIMENTS_FORCE_NO_ZSTD: '1' },
        expect: {
          exit: 0,
          verdicts: {
            [CRITERIA.fields]: 'pass',
            [CRITERIA.reconcile]: 'not-run',
            [CRITERIA.zst]: 'not-run',
            [CRITERIA.parent]: 'pass',
            [CRITERIA.names]: 'pass',
            [CRITERIA.start]: 'pass',
            [CRITERIA.createdAt]: 'pass',
          },
          stdoutIncludes: ['Zstandard decoder: not available'],
        },
      },
      {
        name: 'no oracle file, no ccusage and no codex: those criteria are not run',
        args: [
          '--codex-home',
          '{fixtures}/codex/home',
          '--bin',
          'ccusage={fixtures}/codex/no-ccusage-here',
          '--bin',
          'codex={fixtures}/codex/no-codex-here',
        ],
        expect: {
          exit: 0,
          verdicts: {
            [CRITERIA.fields]: 'pass',
            [CRITERIA.reconcile]: 'not-run',
            [CRITERIA.zst]: 'pass',
            [CRITERIA.parent]: 'pass',
            [CRITERIA.names]: 'not-run',
            [CRITERIA.start]: 'pass',
            [CRITERIA.createdAt]: 'not-run',
          },
          stdoutIncludes: ['ccusage is not on PATH', 'codex is not on PATH'],
        },
      },
      {
        name: 'ccusage on PATH is started when there is no oracle file',
        args: [
          '--codex-home',
          '{fixtures}/codex/home',
          '--bin',
          'ccusage={fixtures}/codex/fake-ccusage.ts',
          '--bin',
          'codex={fixtures}/codex/fake-codex.ts',
        ],
        expect: {
          exit: 0,
          verdicts: {
            [CRITERIA.fields]: 'pass',
            [CRITERIA.reconcile]: 'pass',
            [CRITERIA.zst]: 'pass',
            [CRITERIA.parent]: 'pass',
            [CRITERIA.names]: 'pass',
            [CRITERIA.start]: 'pass',
            [CRITERIA.createdAt]: 'pass',
          },
          stdoutIncludes: ['Will start: ccusage codex session --json --offline'],
        },
      },
      {
        name: 'unreadable lines are counted and never shown',
        args: [
          '--codex-home',
          '{fixtures}/codex/home-corrupt',
          '--bin',
          'ccusage={fixtures}/codex/no-ccusage-here',
          '--bin',
          'codex={fixtures}/codex/no-codex-here',
        ],
        expect: {
          exit: 0,
          verdicts: {
            [CRITERIA.fields]: 'pass',
            [CRITERIA.reconcile]: 'not-run',
            [CRITERIA.zst]: 'not-run',
            [CRITERIA.parent]: 'not-run',
            [CRITERIA.names]: 'not-run',
            [CRITERIA.start]: 'pass',
            [CRITERIA.createdAt]: 'not-run',
          },
          stdoutIncludes: ['Unreadable lines: 2'],
        },
      },
      {
        name: 'no rollouts in the folder: nothing can be judged',
        args: [
          '--codex-home',
          '{fixtures}/codex/no-such-codex-home',
          '--bin',
          'ccusage={fixtures}/codex/no-ccusage-here',
          '--bin',
          'codex={fixtures}/codex/no-codex-here',
        ],
        expect: {
          exit: 0,
          verdicts: {
            [CRITERIA.fields]: 'not-run',
            [CRITERIA.reconcile]: 'not-run',
            [CRITERIA.zst]: 'not-run',
            [CRITERIA.parent]: 'not-run',
            [CRITERIA.names]: 'not-run',
            [CRITERIA.start]: 'not-run',
            [CRITERIA.createdAt]: 'not-run',
          },
          stdoutIncludes: ['Rollout files found: 0'],
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

    // 1. Find the rollouts. Precedence (R1): a sessions/ copy beats an archived_sessions/ copy of the same rollout,
    //    and a plain file beats its .zst twin. Precedence only decides which file is read.
    const homes = codexHomes(ctx);
    const folders: { dir: string; folder: (typeof FOLDERS)[number] }[] = [];
    for (const home of homes)
      for (const folder of FOLDERS)
        folders.push({
          dir: ctx.willRead(`Codex rollouts (${folder})`, join(home, folder)),
          folder,
        });
    const chosen = new Map<string, Rollout>();
    let foldersFound = 0;
    let truncated = false;
    let skippedZstTwins = 0;
    let skippedArchivedCopies = 0;
    for (const { dir, folder } of folders) {
      if (!ctx.fs.exists(dir)) continue;
      foldersFound++;
      const walked = ctx.fs.walk(dir, { match: ROLLOUT_FILE, maxDepth: 6 });
      truncated ||= walked.truncated;
      const plainFirst = [...walked.files].sort(
        (a, b) => Number(a.endsWith('.zst')) - Number(b.endsWith('.zst')) || a.localeCompare(b),
      );
      for (const path of plainFirst) {
        const compressed = path.endsWith('.zst');
        const key = relative(dir, path).replace(/\.zst$/, '');
        const earlier = chosen.get(key);
        if (earlier) {
          if (earlier.folder === folder) skippedZstTwins++;
          else skippedArchivedCopies++;
          continue;
        }
        chosen.set(key, {
          path,
          base: (path.split('/').at(-1) ?? path).replace(/\.jsonl(?:\.zst)?$/, ''),
          folder,
          compressed,
          state: 'ok',
          lines: 0,
          unreadable: 0,
          metaId: null,
          metaAt: null,
          isChild: false,
          parent: null,
          snapshots: [],
          snapshotsBeforeTurn: null,
          withoutTotals: 0,
          compactionRecords: 0,
        });
      }
    }
    const seen = new Observations();
    const rollouts = [...chosen.values()];
    for (const rollout of rollouts) scanFile(ctx, rollout, seen);

    const lines = rollouts.reduce((n, r) => n + r.lines, 0);
    const unreadable = rollouts.reduce((n, r) => n + r.unreadable, 0);
    const compressed = rollouts.filter((r) => r.compressed);
    const unsupported = compressed.filter((r) => r.state === 'unsupported');
    const broken = rollouts.filter((r) => r.state === 'unreadable');
    const readable = rollouts.filter((r) => r.state === 'ok');
    const children = rollouts.filter((r) => r.isChild);

    say(`Rollout folders: ${folders.length} checked, ${foldersFound} found`);
    say(`Rollout files found: ${rollouts.length}`);
    say(
      `Active: ${rollouts.filter((r) => r.folder === 'sessions').length}; archived: ${rollouts.filter((r) => r.folder === 'archived_sessions').length}; compressed: ${compressed.length}; spawned subagents: ${children.length}`,
    );
    say(`Lines read: ${lines}`);
    say(`Unreadable lines: ${unreadable} (counted, never shown)`);

    ctx.findings.fact('Files', 'folders checked', folders.length);
    ctx.findings.fact('Files', 'folders found', foldersFound);
    ctx.findings.fact('Files', 'rollouts read', rollouts.length);
    ctx.findings.fact(
      'Files',
      'rollouts in sessions',
      rollouts.filter((r) => r.folder === 'sessions').length,
    );
    ctx.findings.fact(
      'Files',
      'rollouts in archived_sessions',
      rollouts.filter((r) => r.folder === 'archived_sessions').length,
    );
    ctx.findings.fact(
      'Files',
      'compressed rollouts read',
      compressed.length - unsupported.length - broken.filter((r) => r.compressed).length,
    );
    ctx.findings.fact(
      'Files',
      'compressed copies skipped because a plain file exists',
      skippedZstTwins,
    );
    ctx.findings.fact(
      'Files',
      'archived copies skipped because an active copy exists',
      skippedArchivedCopies,
    );
    ctx.findings.fact('Files', 'compressed rollouts left out (no decoder)', unsupported.length);
    ctx.findings.fact('Files', 'files that stopped being readable', broken.length);
    ctx.findings.fact('Files', 'walk stopped at the file limit', truncated);
    ctx.findings.fact('Lines', 'lines read', lines);
    ctx.findings.fact('Lines', 'unreadable lines', unreadable);
    ctx.findings.fact('Lines', 'rollouts that start with the older metadata line', seen.legacyMeta);
    ctx.findings.fact(
      'Lines',
      'token_count lines without totals',
      rollouts.reduce((n, r) => n + r.withoutTotals, 0),
    );
    ctx.findings.fact(
      'Lines',
      'token_usage_record lines (not added to any total here)',
      rollouts.reduce((n, r) => n + r.compactionRecords, 0),
    );

    // 2. Field list.
    for (const [kind, inventory] of [...seen.inventories].slice(0, 14))
      ctx.findings.fact(
        'Field list by line type',
        `type ${kind}`,
        inventory.paths().map((path) => plainPath(path)),
      );
    ctx.findings.fact('Field list', 'session source kinds seen', [...seen.sourceKinds].sort());
    ctx.findings.fact(
      'Field list',
      'session_meta timestamp inside the payload',
      seen.metaTimeInPayload,
    );
    ctx.findings.fact('Field list', 'session_meta timestamp only on the line', seen.metaTimeOnLine);
    ctx.findings.fact(
      'Field list',
      'total_tokens differs from input + output somewhere',
      seen.totalTokensDiffers,
    );
    const missingRequired = REQUIRED_FIELDS.filter((f) => !seen.present.has(f));
    const missingRecorded = RECORDED_FIELDS.filter((f) => !seen.present.has(f));
    ctx.findings.fact('Field list', 'documented fields not observed', [
      ...missingRequired,
      ...missingRecorded,
    ]);
    const snapshots = rollouts.reduce((n, r) => n + r.snapshots.length, 0);
    const fields: Verdicted =
      readable.length === 0 || (snapshots === 0 && seen.present.size === 0)
        ? { verdict: 'not-run', detail: 'No rollout line was read.' }
        : missingRequired.length > 0
          ? {
              verdict: 'fail',
              detail: safeText`Fields never seen: ${[...missingRequired]}. Adjust the parser to the observed shape; return to Product if usage fields are absent (P-01).`,
            }
          : {
              verdict: 'pass',
              detail: safeText`All ${REQUIRED_FIELDS.length} required fields were seen (${snapshots} token_count snapshots). Documented but not seen: ${missingRecorded.length > 0 ? [...missingRecorded] : ['none']}.`,
            };
    ctx.findings.criterion(CRITERIA.fields, fields.verdict, fields.detail);

    // 3. Totals under each way of telling a spawned child's replayed prefix apart.
    const rolloutById = new Map(
      readable.flatMap((r) => (r.metaId !== null ? [[r.metaId, r] as const] : [])),
    );
    const parentKeys = new Map(
      children.map((r) => {
        const parentRollout = r.parent ? rolloutById.get(r.parent.value) : undefined;
        return [
          r,
          parentRollout ? new Set(parentRollout.snapshots.map(snapshotKey)) : null,
        ] as const;
      }),
    );
    const totalsBy = new Map(
      MARKERS.map(
        (marker) =>
          [
            marker,
            new Map(
              rollouts.map((r) => [r, totalsOf(r, marker, parentKeys.get(r) ?? null)] as const),
            ),
          ] as const,
      ),
    );
    const totalsFor = (marker: Marker, r: Rollout): Totals => totalsBy.get(marker)!.get(r)!;
    // The rule the findings are written under: the one closest to the oracle, else TECH's first guess.
    let rule: Marker = MARKERS[0];

    // 4. Reconciliation with the oracle, by rollout file name.
    const oracle = await loadOracle(ctx);
    let reconcile: Verdicted;
    if (oracle.state === 'none') {
      reconcile = { verdict: 'not-run', detail: `No oracle to compare with: ${oracle.reason}.` };
      say(`Oracle: ${oracle.reason}`);
    } else {
      say(
        `Oracle: ${oracle.entries.length} sessions from ${oracle.source === 'file' ? 'the --oracle file' : 'ccusage'}`,
      );
      const byBase = new Map(readable.map((r) => [r.base, r] as const));
      const pairs = oracle.entries.flatMap((entry) => {
        const rollout = entry.names.map((name) => byBase.get(name)).find((r) => r !== undefined);
        return rollout ? [{ entry, rollout }] : [];
      });
      const differences = (marker: Marker): Difference[] =>
        pairs.flatMap(({ entry, rollout }, index): Difference[] => {
          const t = totalsFor(marker, rollout);
          const diffs =
            t.unclassified > 0
              ? [{ label: 'unclassified-snapshots', by: t.unclassified }]
              : [
                  { label: 'input', by: t.input - entry.input },
                  { label: 'cached', by: t.cached - entry.cached },
                  { label: 'output', by: t.output - entry.output },
                  { label: 'reasoning', by: t.reasoning - entry.reasoning },
                  { label: 'total', by: t.total - entry.total },
                ].filter((d) => d.by !== 0);
          return diffs.length > 0 ? [{ ordinal: index + 1, diffs }] : [];
        });
      const tried = MARKERS.map((marker) => ({ marker, wrong: differences(marker) }));
      const reproducing = tried.filter((x) => x.wrong.length === 0).map((x) => x.marker);
      const closest = tried.reduce((a, b) => (b.wrong.length < a.wrong.length ? b : a));
      rule = closest.marker;
      const wrong = closest.wrong;
      const coveredChildren = pairs.filter((p) => p.rollout.isChild).length;
      const coveredArchived = pairs.filter((p) => p.rollout.folder === 'archived_sessions').length;
      const coveredCompressed = pairs.filter((p) => p.rollout.compressed).length;
      ctx.findings.fact('Reconciliation', 'oracle sessions', oracle.entries.length);
      ctx.findings.fact('Reconciliation', 'sessions found in both', pairs.length);
      ctx.findings.fact(
        'Reconciliation',
        'compared sessions that are spawned subagents',
        coveredChildren,
      );
      ctx.findings.fact('Reconciliation', 'compared sessions that are archived', coveredArchived);
      ctx.findings.fact(
        'Reconciliation',
        'compared sessions that are compressed',
        coveredCompressed,
      );
      for (const x of tried)
        ctx.findings.fact(
          'Replay prefix rules tried',
          `sessions matching, rule ${x.marker}`,
          pairs.length - x.wrong.length,
        );
      ctx.findings.fact(
        'Replay prefix rules tried',
        'rules that reproduce the oracle',
        reproducing.length > 0 ? reproducing : ['nothing-matches'],
      );
      ctx.findings.fact('Reconciliation', 'sessions that differ (closest rule)', wrong.length);
      for (const d of wrong.slice(0, 20))
        ctx.findings.fact(
          'Reconciliation',
          `session ${d.ordinal} difference`,
          d.diffs.map((x) => `${x.label}${signed(x.by)}`),
        );
      for (const m of MARKERS)
        ctx.findings.note(
          `Replay prefix rule ${m}: a spawned child's snapshot is inherited when it is ${MARKER_TEXT[m]}.`,
        );

      if (wrong.length > 0) {
        const shown = wrong
          .slice(0, 3)
          .map(
            (d) =>
              `session ${d.ordinal}: ${d.diffs.map((x) => `${x.label} ${signed(x.by)}`).join(', ')}`,
          )
          .join('; ');
        reconcile = {
          verdict: 'fail',
          detail: `Sessions that differ from the oracle: ${wrong.length} of ${pairs.length}, under the closest rule ${closest.marker} (${shown}).`,
        };
        ctx.findings.note(
          'A session that Codex is still writing to can differ by a few tokens between the two reads. Run again when it is idle before changing the parser.',
        );
      } else if (pairs.length < MIN_SESSIONS) {
        reconcile = {
          verdict: 'not-run',
          detail: `Sessions in both the rollouts and the oracle: ${pairs.length}; ${MIN_SESSIONS} are needed.`,
        };
      } else if (coveredChildren === 0 || coveredArchived === 0) {
        reconcile = {
          verdict: 'not-run',
          detail: `Sessions that match: ${pairs.length}, but TECH asks for one spawned subagent and one archived session among them (spawned subagents: ${coveredChildren}, archived: ${coveredArchived}).`,
        };
      } else {
        reconcile = {
          verdict: 'pass',
          detail: safeText`Sessions compared: ${pairs.length}; all match the oracle to 0 tokens (spawned subagents: ${coveredChildren}, archived: ${coveredArchived}, compressed: ${coveredCompressed}). Replay prefix told apart by: ${reproducing}.`,
        };
      }
      say(`Sessions in both: ${pairs.length}; differing: ${wrong.length}`);
      say(`Replay prefix rules that reproduce the oracle: ${reproducing.join(', ') || 'none'}`);
      for (const d of wrong.slice(0, 3))
        say(
          `Session ${d.ordinal} differs: ${d.diffs.map((x) => `${x.label} ${signed(x.by)}`).join(', ')}`,
        );
    }
    ctx.findings.criterion(CRITERIA.reconcile, reconcile.verdict, reconcile.detail);

    const totals = totalsBy.get(rule)!;
    const sum = (pick: (t: Totals) => number): number =>
      [...totals.values()].reduce((n, t) => n + pick(t), 0);
    ctx.findings.fact('Replay baseline', 'rule these counts follow', rule);
    ctx.findings.fact(
      'Replay baseline',
      'snapshots classed as inherited from the parent',
      sum((t) => t.inherited),
    );
    ctx.findings.fact(
      'Replay baseline',
      'spawned subagent rollouts with an inherited prefix',
      children.filter((r) => (totals.get(r)?.inherited ?? 0) > 0).length,
    );
    ctx.findings.fact(
      'Replay baseline',
      'snapshots that could not be classified (unreadable)',
      sum((t) => t.unclassified),
    );
    ctx.findings.fact(
      'Replay baseline',
      'counter resets (a total went down)',
      sum((t) => t.resets),
    );
    ctx.findings.fact(
      'Replay baseline',
      'duplicate snapshots skipped',
      sum((t) => t.duplicates),
    );
    ctx.findings.fact(
      'Replay baseline',
      'snapshots whose last_token_usage differs from the cumulative change',
      rollouts.reduce((n, r) => {
        let previousTotal = 0;
        for (const s of r.snapshots) {
          const change = s.input + s.output - previousTotal;
          if (change > 0 && s.lastRequest !== null && s.lastRequest !== change) n++;
          previousTotal = s.input + s.output;
        }
        return n;
      }, 0),
    );

    // 5. Compressed rollouts.
    const decoded = compressed.filter((r) => r.state === 'ok');
    const zst: Verdicted =
      compressed.length === 0
        ? { verdict: 'not-run', detail: 'No `.jsonl.zst` rollout was found to read.' }
        : !decoder
          ? {
              verdict: 'not-run',
              detail: `This Node has no zstd decoder, so the compressed rollouts were left out (counted as unsupported: ${unsupported.length}).`,
            }
          : decoded.length < compressed.length
            ? {
                verdict: 'fail',
                detail: `Compressed rollouts that could not be decoded: ${compressed.length - decoded.length} of ${compressed.length}.`,
              }
            : {
                verdict: 'pass',
                detail: `Compressed rollouts decoded and read: ${decoded.length}.`,
              };
    ctx.findings.criterion(CRITERIA.zst, zst.verdict, zst.detail);

    // 6. Parent reference of spawned subagents.
    const ids = new Set(readable.map((r) => r.metaId).filter((id): id is string => id !== null));
    const withParent = children.filter((r) => r.parent !== null);
    const resolved = withParent.filter((r) => ids.has(r.parent!.value));
    ctx.findings.fact('Parent reference', 'spawned subagent rollouts', children.length);
    ctx.findings.fact('Parent reference', 'of those, naming a parent', withParent.length);
    ctx.findings.fact(
      'Parent reference',
      'of those, whose parent is a rollout read here',
      resolved.length,
    );
    ctx.findings.fact(
      'Parent reference',
      'fields that name the parent',
      [...seen.parentFields].sort(),
    );
    const parent: Verdicted =
      children.length === 0
        ? { verdict: 'not-run', detail: 'No spawned subagent rollout was found.' }
        : withParent.length < children.length
          ? {
              verdict: 'fail',
              detail: `Spawned subagent rollouts that name no parent: ${children.length - withParent.length} of ${children.length}; they would show as unknown.`,
            }
          : resolved.length === 0
            ? {
                verdict: 'fail',
                detail: `Spawned subagent rollouts: ${children.length}; they name a parent, but none of those parents is a rollout read here.`,
              }
            : {
                verdict: 'pass',
                detail: safeText`Spawned subagent rollouts: ${children.length}; naming a parent (field ${[...seen.parentFields].sort()}): ${withParent.length}; whose parent is a rollout read here: ${resolved.length}.`,
              };
    ctx.findings.criterion(CRITERIA.parent, parent.verdict, parent.detail);

    // 7. Session start against the first own token_count (a child's replayed prefix is not its own).
    const withUsage = readable.filter((r) => {
      const t = totalsFor(rule, r);
      return r.metaId !== null && t.unclassified === 0 && t.ownSnapshots > 0;
    });
    const startGaps: number[] = [];
    let startProblems = 0;
    for (const r of withUsage) {
      const first = totalsFor(rule, r).ownFirstAt;
      if (r.metaAt === null || first === null || r.metaAt > first) startProblems++;
      else startGaps.push(seconds(first - r.metaAt));
    }
    ctx.findings.fact('Session start', 'rollouts judged', withUsage.length);
    if (startGaps.length > 0) {
      ctx.findings.fact('Session start', 'gap seconds, first three', startGaps.slice(0, 3));
      ctx.findings.fact('Session start', 'gap seconds, smallest', Math.min(...startGaps));
      ctx.findings.fact('Session start', 'gap seconds, median', median(startGaps));
      ctx.findings.fact('Session start', 'gap seconds, largest', Math.max(...startGaps));
    }
    ctx.findings.fact(
      'Session start',
      'rollouts without a usable start or after their first usage',
      startProblems,
    );
    const start: Verdicted =
      startProblems > 0
        ? {
            verdict: 'fail',
            detail: `Rollouts with no session_meta timestamp at or before their first token_count: ${startProblems} of ${withUsage.length}.`,
          }
        : withUsage.length === 0
          ? {
              verdict: 'not-run',
              detail: 'No rollout with a session_meta and a token_count was read.',
            }
          : {
              verdict: 'pass',
              detail: safeText`Rollouts judged: ${withUsage.length}; every one starts at or before its first token_count; the gap is ${spread(startGaps)} seconds.`,
            };
    ctx.findings.criterion(CRITERIA.start, start.verdict, start.detail);

    // 8. thread/list: names and createdAt (needs `codex` on PATH).
    const listed = await listThreads(ctx);
    let names: Verdicted;
    let createdAt: Verdicted;
    if (listed.state !== 'ok') {
      const why = listed.state === 'absent' ? 'codex is not on PATH' : listed.reason;
      say(`thread/list: ${why}`);
      names = { verdict: 'not-run', detail: `thread/list was not available: ${why}.` };
      createdAt = { verdict: 'not-run', detail: `thread/list was not available: ${why}.` };
    } else {
      const { threads } = listed;
      const named = threads.filter((t) => t.named).length;
      ctx.findings.fact('thread/list', 'threads listed', threads.length);
      ctx.findings.fact('thread/list', 'pages read', listed.pages);
      ctx.findings.fact('thread/list', 'threads with a name', named);
      say(`thread/list: ${threads.length} threads, ${named} with a name`);
      names =
        threads.length === 0
          ? { verdict: 'not-run', detail: 'thread/list returned no threads.' }
          : named > 0
            ? {
                verdict: 'pass',
                detail: `Listed threads with a name: ${named} of ${threads.length}.`,
              }
            : {
                verdict: 'fail',
                detail: `Listed threads: ${threads.length}; none carries a name, so titles would be absent.`,
              };

      const matched = threads.flatMap((t) => {
        const rollout = t.id !== null ? rolloutById.get(t.id) : undefined;
        return rollout ? [{ thread: t, rollout }] : [];
      });
      const timed = matched.filter((m) => m.thread.createdAt !== null && m.rollout.metaAt !== null);
      const units = new Set(
        timed.map((m) => ((m.thread.createdAt ?? 0) > 1e11 ? 'milliseconds' : 'seconds')),
      );
      const gaps = timed.map((m) => {
        const created = m.thread.createdAt ?? 0;
        return seconds((created > 1e11 ? created : created * 1000) - (m.rollout.metaAt ?? 0));
      });
      ctx.findings.fact('thread/list', 'threads matching a rollout read here', matched.length);
      ctx.findings.fact('thread/list', 'matching threads with a createdAt', timed.length);
      ctx.findings.fact(
        'thread/list',
        'createdAt unit',
        units.size === 1 ? [...units][0]! : units.size === 0 ? 'unknown' : 'mixed',
      );
      if (gaps.length > 0) {
        ctx.findings.fact(
          'thread/list',
          'createdAt minus session_meta seconds, first three',
          gaps.slice(0, 3),
        );
        ctx.findings.fact(
          'thread/list',
          'createdAt minus session_meta seconds, smallest',
          Math.min(...gaps),
        );
        ctx.findings.fact(
          'thread/list',
          'createdAt minus session_meta seconds, median',
          median(gaps),
        );
        ctx.findings.fact(
          'thread/list',
          'createdAt minus session_meta seconds, largest',
          Math.max(...gaps),
        );
      }
      createdAt =
        matched.length === 0
          ? { verdict: 'not-run', detail: 'No listed thread matches a rollout read here.' }
          : timed.length === 0
            ? {
                verdict: 'fail',
                detail: `Listed threads matching a rollout: ${matched.length}; none carries a createdAt.`,
              }
            : {
                verdict: 'pass',
                detail: safeText`Matching threads with a createdAt: ${timed.length} of ${matched.length} (${units.size === 1 ? [...units][0]! : 'mixed units'}); it differs from session_meta by ${spread(gaps)} seconds.`,
              };
    }
    ctx.findings.criterion(CRITERIA.names, names.verdict, names.detail);
    ctx.findings.criterion(CRITERIA.createdAt, createdAt.verdict, createdAt.detail);

    if (!decoder && compressed.length > 0)
      ctx.findings.note(
        'Some rollouts are zstd-compressed and this Node has no zstd decoder, so they were counted as unsupported and left out. TECH: such files surface as partial coverage.',
      );
    if (rollouts.length === 0)
      ctx.findings.note('No Codex rollout was found in the folders checked.');
  },
});

runIfMain(import.meta, experiment);
