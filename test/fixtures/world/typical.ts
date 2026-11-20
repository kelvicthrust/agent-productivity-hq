import { addDays, isoWeekday } from '../../../src/shared/domain/periods.ts';
import type { ClaudeTokens, CodexTokens } from '../../../src/shared/domain/tokens.ts';
import { hex4, pad2, rng } from './rng.ts';
import type { World, WorldLink, WorldPr, WorldSession } from './types.ts';

// A faithful port of generate() and typicalWorld() in docs/design/prototype/data.js. The random draws happen in the same
// order, so the sessions, tokens and PRs are the prototype's. test/fixtures/prototype-parity.test.ts runs both and compares.

export const TODAY = '2026-11-04';
export const LOOKBACK_START = '2025-11-05'; // the prototype's "trailing 12 months"
export const CODEX_FROM = '2026-02-02';
export const CLAUDE_FROM = '2026-03-14';
export const PASEO_FROM = '2026-04-20';
export const ZERO_DAYS = new Set(['2026-11-01']);
export const ME = 'kelvin';
export const TIMEZONE = 'America/Los_Angeles';

export const REPOS = [
  'kelvin/atlas-api',
  'kelvin/atlas-web',
  'kelvin/notes-cli',
  'open-tools/shared-schemas',
];
const REPO_W = [0.36, 0.3, 0.19, 0.15];
const UNTRACKED = 'kelvin/dotfiles';
const START_NUM: Record<string, number> = {
  'kelvin/atlas-api': 180,
  'kelvin/atlas-web': 120,
  'kelvin/notes-cli': 20,
  'open-tools/shared-schemas': 340,
};
const MODELS = {
  codex: ['gpt-5-codex', 'gpt-5-codex-mini'],
  claude: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
};
const AGENTS = ['planner', 'implementer', 'reviewer', 'tester', 'researcher', 'docs'];
const OTHERS = ['jmoreno', 'priya-s', 'dependabot[bot]'];
const TITLES = [
  'Add retry backoff to sync worker',
  'Extract session parser module',
  'Fix timezone bucketing at DST change',
  'Paginate merged PR import',
  'Cache provider model list',
  'Tighten repo URL validation',
  'Add empty state for no repos',
  'Normalize cached-token categories',
  'Refactor filter state into URL',
  'Improve error copy for denied access',
  'Add weekly aggregation tests',
  'Handle renamed repositories',
  'Speed up tree expansion',
  'Add keyboard nav to chart',
  'Persist owner link corrections',
  'Dedupe archived session copies',
  'Add CSV export of PR table',
  'Upgrade schema validator',
  'Fix off-by-one in month buckets',
  'Split API client by provider',
  'Add health check endpoint',
  'Remove unused feature flag',
  'Document local data retention',
  'Guard against duplicate repo adds',
  'Show last refresh per source',
  'Add reduced-motion support',
  'Fix flaky merge-time test',
  'Index sessions by repo and date',
  'Add Paseo workspace labels',
  'Improve chart table alternative',
  'Handle squash-merge commit matching',
  'Clarify account window labels',
];

export const BASIS_TEXT = {
  prReference: 'PR reference recorded in session',
  commitMatch: 'Session commit matches merged commit',
  sameRepoWindow: 'Same repo · active within 48 h before merge',
  owner: 'Confirmed by you',
} as const;

export function tokensFor(
  provider: 'codex' | 'claude',
  r: () => number,
  scale: number,
): (CodexTokens | ClaudeTokens) & { total: number } {
  if (provider === 'codex') {
    const input = Math.round((150e3 + r() * 1.4e6) * scale);
    const output = Math.round((8e3 + r() * 60e3) * scale);
    const cachedInput = Math.round(input * (0.55 + r() * 0.3));
    const reasoning = Math.round(output * (0.3 + r() * 0.4));
    return { input, cachedInput, output, reasoning, total: input + output }; // cached ⊂ input, reasoning ⊂ output
  }
  const inputUncached = Math.round((3e3 + r() * 40e3) * scale);
  const cacheWrite = Math.round((40e3 + r() * 300e3) * scale);
  const cacheRead = Math.round((300e3 + r() * 3.5e6) * scale);
  const output = Math.round((8e3 + r() * 90e3) * scale);
  return {
    inputUncached,
    cacheWrite,
    cacheRead,
    output,
    total: inputUncached + cacheWrite + cacheRead + output,
  };
}

