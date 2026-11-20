import { createReadStream } from 'node:fs';
import { relative, sep } from 'node:path';
import * as zlib from 'node:zlib';
import { classifyTranscript, projectRoots } from '../../src/server/collectors/claude/files.ts';
import { TranscriptScan } from '../../src/server/collectors/claude/transcript.ts';
import {
  findRollouts,
  threadIdFromName,
  type RolloutFile,
} from '../../src/server/collectors/codex/files.ts';
import { ownEvents } from '../../src/server/collectors/codex/replay.ts';
import {
  RolloutParser,
  classifySource,
  type ParsedRollout,
} from '../../src/server/collectors/codex/rollout.ts';
import {
  claudeConfigDirs,
  codexHomes,
  type DiscoveryEnv,
} from '../../src/server/collectors/discovery.ts';
import {
  LineReader,
  asRecord,
  asString,
  fileChunks,
  listFiles,
  parseJsonLine,
  parseTimestamp,
  tokenCount,
} from '../../src/server/collectors/ingest/index.ts';
import {
  differenceOf,
  sameEverywhere,
  type AppSession,
  type OracleSession,
  type ProviderId,
} from './reconcile.ts';

// `node scripts/reconcile-usage.ts --diagnose` (M5, G5_1 to G5_3): WHY a session's total differs from ccusage's, said in counts only.
//
// The reconcile report says THAT a session differs. The importer alone cannot say why: the deciding source files
// remain on the installation host. This diagnostic reads the same folders
// the importer reads and, for the sessions that differ, prints facts and token sums for each candidate explanation, and for every
// candidate how many of ALL matched sessions it would have got right. A candidate that gets them all right is the cause; none that
// does is itself a finding.
//
// Metadata only. It prints counts, token numbers, booleans, line-type names that are plain words, and the first eight characters of a
// session id. It never prints (and never keeps) a prompt, a reply, a title, a path, a working directory or a branch. A value it
// reports that came out of a file (a marker such as a history mode) is printed only when it is one short plain word, else as "present".
//
// The importers now follow ccusage's own rules (docs/implementation/ccusage-rules.md), so the first candidate for each provider IS the
// importer, computed with the importer's own code, and the self-check says this diagnostic read the same files as the importer. The
// others are alternatives a difference could come from; they are guesses at another way of counting, not facts about ccusage.
//   Codex   the importer today (as-built); the importer before it (previous-importer); replayed parent history not skipped
//           (no-prefix), skipped when it equals a parent snapshot, before the last session_meta, before the last ordinal decrease; and
//           compaction usage (`token_usage_record` lines whose response id matches a `compacted` line) not added, or added by `usage`,
//           by `turn_token_usage`, or every record added. The alternatives work on totals, which is how the importer once counted.
//   Claude  which copy of a message two transcripts both hold counts: the importer today (a main transcript beats a sidechain, then
//           the larger total, then the first path), the importer before it (earliest, a main transcript first, then path), first path,
//           larger total then first path, main first then first path, earliest then first path, latest, or every copy.
// What can still differ is counted beside them: Codex compaction events, replay skipped and cache-write tokens; Claude advisor entries,
// requestless entries and sidechain lines whose message a main-thread line also holds under another request id (ccusage-rules A5).

const MAX_SESSIONS = 8;
const WORD = /^[A-Za-z0-9._-]{1,16}$/;
const KIND = /^[a-z0-9_]{1,40}(\/[a-z0-9_]{1,40})?$/i;
const MODEL = /^(<synthetic>|[a-z0-9][a-z0-9._-]{0,39})$/i;

const label = (key: string): string => key.slice(0, 8);
const safeWord = (value: unknown): string | null => {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return typeof value === 'string' && WORD.test(value) ? value : null;
};
/** A marker's value for the report: the plain word it is, "present" when it is something else, "no" when it is not there. */
const sayMarker = (value: unknown): string =>
  value === undefined || value === null ? 'no' : (safeWord(value) ?? 'present');

// ---- reading lines ---------------------------------------------------------------------------------------------------------

async function* decodedChunks(path: string): AsyncGenerator<Buffer> {
  const source = createReadStream(path, { highWaterMark: 256 * 1024 });
  const decode = zlib.createZstdDecompress();
  source.on('error', (error) => decode.destroy(error));
  source.pipe(decode);
  try {
    for await (const chunk of decode) yield chunk as Buffer;
  } finally {
    source.destroy();
    decode.destroy();
  }
}

async function* textLines(path: string, compressed: boolean): AsyncGenerator<string> {
  const reader = new LineReader(compressed ? decodedChunks(path) : fileChunks(path, 0), {
    from: 0,
  });
  for await (const line of reader.lines()) yield line;
}

// ---- Codex ------------------------------------------------------------------------------------------------------------------

