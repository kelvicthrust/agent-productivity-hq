import type { SessionFigures } from '../../src/server/db/queries/ingest.ts';

// The comparison behind `node scripts/reconcile-usage.ts` (M5, G5_3): the app's stored totals for a few sessions against what
// `ccusage --json --offline` says for the same sessions, category by category. ccusage is only the oracle (it is never a
// dependency), and the report is metadata only: counts, token numbers and the first eight characters of a session's id. No prompt,
// reply, path, project name or timestamp is ever printed.
//
// How a session is matched (checked on invented data against ccusage 20.0.48, see test/fixtures/*/README.md):
//   Claude Code  ccusage folds a subagent's usage into its parent session by LOCATION, so an app session is its root plus every
//                child stored under it (`<root>:<agent>`). Matched on the session id.
//   Codex        one session per rollout, matched on the thread id at the end of the rollout's name. ccusage reports `inputTokens`
//                without the cached and cache-write parts and `cacheReadTokens` and `cacheCreationTokens` as those parts; the app
//                stores input WITH them (provider total = input + output, the owner-confirmed rule), so the app's cached and
//                cache-write parts are taken out of its input for the comparison.
// Anything that does not match is reported as "only here" or "only in ccusage", never forced to.

export type ProviderId = 'claude' | 'codex';

export const CATEGORIES: Record<ProviderId, readonly string[]> = {
  claude: ['input', 'cacheWrite', 'cacheRead', 'output', 'total'],
  codex: ['input', 'cacheWrite', 'cacheRead', 'output', 'reasoning', 'total'],
};

export type Figures = Record<string, number>;