export function generateTypical(): World {
  const r = rng(20261104);
  const sessions: WorldSession[] = [];
  const prs: WorldPr[] = [];
  let sid = 0;
  let dayIndex = 0;

  const count = (mean: number) => {
    const x = mean * (0.5 + r());
    let n = Math.floor(x);
    if (r() < x - n) n++;
    return n;
  };
  const pickRepo = (): string | null => {
    const x = r();
    if (x < 0.07) return null;
    if (x < 0.15) return UNTRACKED;
    const y = r();
    let acc = 0;
    for (let i = 0; i < REPOS.length; i++) {
      acc += REPO_W[i]!;
      if (y < acc) return REPOS[i]!;
    }
    return REPOS[0]!;
  };
  const time = (lo: number, hi: number) =>
    `${pad2(lo + Math.floor(r() * (hi - lo)))}:${pad2(Math.floor(r() * 60))}`;

  const make = (o: {
    date: string;
    time: string;
    provider: 'codex' | 'claude';
    repo: string | null;
    role: WorldSession['role'];
    parent?: string | null;
    kind: WorldSession['kind'];
    paseo?: WorldSession['paseo'];
    model?: string;
  }): WorldSession => {
    sid++;
    const model =
      o.model ?? MODELS[o.provider][Math.floor(r() * (o.provider === 'codex' ? 2 : 3))]!;
    const ref = `${o.provider === 'codex' ? 'thread ' : 'session '}${hex4(r)}…${hex4(r)}`;
    const session: WorldSession = {
      key: `s${sid}`,
      provider: o.provider,
      date: o.date,
      time: o.time,
      model,
      repo: o.repo,
      role: o.role,
      parentKey: o.parent ?? null,
      kind: o.kind,
      paseo: o.paseo ?? null,
      ref,
      tokens: tokensFor(o.provider, r, o.role === 'root' ? 1 : 0.4),
      events: 0,
    };
    sessions.push(session);
    return session;
  };

  for (let d = LOOKBACK_START; d <= TODAY; d = addDays(d, 1), dayIndex++) {
    if (ZERO_DAYS.has(d)) continue;
    const weekday = isoWeekday(d);
    const weekend = weekday >= 6;
    if (weekend && r() < 0.25) continue; // some genuinely idle weekend days
    const intensity = weekend ? 0.35 : 1;
    const g = 0.6 + (0.6 * dayIndex) / 365;

    for (const prov of ['codex', 'claude'] as const) {
      const from = prov === 'codex' ? CODEX_FROM : CLAUDE_FROM;
      if (d < from) continue;
      const roots = count((prov === 'codex' ? 1.5 : 2.0) * intensity * g);
      for (let k = 0; k < roots; k++) {
        const repo = pickRepo();
        const usePaseo = d >= PASEO_FROM && r() < 0.65;
        const root = make({
          date: d,
          time: time(8, 22),
          provider: prov,
          repo,
          role: 'root',
          kind: usePaseo ? 'paseo' : 'standalone',
          paseo: usePaseo
            ? {
                agent: 'planner',
                workspace: `${repo ? repo.split('/')[1] : 'scratch'} · wt-${1 + Math.floor(r() * 3)}`,
              }
            : null,
        });
        const kids = usePaseo ? count(2.2) : count(0.5);
        for (let c = 0; c < kids; c++) {
          let childProv: 'codex' | 'claude' = usePaseo
            ? r() < 0.45
              ? prov === 'codex'
                ? 'claude'
                : 'codex'
              : prov
            : prov;
          if (childProv === 'claude' && d < CLAUDE_FROM) childProv = prov;
          const unknownParent = usePaseo && r() < 0.08;
          const agentName = `${AGENTS[1 + Math.floor(r() * (AGENTS.length - 1))]!}-${c + 1}`;
          make({
            date: d,
            time: root.time,
            provider: childProv,
            repo,
            role: unknownParent ? 'unknown' : 'child',
            parent: unknownParent ? null : root.key,
            kind: usePaseo ? 'paseo' : 'native',
            paseo: usePaseo ? { agent: agentName, workspace: root.paseo!.workspace } : null,
          });
        }
      }
    }

    // merged PRs (GitHub history for tracked repos is available across the full lookback)
    const nMine = count(1.1 * intensity * (0.8 + (0.4 * dayIndex) / 365));
    const nOther = count(0.28 * intensity);
    for (let m = 0; m < nMine + nOther; m++) {
      const mine = m < nMine;
      const y = r();
      let acc = 0;
      let prRepo = REPOS[0]!;
      for (let q = 0; q < REPOS.length; q++) {
        acc += REPO_W[q]!;
        if (y < acc) {
          prRepo = REPOS[q]!;
          break;
        }
      }
      const author = mine ? ME : OTHERS[Math.floor(r() * OTHERS.length)]!;
      const mergedBy = mine
        ? r() < 0.8
          ? ME
          : 'priya-s'
        : author === 'dependabot[bot]'
          ? ME
          : author;
      const pr: WorldPr = {
        repo: prRepo,
        number: 0,
        title: TITLES[Math.floor(r() * TITLES.length)]!,
        date: d,
        time: time(10, 23),
        author,
        mergedBy,
        links: [],
      };
      if (mine) {
        const lo = addDays(d, -2);
        const cands = sessions.filter((s) => s.repo === prRepo && s.date >= lo && s.date <= d);
        if (cands.length) {
          const roll = r();
          const pick = () => cands[Math.floor(r() * cands.length)]!;
          const link = (s: WorldSession, cls: WorldLink['cls'], basis: string) =>
            pr.links.push({ sessionKey: s.key, cls, basis });
          if (roll < 0.48) {
            const a = pick();
            link(a, 'evidence', r() < 0.5 ? BASIS_TEXT.prReference : BASIS_TEXT.commitMatch);
            if (cands.length > 1 && r() < 0.5) {
              const b = pick();
              if (b.key !== a.key) link(b, 'evidence', BASIS_TEXT.commitMatch);
            }
            if (cands.length > 2 && r() < 0.25) {
              const c = pick();
              if (!pr.links.some((l) => l.sessionKey === c.key))
                link(c, 'suggested', BASIS_TEXT.sameRepoWindow);
            }
          } else if (roll < 0.68) {
            link(pick(), 'suggested', BASIS_TEXT.sameRepoWindow);
          } else if (roll < 0.78) {
            link(pick(), 'owner', BASIS_TEXT.owner);
          }
        }
      }
      prs.push(pr);
    }
  }

  // ---- curated showcase records (deterministic) for the most recent week ----
  const cur = (o: {
    id: string;
    date: string;
    time: string;
    provider: 'codex' | 'claude';
    model: string;
    repo: string | null;
    role: WorldSession['role'];
    parent?: string;
    kind: WorldSession['kind'];
    paseo?: WorldSession['paseo'];
    ref: string;
  }) => {
    sessions.push({
      key: o.id,
      provider: o.provider,
      date: o.date,
      time: o.time,
      model: o.model,
      repo: o.repo,
      role: o.role,
      parentKey: o.parent ?? null,
      kind: o.kind,
      paseo: o.paseo ?? null,
      ref: o.ref,
      tokens: tokensFor(o.provider, r, o.role === 'root' ? 1 : 0.4),
      events: 0,
    });
  };
  // Showcase records sit inside the default "This week" period (Mon Nov 2 – Sun Nov 8, "today" = Wed Nov 4) so the first
  // screen demonstrates every link class and a multi-provider Paseo tree.
  const w = (agent: string, workspace: string) => ({ agent, workspace });
  cur({
    id: 'c1',
    date: '2026-11-02',
    time: '09:14',
    provider: 'codex',
    model: 'gpt-5-codex',
    repo: 'kelvin/atlas-api',
    role: 'root',
    kind: 'paseo',
    paseo: w('planner', 'atlas-api · wt-1'),
    ref: 'thread 7f3a…2c91',
  });
  cur({
    id: 'c2',
    date: '2026-11-02',
    time: '09:31',
    provider: 'claude',
    model: 'claude-sonnet-5-5',
    repo: 'kelvin/atlas-api',
    role: 'child',
    parent: 'c1',
    kind: 'paseo',
    paseo: w('implementer-1', 'atlas-api · wt-1'),
    ref: 'session 41be…0d7a',
  });
  cur({
    id: 'c3',
    date: '2026-11-02',
    time: '10:02',
    provider: 'codex',
    model: 'gpt-5-codex-mini',
    repo: 'kelvin/atlas-api',
    role: 'child',
    parent: 'c1',
    kind: 'paseo',
    paseo: w('tester-2', 'atlas-api · wt-1'),
    ref: 'thread 9c04…e1f8',
  });
  cur({
    id: 'c4',
    date: '2026-11-03',
    time: '14:20',
    provider: 'claude',
    model: 'claude-opus-5-5',
    repo: 'kelvin/atlas-web',
    role: 'root',
    kind: 'standalone',
    ref: 'session d2a7…551c',
  });
  cur({
    id: 'c5',
    date: '2026-11-03',
    time: '14:40',
    provider: 'claude',
    model: 'claude-haiku-5-5',
    repo: 'kelvin/atlas-web',
    role: 'child',
    parent: 'c4',
    kind: 'native',
    ref: 'session d2a7…551c · subagent',
  });
  cur({
    id: 'c6',
    date: '2026-11-02',
    time: '11:05',
    provider: 'codex',
    model: 'gpt-5-codex',
    repo: 'kelvin/notes-cli',
    role: 'root',
    kind: 'standalone',
    ref: 'thread 2b6e…a0f3',
  });
  cur({
    id: 'c7',
    date: '2026-11-03',
    time: '16:30',
    provider: 'claude',
    model: 'claude-sonnet-5-5',
    repo: 'kelvin/atlas-api',
    role: 'unknown',
    kind: 'paseo',
    paseo: w('reviewer-3', 'atlas-api · wt-2'),
    ref: 'session 88f1…3b2e',
  });
  cur({
    id: 'c8',
    date: '2026-11-03',
    time: '20:10',
    provider: 'codex',
    model: 'gpt-5-codex',
    repo: null,
    role: 'root',
    kind: 'standalone',
    ref: 'thread 5e19…c47d',
  });
  cur({
    id: 'c9',
    date: '2026-11-04',
    time: '08:50',
    provider: 'claude',
    model: 'claude-opus-5-5',
    repo: 'kelvin/atlas-web',
    role: 'root',
    kind: 'paseo',
    paseo: w('planner', 'atlas-web · wt-1'),
    ref: 'session a91c…7e02',
  });
  cur({
    id: 'c10',
    date: '2026-11-04',
    time: '09:05',
    provider: 'codex',
    model: 'gpt-5-codex',
    repo: 'kelvin/atlas-web',
    role: 'child',
    parent: 'c9',
    kind: 'paseo',
    paseo: w('implementer-1', 'atlas-web · wt-1'),
    ref: 'thread 0d3f…b8a6',
  });

  const curPr = (o: Omit<WorldPr, 'number'>) => prs.push({ ...o, number: 0 });
  const L = (sessionKey: string, cls: WorldLink['cls'], basis: string): WorldLink => ({
    sessionKey,
    cls,
    basis,
  });
  curPr({
    repo: 'kelvin/atlas-api',
    title: 'Split usage importer into provider adapters',
    date: '2026-11-02',
    time: '17:42',
    author: ME,
    mergedBy: ME,
    links: [
      L('c1', 'evidence', BASIS_TEXT.prReference),
      L('c2', 'evidence', BASIS_TEXT.commitMatch),
      L('c3', 'suggested', BASIS_TEXT.sameRepoWindow),
    ],
  });
  curPr({
    repo: 'kelvin/atlas-web',
    title: 'Add coverage rail to trends chart',
    date: '2026-11-03',
    time: '19:05',
    author: ME,
    mergedBy: 'priya-s',
    links: [L('c4', 'owner', BASIS_TEXT.owner)],
  });
  curPr({
    repo: 'kelvin/notes-cli',
    title: 'Handle archived sessions in export',
    date: '2026-11-02',
    time: '18:20',
    author: ME,
    mergedBy: ME,
    links: [L('c6', 'suggested', BASIS_TEXT.sameRepoWindow)],
  });
  curPr({
    repo: 'kelvin/atlas-api',
    title: 'Bump schema validator to 4.2',
    date: '2026-11-03',
    time: '10:11',
    author: 'dependabot[bot]',
    mergedBy: ME,
    links: [],
  });
  curPr({
    repo: 'kelvin/atlas-api',
    title: 'Retry GitHub sync on secondary rate limit',
    date: '2026-11-03',
    time: '21:40',
    author: ME,
    mergedBy: ME,
    links: [],
  });
  curPr({
    repo: 'open-tools/shared-schemas',
    title: 'Document cache token categories',
    date: '2026-11-02',
    time: '15:00',
    author: 'jmoreno',
    mergedBy: 'jmoreno',
    links: [],
  });
  curPr({
    repo: 'kelvin/atlas-web',
    title: 'Show subscription window beside selected period',
    date: '2026-11-04',
    time: '11:30',
    author: ME,
    mergedBy: ME,
    links: [
      L('c9', 'evidence', BASIS_TEXT.prReference),
      L('c10', 'evidence', BASIS_TEXT.commitMatch),
    ],
  });

  // number PRs per repo in merge order
  prs.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const nums = { ...START_NUM };
  for (const p of prs) {
    nums[p.repo] = (nums[p.repo] ?? 0) + 1;
    p.number = nums[p.repo]!;
  }

  // account-reported Codex usage (fixture): broader than this machine
  const winStart = '2026-10-05';
  const winEnd = '2026-11-03';
  let localCodex = 0;
  for (const s of sessions)
    if (s.provider === 'codex' && s.date >= winStart && s.date <= winEnd)
      localCodex += s.tokens.total;

  return {
    today: TODAY,
    timezone: TIMEZONE,
    lookbackStart: LOOKBACK_START,
    me: ME,
    codexFrom: CODEX_FROM,
    claudeFrom: CLAUDE_FROM,
    paseoFrom: PASEO_FROM,
    repos: [
      ...REPOS.map((id) => ({ id, tracking: 'active' as const, access: 'ok' as const })),
      {
        id: 'kelvin/archive-private',
        tracking: 'active' as const,
        access: 'inaccessible' as const,
        accessError:
          'GitHub no longer grants your connection access to this repository. Its earlier history is kept.',
      },
    ],
    sessions,
    prs,
    chatgptWindow: {
      start: winStart,
      end: winEnd,
      total: Math.round((localCodex * 1.31) / 1e5) * 1e5,
    },
  };
}