interface Five {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  total: number;
}
const ZERO: Five = { input: 0, cached: 0, output: 0, reasoning: 0, total: 0 };
const minus = (a: Five, b: Five): Five => ({
  input: a.input - b.input,
  cached: a.cached - b.cached,
  output: a.output - b.output,
  reasoning: a.reasoning - b.reasoning,
  total: a.total - b.total,
});
const snapKey = (t: Five): string => `${t.input}|${t.cached}|${t.output}|${t.reasoning}|${t.total}`;

/** The five cumulative fields of a `total_token_usage`; all five must be there (as the importer requires). */
function strictTotals(value: unknown): Five | null {
  const usage = asRecord(value);
  if (!usage) return null;
  const input = tokenCount(usage['input_tokens']);
  const cached = tokenCount(usage['cached_input_tokens']);
  const output = tokenCount(usage['output_tokens']);
  const reasoning = tokenCount(usage['reasoning_output_tokens']);
  const total = tokenCount(usage['total_tokens']);
  if (input === null || cached === null || output === null || reasoning === null || total === null)
    return null;
  return { input, cached, output, reasoning, total };
}

/** The figures of a `token_usage_record`'s usage object; a missing field counts as zero. Null when there is no object. */
function looseTotals(value: unknown): Five | null {
  const usage = asRecord(value);
  if (!usage) return null;
  const n = (key: string): number => tokenCount(usage[key]) ?? 0;
  return {
    input: n('input_tokens'),
    cached: n('cached_input_tokens'),
    output: n('output_tokens'),
    reasoning: n('reasoning_output_tokens'),
    total: n('total_tokens'),
  };
}

interface Snap {
  lineNo: number;
  at: number;
  totals: Five;
}
interface UsageRecord {
  responseId: string | null;
  usage: Five | null;
  turn: Five | null;
}
interface CodexRollout {
  threadId: string;
  compressed: boolean;
  archived: boolean;
  lines: number;
  unreadable: number;
  kinds: Map<string, number>;
  metaLines: number;
  lastMetaLine: number | null;
  startedAt: number | null;
  spawned: boolean;
  parentId: string | null;
  forkedFrom: unknown;
  parentThread: unknown;
  multiAgent: unknown;
  historyMode: unknown;
  snaps: Snap[];
  infoNull: number;
  noTotals: number;
  compactedLines: number;
  compacted: Set<string>;
  records: UsageRecord[];
  retained: number;
  retainedComplete: number;
  ordinalLines: number;
  ordinalDrops: number;
  lastOrdinalDropLine: number | null;
  modelSeen: boolean;
}

async function scanRollout(file: RolloutFile, threadId: string): Promise<CodexRollout> {
  const r: CodexRollout = {
    threadId,
    compressed: file.compressed,
    archived: file.path.includes(`${sep}archived_sessions${sep}`),
    lines: 0,
    unreadable: 0,
    kinds: new Map(),
    metaLines: 0,
    lastMetaLine: null,
    startedAt: null,
    spawned: false,
    parentId: null,
    forkedFrom: undefined,
    parentThread: undefined,
    multiAgent: undefined,
    historyMode: undefined,
    snaps: [],
    infoNull: 0,
    noTotals: 0,
    compactedLines: 0,
    compacted: new Set(),
    records: [],
    retained: 0,
    retainedComplete: 0,
    ordinalLines: 0,
    ordinalDrops: 0,
    lastOrdinalDropLine: null,
    modelSeen: false,
  };
  let previousOrdinal: number | null = null;
  for await (const text of textLines(file.path, file.compressed)) {
    r.lines += 1;
    const lineNo = r.lines;
    const line = parseJsonLine(text);
    if (line === null) {
      r.unreadable += 1;
      continue;
    }
    const type = asString(line['type']);
    const payload = asRecord(line['payload']);
    const sub = type === 'event_msg' ? asString(payload?.['type']) : null;
    const kindName = type === null ? '?' : sub === null ? type : `${type}/${sub}`;
    const kind = KIND.test(kindName) ? kindName : 'other';
    r.kinds.set(kind, (r.kinds.get(kind) ?? 0) + 1);

    const ordinal = line['ordinal'];
    if (typeof ordinal === 'number') {
      r.ordinalLines += 1;
      if (previousOrdinal !== null && ordinal < previousOrdinal) {
        r.ordinalDrops += 1;
        r.lastOrdinalDropLine = lineNo;
      }
      previousOrdinal = ordinal;
    }
    const retained = asRecord(asRecord(line['metadata'])?.['retained_source']);
    if (retained) {
      r.retained += 1;
      if (retained['complete'] === true) r.retainedComplete += 1;
    }

    if (type === 'session_meta' && payload) {
      r.metaLines += 1;
      r.lastMetaLine = lineNo;
      if (r.metaLines === 1) {
        const own = asString(payload['id']) ?? threadId;
        const source = classifySource(payload['source'], own);
        r.spawned = source.kind === 'spawned';
        r.parentId = source.kind === 'spawned' ? source.parentId : null;
        r.startedAt = parseTimestamp(payload['timestamp']) ?? parseTimestamp(line['timestamp']);
        r.forkedFrom = payload['forked_from_id'];
        r.parentThread = payload['parent_thread_id'];
        r.multiAgent = payload['multi_agent_version'];
        r.historyMode = payload['history_mode'];
      }
    } else if (type === 'turn_context' && payload) {
      if (asString(payload['model']) !== null) r.modelSeen = true;
    } else if (type === 'event_msg' && payload && sub === 'token_count') {
      const info = payload['info'];
      if (info === null) r.infoNull += 1;
      else {
        const totals = strictTotals(asRecord(info)?.['total_token_usage']);
        const at = parseTimestamp(line['timestamp']);
        if (totals === null || at === null) r.noTotals += 1;
        else r.snaps.push({ lineNo, at, totals });
      }
    } else if (type === 'compacted' && payload) {
      r.compactedLines += 1;
      const id = asString(payload['compaction_response_id']);
      if (id !== null) r.compacted.add(id);
    } else if (type === 'token_usage_record' && payload) {
      r.records.push({
        responseId: asString(payload['response_id']),
        usage: looseTotals(payload['usage']),
        turn: looseTotals(payload['turn_token_usage']),
      });
    }
  }
  return r;
}