export interface OracleSession {
  key: string;
  figures: Figures;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The id a session is matched on: the last UUID in the text (a path or a file name may carry one), else the text itself. */
function keyOf(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue;
    const found = candidate.match(UUID);
    if (found && found.length > 0) return found[found.length - 1]!.toLowerCase();
  }
  const plain = candidates.find((c): c is string => typeof c === 'string' && c !== '');
  return plain ? plain.toLowerCase() : null;
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/** The session rows of a ccusage report, whichever of its known shapes it has; null when there are none to read. */
export function sessionRows(report: unknown): Record<string, unknown>[] | null {
  const pick = (value: unknown): Record<string, unknown>[] | null =>
    Array.isArray(value) ? (value as Record<string, unknown>[]) : null;
  if (Array.isArray(report)) return pick(report);
  if (report === null || typeof report !== 'object') return null;
  const record = report as Record<string, unknown>;
  return pick(record['sessions']) ?? pick(record['session']) ?? pick(record['data']);
}

/** ccusage's Claude Code session report, as figures per session id. */
export function parseClaudeReport(report: unknown): OracleSession[] | null {
  const rows = sessionRows(report);
  if (rows === null) return null;
  const out: OracleSession[] = [];
  for (const row of rows) {
    const key = keyOf(row['sessionId'], row['session'], row['id']);
    if (key === null) continue;
    out.push({
      key,
      figures: {
        input: count(row['inputTokens']),
        cacheWrite: count(row['cacheCreationTokens']),
        cacheRead: count(row['cacheReadTokens']),
        output: count(row['outputTokens']),
        total: count(row['totalTokens']),
      },
    });
  }
  return out;
}

/** ccusage's Codex session report, as figures per thread id. */
export function parseCodexReport(report: unknown): OracleSession[] | null {
  const rows = sessionRows(report);
  if (rows === null) return null;
  const out: OracleSession[] = [];
  for (const row of rows) {
    const key = keyOf(row['sessionFile'], row['sessionId'], row['session'], row['id']);
    if (key === null) continue;
    out.push({
      key,
      figures: {
        input: count(row['inputTokens']),
        cacheWrite: count(row['cacheCreationTokens']),
        cacheRead: count(row['cacheReadTokens']),
        output: count(row['outputTokens']),
        reasoning: count(row['reasoningOutputTokens']),
        total: count(row['totalTokens']),
      },
    });
  }
  return out;
}

export interface AppSession {
  key: string;
  figures: Figures;
  /** More than one stored session stands behind it (Claude Code: the root and its subagents). */
  members: number;
  /** A Claude Code session with subagents, or a Codex thread that spawned another or was spawned by one. */
  spawned: boolean;
  /** A Codex thread spawned by another: it starts with its parent's history replayed, the part E2 is most likely to get wrong. */
  child: boolean;
  startedAt: number;
  startedBasis: string;
  firstEventAt: number | null;
}

/** The app's stored sessions, grouped and normalised the way ccusage reports them. */
export function appSessions(provider: ProviderId, stored: readonly SessionFigures[]): AppSession[] {
  if (provider === 'codex') {
    const parents = new Set(stored.map((s) => s.parentProviderSessionId).filter(Boolean));
    return stored.map((s) => ({
      key: s.providerSessionId.toLowerCase(),
      figures: {
        input: s.input - s.cachedInput - s.cacheWrite,
        cacheWrite: s.cacheWrite,
        cacheRead: s.cachedInput,
        output: s.output,
        reasoning: s.reasoning,
        total: s.total,
      },
      members: 1,
      spawned: s.kind === 'child' || parents.has(s.providerSessionId),
      child: s.kind === 'child',
      startedAt: s.startedAt,
      startedBasis: s.startedBasis,
      firstEventAt: s.firstEventAt,
    }));
  }
  const groups = new Map<string, SessionFigures[]>();
  for (const s of stored) {
    const root = (s.providerSessionId.split(':')[0] ?? s.providerSessionId).toLowerCase();
    groups.set(root, [...(groups.get(root) ?? []), s]);
  }
  return [...groups].map(([key, members]) => {
    const sum = (pick: (s: SessionFigures) => number) => members.reduce((n, s) => n + pick(s), 0);
    const main = members.find((s) => !s.providerSessionId.includes(':')) ?? members[0]!;
    return {
      key,
      figures: {
        input: sum((s) => s.input),
        cacheWrite: sum((s) => s.cacheWrite),
        cacheRead: sum((s) => s.cacheRead),
        output: sum((s) => s.output),
        total: sum((s) => s.total),
      },
      members: members.length,
      spawned: members.length > 1,
      child: false,
      startedAt: main.startedAt,
      startedBasis: main.startedBasis,
      firstEventAt: main.firstEventAt,
    };
  });
}

export interface Compared {
  /** The first eight characters of the session id, and why it was picked. */
  label: string;
  why: string;
  app: Figures;
  oracle: Figures;
  /** app minus ccusage, per category. */
  difference: Figures;
  /** Seconds from the stored start to the first usage; null when the session has none. Positive: the start is earlier. */
  startGapSeconds: number | null;
  startedBasis: string;
}

export interface ProviderReport {
  provider: ProviderId;
  state: 'compared' | 'not-run';
  /** For `not-run`: why, in a sentence with no file content. */
  reason?: string;
  appSessions: number;
  oracleSessions: number;
  matched: number;
  onlyInApp: number;
  onlyInOracle: number;
  /** Over every matched session, not only the three: how many differ in any category. */
  differing: number;
  compared: Compared[];
  /** The largest differences among all matched sessions (total tokens, absolute), for finding a pattern. */
  worst: { label: string; total: number }[];
}

export const sameEverywhere = (provider: ProviderId, difference: Figures): boolean =>
  CATEGORIES[provider].every((category) => difference[category] === 0);

export function differenceOf(provider: ProviderId, app: Figures, oracle: Figures): Figures {
  const out: Figures = {};
  for (const category of CATEGORIES[provider])
    out[category] = (app[category] ?? 0) - (oracle[category] ?? 0);
  return out;
}

/**
 * Three sessions of a provider to compare with ccusage: the largest, one with subagents (Claude Code) or a spawned or parent
 * thread (Codex: its replayed prefix is the part E2 is most likely to get wrong) when there is one, and the next largest.
 * Only sessions both sides list can be compared.
 */
export function compareProvider(
  provider: ProviderId,
  app: readonly AppSession[],
  oracle: readonly OracleSession[],
  want = 3,
): ProviderReport {
  const theirs = new Map(oracle.map((s) => [s.key, s]));
  const matched = app
    .filter((s) => theirs.has(s.key))
    .sort((a, b) => (b.figures['total'] ?? 0) - (a.figures['total'] ?? 0));
  const taken = new Set<string>();
  const chosen: { session: AppSession; why: string }[] = [];
  const take = (session: AppSession | undefined, why: string) => {
    if (!session || taken.has(session.key) || chosen.length >= want) return;
    taken.add(session.key);
    chosen.push({ session, why });
  };
  take(matched[0], 'largest');
  // A Codex child comes first (its replayed prefix is the risky part), then any parent; a Claude session with subagents.
  take(
    matched.find((s) => !taken.has(s.key) && s.child) ??
      matched.find((s) => !taken.has(s.key) && s.spawned),
    provider === 'claude' ? 'with subagents' : 'spawned thread or its parent',
  );
  for (const session of matched) take(session, 'next largest');

  const compared = chosen.map(({ session, why }): Compared => {
    const other = theirs.get(session.key)!;
    return {
      label: session.key.slice(0, 8),
      why,
      app: session.figures,
      oracle: other.figures,
      difference: differenceOf(provider, session.figures, other.figures),
      startGapSeconds:
        session.firstEventAt === null
          ? null
          : Math.round((session.firstEventAt - session.startedAt) / 1000),
      startedBasis: session.startedBasis,
    };
  });
  const differences = matched.map((s) => ({
    label: s.key.slice(0, 8),
    difference: differenceOf(provider, s.figures, theirs.get(s.key)!.figures),
  }));
  const differing = differences.filter((d) => !sameEverywhere(provider, d.difference));
  return {
    provider,
    state: 'compared',
    appSessions: app.length,
    oracleSessions: oracle.length,
    matched: matched.length,
    onlyInApp: app.length - matched.length,
    onlyInOracle: oracle.filter((s) => !app.some((a) => a.key === s.key)).length,
    differing: differing.length,
    compared,
    worst: differing
      .map((d) => ({ label: d.label, total: d.difference['total'] ?? 0 }))
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
      .slice(0, 5),
  };
}

export function notRun(provider: ProviderId, reason: string, appCount = 0): ProviderReport {
  return {
    provider,
    state: 'not-run',
    reason,
    appSessions: appCount,
    oracleSessions: 0,
    matched: 0,
    onlyInApp: 0,
    onlyInOracle: 0,
    differing: 0,
    compared: [],
    worst: [],
  };
}

/** True when no compared session differs in any category. A provider that did not run, or compared none, is not a pass. */
export function providerPasses(report: ProviderReport): boolean {
  return (
    report.state === 'compared' &&
    report.compared.length > 0 &&
    report.compared.every((c) => sameEverywhere(report.provider, c.difference))
  );
}

/** True when a compared session differs by even one token. A `not-run` provider is not a failure (it is reported as not run). */
export function providerFails(report: ProviderReport): boolean {
  return (
    report.state === 'compared' &&
    report.compared.some((c) => !sameEverywhere(report.provider, c.difference))
  );
}

const NAMES: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex' };
const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));

