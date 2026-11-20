import { addDays, isoWeekday } from '../../../src/shared/domain/periods.ts';
import { pad2, rng, hex4 } from './rng.ts';
import {
  BASIS_TEXT,
  CLAUDE_FROM,
  CODEX_FROM,
  LOOKBACK_START,
  ME,
  PASEO_FROM,
  REPOS,
  TIMEZONE,
  TODAY,
  ZERO_DAYS,
  tokensFor,
} from './typical.ts';
import type { World, WorldLink, WorldPr, WorldSession } from './types.ts';

// The measured world of TECH › Performance: a synthetic year of 150,000 usage events, 6,000 sessions and 2,000 merged PRs
// across 6 repos. Driven by counts, not by per-day means, so the totals are exact and the same on every run.

export const YEAR_TARGET = { events: 150_000, sessions: 6_000, prs: 2_000 } as const;

const YEAR_REPOS = [...REPOS, 'kelvin/infra', 'kelvin/design-system'];
const YEAR_WEIGHTS = [0.28, 0.24, 0.14, 0.1, 0.14, 0.1];
const START_NUM: Record<string, number> = {
  'kelvin/atlas-api': 180,
  'kelvin/atlas-web': 120,
  'kelvin/notes-cli': 20,
  'open-tools/shared-schemas': 340,
  'kelvin/infra': 60,
  'kelvin/design-system': 15,
};
const MODELS = {
  codex: ['gpt-5-codex', 'gpt-5-codex-mini'],
  claude: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
};
const AGENTS = ['implementer', 'reviewer', 'tester', 'researcher', 'docs'];
const OTHERS = ['jmoreno', 'priya-s', 'dependabot[bot]'];
const TITLES = [
  'Add retry backoff',
  'Extract parser module',
  'Fix timezone bucketing',
  'Paginate import',
  'Cache model list',
  'Tighten URL validation',
  'Add empty state',
  'Normalize token categories',
  'Refactor filter state',
  'Improve error copy',
  'Add aggregation tests',
  'Handle renamed repositories',
  'Speed up tree expansion',
  'Add keyboard navigation',
  'Persist link corrections',
  'Dedupe archived copies',
  'Add CSV export',
  'Upgrade validator',
  'Fix month buckets',
  'Split API client',
  'Add health check',
  'Remove unused flag',
  'Document retention',
  'Guard duplicate adds',
];