/** The provider total of a rollout under a rule for what is inherited: the sum of the differences between snapshots, as the importer takes them. */
function totalUnder(
  snaps: readonly Snap[],
  inherited: (snap: Snap, index: number) => boolean,
): number {
  let previous: Five | null = null;
  let baseline: Five | null = null;
  let sum = 0;
  snaps.forEach((snap, index) => {
    if (inherited(snap, index)) {
      baseline = snap.totals;
      return;
    }
    let delta = minus(snap.totals, previous ?? baseline ?? ZERO);
    if (Object.values(delta).some((n) => n < 0)) delta = snap.totals; // a counter that started over
    if (delta.total === 0) return;
    previous = snap.totals;
    sum += delta.input + delta.output;
  });
  return sum;
}

const REPLAY_RULES = [
  'previous-importer',
  'no-prefix',
  'equals-a-parent-snapshot',
  'before-last-session_meta',
  'before-last-ordinal-decrease',
] as const;
const ADDONS = ['none', '+matching usage', '+matching turn usage', '+all usage'] as const;
type ReplayRule = (typeof REPLAY_RULES)[number];
type Addon = (typeof ADDONS)[number];

function leadingEqualToParent(child: CodexRollout, parent: CodexRollout | undefined): number {
  if (!parent) return 0;
  const parents = new Set(parent.snaps.map((s) => snapKey(s.totals)));
  let n = 0;
  while (n < child.snaps.length && parents.has(snapKey(child.snaps[n]!.totals))) n += 1;
  return n;
}

function replayTotal(r: CodexRollout, rule: ReplayRule, parent: CodexRollout | undefined): number {
  switch (rule) {
    case 'previous-importer':
      return totalUnder(r.snaps, (s) => r.spawned && r.startedAt !== null && s.at < r.startedAt);
    case 'no-prefix':
      return totalUnder(r.snaps, () => false);
    case 'equals-a-parent-snapshot': {
      const k = leadingEqualToParent(r, parent);
      return totalUnder(r.snaps, (_s, i) => i < k);
    }
    case 'before-last-session_meta': {
      const boundary = r.metaLines > 1 ? r.lastMetaLine : null;
      return totalUnder(r.snaps, (s) => boundary !== null && s.lineNo < boundary);
    }
    case 'before-last-ordinal-decrease': {
      const boundary = r.lastOrdinalDropLine;
      return totalUnder(r.snaps, (s) => boundary !== null && s.lineNo < boundary);
    }
  }
}

const inPlusOut = (t: Five | null): number => (t === null ? 0 : t.input + t.output);

function addonTotal(r: CodexRollout, addon: Addon): number {
  const matching = r.records.filter(
    (rec) => rec.responseId !== null && r.compacted.has(rec.responseId),
  );
  switch (addon) {
    case 'none':
      return 0;
    case '+matching usage':
      return matching.reduce((n, rec) => n + inPlusOut(rec.usage), 0);
    case '+matching turn usage':
      return matching.reduce((n, rec) => n + inPlusOut(rec.turn), 0);
    case '+all usage':
      return r.records.reduce((n, rec) => n + inPlusOut(rec.usage), 0);
  }
}

export interface RuleCell {
  rule: string;
  addon: string;
  /** The total under this rule minus ccusage's: 0 means the rule reproduces ccusage for this session. */
  difference: number;
}

export interface CodexSessionFacts {
  label: string;
  total: number;
  oracleTotal: number;
  spawned: boolean;
  lines: number;
  kinds: [string, number][];
  snapshots: number;
  infoNull: number;
  noTotals: number;
  repeated: number;
  resets: number;
  compactedLines: number;
  records: number;
  recordsMatchingCompacted: number;
  matchingUsageTokens: number;
  matchingTurnTokens: number;
  allUsageTokens: number;
  metaLines: number;
  forkedFrom: string;
  parentThread: string;
  parentReadHere: boolean;
  multiAgent: string;
  historyMode: string;
  retained: number;
  retainedComplete: number;
  ordinalLines: number;
  ordinalDrops: number;
  leadingEqualToParent: number;
  /** What the importer made of this rollout (the production parser and replay code): its events, the compaction ones, the copied ones skipped. */
  importerEvents: number;
  importerCompactionEvents: number;
  importerSkippedAsReplay: number;
  importerCacheWriteTokens: number;
  grid: RuleCell[];
}