/** The report as text. Numbers and eight-character id prefixes only. */
export function renderReport(reports: readonly ProviderReport[], wanted = 3): string {
  const lines: string[] = [];
  for (const report of reports) {
    const name = NAMES[report.provider];
    if (report.state === 'not-run') {
      lines.push(`${name}: NOT RUN. ${report.reason ?? ''}`.trim(), '');
      continue;
    }
    lines.push(
      `${name}: the app holds ${report.appSessions} sessions, ccusage lists ${report.oracleSessions}, ${report.matched} match by id` +
        ` (${report.onlyInApp} only in the app, ${report.onlyInOracle} only in ccusage).`,
    );
    for (const c of report.compared) {
      const cells = CATEGORIES[report.provider].map(
        (category) => `${category} ${signed(c.difference[category] ?? 0)}`,
      );
      const gap =
        c.startGapSeconds === null
          ? 'no usage'
          : `start ${c.startGapSeconds >= 0 ? `${c.startGapSeconds} s before` : `${-c.startGapSeconds} s after`} the first usage (${c.startedBasis})`;
      lines.push(
        `  ${c.label}  ${c.why}: total ${c.app['total'] ?? 0} (ccusage ${c.oracle['total'] ?? 0}); difference ${cells.join(', ')}; ${gap}`,
      );
    }
    if (report.compared.length < wanted) {
      lines.push(
        `  Only ${report.compared.length} session${report.compared.length === 1 ? '' : 's'} could be compared; the goal names ${wanted}.`,
      );
    }
    lines.push(
      `  Over all ${report.matched} matching sessions, ${report.differing} differ in some category` +
        (report.worst.length > 0
          ? `; the largest total differences: ${report.worst.map((w) => `${w.label} ${signed(w.total)}`).join(', ')}.`
          : '.'),
      providerPasses(report)
        ? `  RESULT: 0-token difference on all ${report.compared.length} compared sessions.`
        : providerFails(report)
          ? '  RESULT: DIFFERENCE. A real difference is a finding: send these lines back.'
          : '  RESULT: nothing was compared.',
      '',
    );
  }
  return lines.join('\n');
}