export function generateYear(): World {
  const r = rng(20261105);
  const days: { date: string; weight: number }[] = [];
  let dayIndex = 0;
  for (let d = LOOKBACK_START; d <= TODAY; d = addDays(d, 1), dayIndex++) {
    if (ZERO_DAYS.has(d)) continue;
    const weekend = isoWeekday(d) >= 6;
    days.push({ date: d, weight: (weekend ? 0.35 : 1) * (0.6 + (0.6 * dayIndex) / 365) });
  }

  /** A weighted draw of a day from `from` onward. */
  const dayPicker = (from: string) => {
    const eligible = days.filter((d) => d.date >= from);
    const cumulative: number[] = [];
    let sum = 0;
    for (const d of eligible) cumulative.push((sum += d.weight));
    return () => {
      const x = r() * sum;
      let lo = 0;
      let hi = cumulative.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumulative[mid]! < x) lo = mid + 1;
        else hi = mid;
      }
      return eligible[lo]!.date;
    };
  };
  const pickCodexDay = dayPicker(CODEX_FROM);
  const pickClaudeDay = dayPicker(CLAUDE_FROM);
  const pickAnyDay = dayPicker(LOOKBACK_START);

  const pickRepo = (): string | null => {
    const x = r();
    if (x < 0.06) return null;
    if (x < 0.14) return 'kelvin/dotfiles';
    const y = r();
    let acc = 0;
    for (let i = 0; i < YEAR_REPOS.length; i++) {
      acc += YEAR_WEIGHTS[i]!;
      if (y < acc) return YEAR_REPOS[i]!;
    }
    return YEAR_REPOS[0]!;
  };
  const time = (lo: number, hi: number) =>
    `${pad2(lo + Math.floor(r() * (hi - lo)))}:${pad2(Math.floor(r() * 60))}`;

  const sessions: WorldSession[] = [];
  const byRepoDate = new Map<string, WorldSession[]>();
  const make = (
    o: Omit<WorldSession, 'key' | 'model' | 'ref' | 'tokens' | 'events'>,
  ): WorldSession => {
    const model = MODELS[o.provider][Math.floor(r() * (o.provider === 'codex' ? 2 : 3))]!;
    const session: WorldSession = {
      ...o,
      key: `s${sessions.length + 1}`,
      model,
      ref: `${o.provider === 'codex' ? 'thread ' : 'session '}${hex4(r)}…${hex4(r)}`,
      tokens: tokensFor(o.provider, r, o.role === 'root' ? 1 : 0.4),
      events: 0,
    };
    sessions.push(session);
    if (o.repo) {
      const key = `${o.repo}|${o.date}`;
      byRepoDate.set(key, [...(byRepoDate.get(key) ?? []), session]);
    }
    return session;
  };
  const count = (mean: number) => {
    const x = mean * (0.5 + r());
    let n = Math.floor(x);
    if (r() < x - n) n++;
    return n;
  };

  while (sessions.length < YEAR_TARGET.sessions) {
    const provider: 'codex' | 'claude' = r() < 0.4 ? 'codex' : 'claude';
    const date = provider === 'codex' ? pickCodexDay() : pickClaudeDay();
    const repo = pickRepo();
    const usePaseo = date >= PASEO_FROM && r() < 0.65;
    const root = make({
      provider,
      date,
      time: time(8, 22),
      repo,
      role: 'root',
      parentKey: null,
      kind: usePaseo ? 'paseo' : 'standalone',
      paseo: usePaseo
        ? {
            agent: 'planner',
            workspace: `${repo ? repo.split('/')[1] : 'scratch'} · wt-${1 + Math.floor(r() * 3)}`,
          }
        : null,
    });
    const kids = Math.min(
      usePaseo ? count(2.2) : count(0.5),
      YEAR_TARGET.sessions - sessions.length,
    );
    for (let c = 0; c < kids; c++) {
      let childProvider: 'codex' | 'claude' = usePaseo
        ? r() < 0.45
          ? provider === 'codex'
            ? 'claude'
            : 'codex'
          : provider
        : provider;
      if (childProvider === 'claude' && date < CLAUDE_FROM) childProvider = provider;
      const unknownParent = usePaseo && r() < 0.08;
      const agent = `${AGENTS[Math.floor(r() * AGENTS.length)]!}-${c + 1}`;
      make({
        provider: childProvider,
        date,
        time: root.time,
        repo,
        role: unknownParent ? 'unknown' : 'child',
        parentKey: unknownParent ? null : root.key,
        kind: usePaseo ? 'paseo' : 'native',
        paseo: usePaseo ? { agent, workspace: root.paseo!.workspace } : null,
      });
    }
  }

  const prs: WorldPr[] = [];
  for (let i = 0; i < YEAR_TARGET.prs; i++) {
    const date = pickAnyDay();
    const y = r();
    let acc = 0;
    let repo = YEAR_REPOS[0]!;
    for (let q = 0; q < YEAR_REPOS.length; q++) {
      acc += YEAR_WEIGHTS[q]!;
      if (y < acc) {
        repo = YEAR_REPOS[q]!;
        break;
      }
    }
    const mine = r() < 0.8;
    const author = mine ? ME : OTHERS[Math.floor(r() * OTHERS.length)]!;
    const mergedBy = mine
      ? r() < 0.8
        ? ME
        : 'priya-s'
      : author === 'dependabot[bot]'
        ? ME
        : author;
    const pr: WorldPr = {
      repo,
      number: 0,
      title: TITLES[Math.floor(r() * TITLES.length)]!,
      date,
      time: time(10, 23),
      author,
      mergedBy,
      links: [],
    };
    if (mine) {
      const cands = [0, 1, 2].flatMap(
        (back) => byRepoDate.get(`${repo}|${addDays(date, -back)}`) ?? [],
      );
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
        } else if (roll < 0.68) link(pick(), 'suggested', BASIS_TEXT.sameRepoWindow);
        else if (roll < 0.78) link(pick(), 'owner', BASIS_TEXT.owner);
      }
    }
    prs.push(pr);
  }
  prs.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const nums = { ...START_NUM };
  for (const p of prs) {
    nums[p.repo] = (nums[p.repo] ?? 0) + 1;
    p.number = nums[p.repo]!;
  }

  // Events: exactly YEAR_TARGET.events, shared out in proportion to a weight per session.
  const weights = sessions.map((s) => (s.role === 'root' ? 1 : 0.5) * (0.3 + r() * 1.4));
  const total = weights.reduce((a, b) => a + b, 0);
  const counts = weights.map((w) => Math.max(1, Math.round((w / total) * YEAR_TARGET.events)));
  let diff = YEAR_TARGET.events - counts.reduce((a, b) => a + b, 0);
  for (let i = 0; diff !== 0; i = (i + 1) % counts.length) {
    const step = diff > 0 ? 1 : counts[i]! > 1 ? -1 : 0;
    counts[i]! += step;
    diff -= step;
  }
  sessions.forEach((s, i) => (s.events = counts[i]!));

  let localCodex = 0;
  for (const s of sessions)
    if (s.provider === 'codex' && s.date >= '2026-10-05' && s.date <= '2026-11-03')
      localCodex += s.tokens.total;

  return {
    today: TODAY,
    timezone: TIMEZONE,
    lookbackStart: LOOKBACK_START,
    me: ME,
    codexFrom: CODEX_FROM,
    claudeFrom: CLAUDE_FROM,
    paseoFrom: PASEO_FROM,
    repos: YEAR_REPOS.map((id) => ({ id, tracking: 'active' as const, access: 'ok' as const })), // exactly 6 repos
    sessions,
    prs,
    chatgptWindow: {
      start: '2026-10-05',
      end: '2026-11-03',
      total: Math.round((localCodex * 1.31) / 1e5) * 1e5,
    },
  };
}