export interface OnlyInAppFacts {
  label: string;
  total: number;
  /** Codex: whether a turn_context named a model, and how many snapshots. Claude: the model names it holds. */
  detail: string;
}

export interface RuleTally {
  rule: string;
  addon: string;
  matches: number;
}

export interface ProviderDiagnosis {
  provider: ProviderId;
  /** Matched sessions the rules were tried on. */
  matched: number;
  /** Files read for this diagnosis. */
  filesRead: number;
  /** Matched sessions whose own total the diagnostic's re-reading of the importer's rule did not reproduce (should be 0). */
  selfCheckMismatches: number;
  /** Every candidate rule, by how many of the matched sessions it gets exactly right (most first). */
  tallies: RuleTally[];
  differing: number;
  codex: CodexSessionFacts[];
  claude: ClaudeSessionFacts[];
  onlyInApp: OnlyInAppFacts[];
  onlyInAppCount: number;
  onlyInOracle: number;
}

async function diagnoseCodex(
  env: DiscoveryEnv,
  home: string,
  app: readonly AppSession[],
  oracle: readonly OracleSession[],
): Promise<ProviderDiagnosis> {
  const found = await findRollouts(codexHomes({ env, home }));
  const files = found.outcome === 'files' ? found.files : [];
  const rollouts = new Map<string, CodexRollout>();
  for (const file of files) {
    const id = threadIdFromName(file.path);
    if (id === null) continue;
    rollouts.set(id, await scanRollout(file, id));
  }
  // The importer's own reading of every rollout, in path order: the production parser, replay filter and compaction rule.
  const parsed = new Map<string, ParsedRollout>();
  for (const file of files) {
    const id = threadIdFromName(file.path);
    if (id === null) continue;
    const parser = new RolloutParser();
    for await (const text of textLines(file.path, file.compressed)) parser.push(text);
    parsed.set(id, parser.finish());
  }
  const importer = new Map<
    string,
    { total: number; events: number; compaction: number; skipped: number; cacheWrite: number }
  >();
  const seenResponses = new Set<string>();
  for (const [id, p] of parsed) {
    const parent = p.fork ? (parsed.get(p.fork.parentId.toLowerCase()) ?? null) : null;
    const own = ownEvents(p, parent);
    const row = {
      total: 0,
      events: 0,
      compaction: 0,
      skipped: p.events.length - own.length,
      cacheWrite: 0,
    };
    for (const e of own) {
      if (e.responseId !== null) {
        if (seenResponses.has(e.responseId)) continue;
        seenResponses.add(e.responseId);
        row.compaction += 1;
      }
      row.total += e.providerTotal;
      row.events += 1;
      row.cacheWrite += e.cacheWrite;
    }
    importer.set(id, row);
  }
  const theirs = new Map(oracle.map((s) => [s.key, s]));
  const matched = app.filter((s) => theirs.has(s.key));
  const parentOf = (r: CodexRollout): CodexRollout | undefined => {
    const id = asString(r.forkedFrom) ?? asString(r.parentThread) ?? r.parentId;
    return id === null ? undefined : rollouts.get(id.toLowerCase());
  };

  const cells = new Map<string, number>(); // `${rule}\u0000${addon}` -> sessions reproduced
  let mismatches = 0;
  const perSession = new Map<string, RuleCell[]>();
  for (const session of matched) {
    const r = rollouts.get(session.key);
    const want = theirs.get(session.key)!.figures['total'] ?? 0;
    if (!r) continue;
    const parent = parentOf(r);
    const grid: RuleCell[] = [];
    const today = importer.get(session.key)?.total ?? 0;
    if (today !== (session.figures['total'] ?? 0)) mismatches += 1;
    grid.push({ rule: 'as-built', addon: 'none', difference: today - want });
    if (today === want) cells.set('as-built\u0000none', (cells.get('as-built\u0000none') ?? 0) + 1);
    for (const rule of REPLAY_RULES) {
      const base = replayTotal(r, rule, parent);
      for (const addon of ADDONS) {
        const difference = base + addonTotal(r, addon) - want;
        grid.push({ rule, addon, difference });
        if (difference === 0) {
          const k = `${rule}\u0000${addon}`;
          cells.set(k, (cells.get(k) ?? 0) + 1);
        }
      }
    }
    perSession.set(session.key, grid);
  }
  const tallies: RuleTally[] = [
    { rule: 'as-built', addon: 'none', matches: cells.get('as-built\u0000none') ?? 0 },
    ...REPLAY_RULES.flatMap((rule) =>
      ADDONS.map((addon) => ({ rule, addon, matches: cells.get(`${rule}\u0000${addon}`) ?? 0 })),
    ),
  ].sort((a, b) => b.matches - a.matches);

  const differing = matched
    .map((s) => ({ s, diff: differenceOf('codex', s.figures, theirs.get(s.key)!.figures) }))
    .filter(({ diff }) => !sameEverywhere('codex', diff))
    .sort((a, b) => Math.abs(b.diff['total'] ?? 0) - Math.abs(a.diff['total'] ?? 0));
  const facts: CodexSessionFacts[] = [];
  for (const { s } of differing.slice(0, MAX_SESSIONS)) {
    const r = rollouts.get(s.key);
    if (!r) continue;
    const parent = parentOf(r);
    const keys = new Map<string, number>();
    for (const snap of r.snaps)
      keys.set(snapKey(snap.totals), (keys.get(snapKey(snap.totals)) ?? 0) + 1);
    const matching = r.records.filter(
      (rec) => rec.responseId !== null && r.compacted.has(rec.responseId),
    );
    facts.push({
      label: label(s.key),
      total: s.figures['total'] ?? 0,
      oracleTotal: theirs.get(s.key)!.figures['total'] ?? 0,
      spawned: r.spawned,
      lines: r.lines,
      kinds: [...r.kinds].sort((a, b) => b[1] - a[1]).slice(0, 10),
      snapshots: r.snaps.length,
      infoNull: r.infoNull,
      noTotals: r.noTotals,
      repeated: [...keys.values()].reduce((n, c) => n + (c - 1), 0),
      resets: r.snaps.filter((snap, i) => {
        const before = r.snaps[i - 1];
        return (
          before !== undefined &&
          Object.values(minus(snap.totals, before.totals)).some((n) => n < 0)
        );
      }).length,
      compactedLines: r.compactedLines,
      records: r.records.length,
      recordsMatchingCompacted: matching.length,
      matchingUsageTokens: matching.reduce((n, rec) => n + inPlusOut(rec.usage), 0),
      matchingTurnTokens: matching.reduce((n, rec) => n + inPlusOut(rec.turn), 0),
      allUsageTokens: r.records.reduce((n, rec) => n + inPlusOut(rec.usage), 0),
      metaLines: r.metaLines,
      forkedFrom: sayMarker(r.forkedFrom),
      parentThread: sayMarker(r.parentThread),
      parentReadHere: parent !== undefined,
      multiAgent: sayMarker(r.multiAgent),
      historyMode: sayMarker(r.historyMode),
      retained: r.retained,
      retainedComplete: r.retainedComplete,
      ordinalLines: r.ordinalLines,
      ordinalDrops: r.ordinalDrops,
      leadingEqualToParent: leadingEqualToParent(r, parent),
      importerEvents: importer.get(s.key)?.events ?? 0,
      importerCompactionEvents: importer.get(s.key)?.compaction ?? 0,
      importerSkippedAsReplay: importer.get(s.key)?.skipped ?? 0,
      importerCacheWriteTokens: importer.get(s.key)?.cacheWrite ?? 0,
      grid: perSession.get(s.key) ?? [],
    });
  }
  const only = app.filter((s) => !theirs.has(s.key));
  return {
    provider: 'codex',
    matched: matched.length,
    filesRead: rollouts.size,
    selfCheckMismatches: mismatches,
    tallies,
    differing: differing.length,
    codex: facts,
    claude: [],
    onlyInApp: only.slice(0, MAX_SESSIONS).map((s) => {
      const r = rollouts.get(s.key);
      return {
        label: label(s.key),
        total: s.figures['total'] ?? 0,
        detail: r
          ? `${r.snaps.length} snapshots, a turn_context named a model: ${r.modelSeen ? 'yes' : 'no'}, ${r.spawned ? 'spawned' : 'not spawned'}, ${r.compressed ? 'compressed' : 'plain'}, ${r.archived ? 'archived' : 'active'}`
          : 'its rollout was not found by this run',
      };
    }),
    onlyInAppCount: only.length,
    onlyInOracle: oracle.filter((o) => !app.some((a) => a.key === o.key)).length,
  };
}

// ---- Claude Code ------------------------------------------------------------------------------------------------------------

interface ClaudeEvent {
  key: string;
  at: number;
  total: number;
  model: string;
  /** A sidechain's: the line says so, or the file is a subagent's. */
  sidechain: boolean;
}
interface ClaudeFile {
  path: string;
  main: boolean;
  group: string;
  events: ClaudeEvent[];
}

const OWNER_RULES = [
  'importer today (main over sidechain, larger total, first path)',
  'previous importer (earliest, main first, then path)',
  'first path',
  'larger total, then first path',
  'main first, then first path',
  'earliest, then first path',
  'latest',
  'every copy counts',
] as const;
type OwnerRule = (typeof OWNER_RULES)[number];

interface Copy {
  file: number;
  at: number;
  total: number;
  sidechain: boolean;
}

const byPath = (files: readonly ClaudeFile[], a: Copy, b: Copy, direction = 1): number =>
  direction *
  (files[a.file]!.path < files[b.file]!.path
    ? -1
    : files[a.file]!.path > files[b.file]!.path
      ? 1
      : 0);

function ownersFor(files: readonly ClaudeFile[], copies: readonly Copy[], rule: OwnerRule): Copy[] {
  if (rule === 'every copy counts') return [...copies];
  const rank = (c: Copy): number => (files[c.file]!.main ? 0 : 1);
  const side = (c: Copy): number => Number(c.sidechain);
  const order: Record<Exclude<OwnerRule, 'every copy counts'>, (a: Copy, b: Copy) => number> = {
    'importer today (main over sidechain, larger total, first path)': (a, b) =>
      side(a) - side(b) || b.total - a.total || byPath(files, a, b),
    'previous importer (earliest, main first, then path)': (a, b) =>
      a.at - b.at || rank(a) - rank(b) || byPath(files, a, b),
    'first path': (a, b) => byPath(files, a, b),
    'larger total, then first path': (a, b) => b.total - a.total || byPath(files, a, b),
    'main first, then first path': (a, b) => rank(a) - rank(b) || byPath(files, a, b),
    'earliest, then first path': (a, b) => a.at - b.at || byPath(files, a, b),
    latest: (a, b) => b.at - a.at || byPath(files, a, b),
  };
  const winner = [...copies].sort(order[rule])[0];
  return winner ? [winner] : [];
}

export interface ClaudeSessionFacts {
  label: string;
  total: number;
  oracleTotal: number;
  mainFiles: number;
  subagentFiles: number;
  messages: number;
  sharedMessages: number;
  sharedTokens: number;
  sharedWithSessions: number;
  /** What can still differ (counts of lines, not text): advisor entries, entries with no request id, and sidechain lines whose message a main-thread line holds under another request id (A5). */
  advisorEntries: number;
  requestlessEntries: number;
  sidechainReplayCandidates: number;
  grid: RuleCell[];
}

/**
 * Sidechain entries of these files whose message id a main-thread entry anywhere also holds, under a DIFFERENT request id: the shape
 * ccusage's sidechain-replay rule (A5) merges and this importer does not. A count only; nothing is assumed from it.
 */
function sidechainReplays(mine: readonly ClaudeFile[], all: readonly ClaudeFile[]): number {
  const idOf = (key: string): string => key.split(':')[0] ?? key;
  const mainKeys = new Map<string, Set<string>>();
  for (const file of all)
    for (const e of file.events)
      if (!e.sidechain && !e.key.includes(':advisor:')) {
        const set = mainKeys.get(idOf(e.key)) ?? new Set<string>();
        set.add(e.key);
        mainKeys.set(idOf(e.key), set);
      }
  let count = 0;
  for (const file of mine)
    for (const e of file.events) {
      const held = mainKeys.get(idOf(e.key));
      if (e.sidechain && held !== undefined && !held.has(e.key)) count += 1;
    }
  return count;
}

async function diagnoseClaude(
  env: DiscoveryEnv,
  home: string,
  app: readonly AppSession[],
  oracle: readonly OracleSession[],
): Promise<ProviderDiagnosis> {
  const files: ClaudeFile[] = [];
  for (const root of await projectRoots(claudeConfigDirs({ env, home }))) {
    const listing = await listFiles(root, (rel) => classifyTranscript(rel) !== null);
    for (const file of listing.files) {
      const found = classifyTranscript(relative(root, file.path).split(sep).join('/'));
      if (found === null) continue;
      const scan = new TranscriptScan(found.kind === 'main' ? found.sessionId : found.parentId);
      for await (const text of textLines(file.path, false)) scan.add(text);
      files.push({
        path: file.path,
        main: found.kind === 'main',
        group: (found.kind === 'main' ? found.sessionId : found.parentId).toLowerCase(),
        events: [...scan.events.values()].map((e) => ({
          key: e.dedupeKey,
          at: e.occurredAt,
          total: e.total,
          model: e.model,
          sidechain: e.sidechain || found.kind === 'subagent',
        })),
      });
    }
  }
  const copiesOf = new Map<string, Copy[]>();
  files.forEach((file, index) => {
    for (const e of file.events) {
      const list = copiesOf.get(e.key) ?? [];
      list.push({ file: index, at: e.at, total: e.total, sidechain: e.sidechain });
      copiesOf.set(e.key, list);
    }
  });
  const totalsUnder = (rule: OwnerRule): Map<string, number> => {
    const out = new Map<string, number>();
    for (const copies of copiesOf.values())
      for (const owner of ownersFor(files, copies, rule)) {
        const group = files[owner.file]!.group;
        out.set(group, (out.get(group) ?? 0) + owner.total);
      }
    return out;
  };
  const underRule = new Map(OWNER_RULES.map((rule) => [rule, totalsUnder(rule)]));

  const theirs = new Map(oracle.map((s) => [s.key, s]));
  const matched = app.filter((s) => theirs.has(s.key));
  const tally = new Map<OwnerRule, number>();
  let mismatches = 0;
  for (const session of matched) {
    const want = theirs.get(session.key)!.figures['total'] ?? 0;
    for (const rule of OWNER_RULES) {
      const got = underRule.get(rule)!.get(session.key) ?? 0;
      if (got === want) tally.set(rule, (tally.get(rule) ?? 0) + 1);
      if (rule === OWNER_RULES[0] && got !== (session.figures['total'] ?? 0)) mismatches += 1;
    }
  }
  const tallies: RuleTally[] = OWNER_RULES.map((rule) => ({
    rule,
    addon: '',
    matches: tally.get(rule) ?? 0,
  })).sort((a, b) => b.matches - a.matches);

  const differing = matched
    .map((s) => ({ s, diff: differenceOf('claude', s.figures, theirs.get(s.key)!.figures) }))
    .filter(({ diff }) => !sameEverywhere('claude', diff))
    .sort((a, b) => Math.abs(b.diff['total'] ?? 0) - Math.abs(a.diff['total'] ?? 0));
  const facts: ClaudeSessionFacts[] = differing.slice(0, MAX_SESSIONS).map(({ s }) => {
    const mine = files.filter((f) => f.group === s.key);
    const keys = new Set(mine.flatMap((f) => f.events.map((e) => e.key)));
    let sharedMessages = 0;
    let sharedTokens = 0;
    const others = new Set<string>();
    for (const key of keys) {
      const copies = copiesOf.get(key) ?? [];
      const elsewhere = copies.filter((c) => files[c.file]!.group !== s.key);
      if (elsewhere.length === 0) continue;
      sharedMessages += 1;
      sharedTokens += copies.find((c) => files[c.file]!.group === s.key)?.total ?? 0;
      for (const c of elsewhere) others.add(files[c.file]!.group);
    }
    const want = theirs.get(s.key)!.figures['total'] ?? 0;
    return {
      label: label(s.key),
      total: s.figures['total'] ?? 0,
      oracleTotal: want,
      mainFiles: mine.filter((f) => f.main).length,
      subagentFiles: mine.filter((f) => !f.main).length,
      messages: keys.size,
      sharedMessages,
      sharedTokens,
      sharedWithSessions: others.size,
      advisorEntries: [...keys].filter((k) => k.includes(':advisor:')).length,
      requestlessEntries: [...keys].filter((k) => k.includes('::')).length,
      sidechainReplayCandidates: sidechainReplays(mine, files),
      grid: OWNER_RULES.map((rule) => ({
        rule,
        addon: '',
        difference: (underRule.get(rule)!.get(s.key) ?? 0) - want,
      })),
    };
  });
  const only = app.filter((s) => !theirs.has(s.key));
  return {
    provider: 'claude',
    matched: matched.length,
    filesRead: files.length,
    selfCheckMismatches: mismatches,
    tallies,
    differing: differing.length,
    codex: [],
    claude: facts,
    onlyInApp: only.slice(0, MAX_SESSIONS).map((s) => {
      const mine = files.filter((f) => f.group === s.key);
      const models = new Set(mine.flatMap((f) => f.events.map((e) => e.model)));
      const safe = [...models].map((m) => (MODEL.test(m) ? m : 'other')).sort();
      return {
        label: label(s.key),
        total: s.figures['total'] ?? 0,
        detail: `${mine.length} file${mine.length === 1 ? '' : 's'}, ${mine.reduce((n, f) => n + f.events.length, 0)} messages, models: ${safe.join(', ') || 'none'}`,
      };
    }),
    onlyInAppCount: only.length,
    onlyInOracle: oracle.filter((o) => !app.some((a) => a.key === o.key)).length,
  };
}

// ---- the whole diagnosis ----------------------------------------------------------------------------------------------------

export interface DiagnoseMaterial {
  app: Record<ProviderId, readonly AppSession[]>;
  /** ccusage's sessions per provider, or null when its report could not be read (nothing to diagnose then). */
  oracle: Record<ProviderId, readonly OracleSession[] | null>;
}

export async function diagnose(options: {
  env: DiscoveryEnv;
  home: string;
  material: DiagnoseMaterial;
}): Promise<(ProviderDiagnosis | { provider: ProviderId; reason: string })[]> {
  const out: (ProviderDiagnosis | { provider: ProviderId; reason: string })[] = [];
  for (const provider of ['codex', 'claude'] as const) {
    const oracle = options.material.oracle[provider];
    if (oracle === null) {
      out.push({
        provider,
        reason: 'there is no ccusage report for this provider, so there is nothing to explain.',
      });
      continue;
    }
    const app = options.material.app[provider];
    out.push(
      provider === 'codex'
        ? await diagnoseCodex(options.env, options.home, app, oracle)
        : await diagnoseClaude(options.env, options.home, app, oracle),
    );
  }
  return out;
}

// ---- the text ---------------------------------------------------------------------------------------------------------------

const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));
const NAMES: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex' };

function renderGrid(
  cells: readonly RuleCell[],
  columns: readonly string[],
  rows: readonly string[],
): string[] {
  const lines: string[] = [];
  if (columns.length > 1) lines.push(`      columns: ${columns.join(' | ')}`);
  for (const row of rows) {
    const mine = cells.filter((c) => c.rule === row);
    lines.push(`      ${row.padEnd(46)} ${mine.map((c) => signed(c.difference)).join(' | ')}`);
  }
  return lines;
}

/** The diagnosis as text: numbers, booleans and plain words; the first eight characters of session ids. */
export function renderDiagnosis(
  diagnoses: readonly (ProviderDiagnosis | { provider: ProviderId; reason: string })[],
): string {
  const lines: string[] = [
    'Diagnosis (counts only). The candidate rules are guesses at how ccusage works; a rule that reproduces every matched session would be the cause.',
    '',
  ];
  for (const d of diagnoses) {
    const name = NAMES[d.provider];
    if ('reason' in d) {
      lines.push(`${name}: NOT DIAGNOSED, ${d.reason}`, '');
      continue;
    }
    lines.push(
      `${name}: ${d.filesRead} files read, ${d.matched} sessions matched, ${d.differing} differ, ${d.onlyInAppCount} only in the app, ${d.onlyInOracle} only in ccusage.`,
      d.selfCheckMismatches === 0
        ? "  Self-check: this diagnostic reproduces the importer's own total for every matched session."
        : `  Self-check FAILED for ${d.selfCheckMismatches} session(s): this diagnostic does not reproduce the importer there, so read its other numbers with care.`,
      `  Candidate rules by matched sessions reproduced exactly (of ${d.matched}):`,
    );
    for (const t of d.tallies.slice(0, 10))
      lines.push(
        `    ${String(t.matches).padStart(5)}  ${t.rule}${t.addon === '' ? '' : `, ${t.addon}`}`,
      );
    for (const c of d.codex) {
      lines.push(
        `  ${c.label}  total ${c.total} (ccusage ${c.oracleTotal}), difference ${signed(c.total - c.oracleTotal)}; ${c.spawned ? 'a spawned thread' : 'not a spawned thread'}`,
        `    ${c.lines} lines; kinds: ${c.kinds.map(([k, n]) => `${k} ${n}`).join(', ')}`,
        `    snapshots ${c.snapshots} (info null ${c.infoNull}, without totals ${c.noTotals}, repeated ${c.repeated}, counter resets ${c.resets}); compacted lines ${c.compactedLines}; usage records ${c.records}, ${c.recordsMatchingCompacted} match a compacted line`,
        `    record tokens (input + output): matching usage ${c.matchingUsageTokens}, matching turn usage ${c.matchingTurnTokens}, all usage ${c.allUsageTokens}`,
        `    markers: session_meta lines ${c.metaLines}; forked_from_id ${c.forkedFrom}; parent_thread_id ${c.parentThread}; parent rollout read here ${c.parentReadHere ? 'yes' : 'no'}; multi_agent_version ${c.multiAgent}; history_mode ${c.historyMode}; retained_source lines ${c.retained} (complete ${c.retainedComplete}); ordinal lines ${c.ordinalLines} (decreases ${c.ordinalDrops})`,
        `    leading snapshots equal to a parent's: ${c.leadingEqualToParent} of ${c.snapshots}`,
        `    what the importer made of it: ${c.importerEvents} events, ${c.importerCompactionEvents} compaction, ${c.importerSkippedAsReplay} skipped as copied from a parent, ${c.importerCacheWriteTokens} cache-write tokens inside its input`,
        "    total under each rule minus ccusage's (0 = reproduces it):",
        ...renderGrid(c.grid, ADDONS, ['as-built', ...REPLAY_RULES]),
      );
    }
    for (const c of d.claude) {
      lines.push(
        `  ${c.label}  total ${c.total} (ccusage ${c.oracleTotal}), difference ${signed(c.total - c.oracleTotal)}; ${c.mainFiles} main + ${c.subagentFiles} subagent files, ${c.messages} messages`,
        `    messages also held by another session's files: ${c.sharedMessages} (${c.sharedTokens} tokens), with ${c.sharedWithSessions} other session(s)`,
        `    what can still differ: advisor entries ${c.advisorEntries}; entries with no request id ${c.requestlessEntries}; sidechain lines whose message a main-thread line holds under another request id ${c.sidechainReplayCandidates}`,
        "    total under each rule for who owns a shared message, minus ccusage's (0 = reproduces it):",
        ...renderGrid(c.grid, [''], OWNER_RULES),
      );
    }
    if (d.onlyInApp.length > 0) {
      lines.push(
        `  Only in the app (${d.onlyInAppCount}${d.onlyInAppCount > d.onlyInApp.length ? `, first ${d.onlyInApp.length} shown` : ''}):`,
      );
      for (const o of d.onlyInApp) lines.push(`    ${o.label}  total ${o.total}; ${o.detail}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
