import type { AuthorFilter, Granularity, ProviderFilter, Scope } from '../contracts/common.ts';
import { checkRange, defaultGranularity, isDateString, presetRange, weekEnd } from './periods.ts';

// Filter resolution and scope labels (local-api › Filters; PRODUCT scope lines). Pure.

export const PROVIDER_NAMES = { codex: 'Codex', claude: 'Claude Code' } as const;

export interface RawFilters {
  start?: string | undefined;
  end?: string | undefined;
  gran?: string | undefined;
  repos?: string | undefined;
  provider?: string | undefined;
  author?: string | undefined;
}

export interface ScopeContext {
  today: string;
  timezone: string;
  /** Canonical ids of every repo this machine knows (tracked, stopped or inaccessible). */
  knownRepos: ReadonlySet<string>;
}

export type ScopeResult =
  | { ok: true; scope: Scope }
  | { ok: false; code: 'invalid_input'; message: string; fields: Record<string, string> }
  | { ok: false; code: 'invalid_range'; message: string };

const GRANULARITIES: readonly Granularity[] = ['day', 'week', 'month'];
const PROVIDERS: readonly ProviderFilter[] = ['all', 'codex', 'claude'];
const AUTHORS: readonly AuthorFilter[] = ['mine', 'all'];

const oneOf = <T extends string>(values: readonly T[], value: string): value is T =>
  (values as readonly string[]).includes(value);

/**
 * Applies the defaults and checks: no start or end means the current Monday-start week (each missing one takes its week
 * default); `gran` follows the range length; `repos` keeps the known ids and echoes the rest in `ignoredRepos`;
 * `provider` defaults to all and `author` to mine.
 */
export function resolveScope(raw: RawFilters, ctx: ScopeContext): ScopeResult {
  const fields: Record<string, string> = {};
  const week = presetRange('this-week', ctx.today);

  const start = raw.start ?? week.start;
  const end = raw.end ?? weekEnd(ctx.today);
  if (!isDateString(start)) fields['start'] = 'Use a date like 2026-11-04.';
  if (!isDateString(end)) fields['end'] = 'Use a date like 2026-11-04.';
  if (raw.gran !== undefined && !oneOf(GRANULARITIES, raw.gran))
    fields['gran'] = 'Use day, week or month.';
  if (raw.provider !== undefined && !oneOf(PROVIDERS, raw.provider))
    fields['provider'] = 'Use all, codex or claude.';
  if (raw.author !== undefined && !oneOf(AUTHORS, raw.author))
    fields['author'] = 'Use mine or all.';
  if (Object.keys(fields).length > 0) {
    return { ok: false, code: 'invalid_input', message: 'Some filters are not valid.', fields };
  }

  const range = checkRange(start, end, ctx.today);
  if (!range.ok) return { ok: false, code: 'invalid_range', message: range.message };

  const requested = [
    ...new Set(
      (raw.repos ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  const repos = requested.filter((id) => ctx.knownRepos.has(id));
  const ignoredRepos = requested.filter((id) => !ctx.knownRepos.has(id));

  return {
    ok: true,
    scope: {
      start,
      end,
      gran: (raw.gran as Granularity | undefined) ?? defaultGranularity(start, end),
      repos,
      ...(ignoredRepos.length > 0 ? { ignoredRepos } : {}),
      provider: (raw.provider as ProviderFilter | undefined) ?? 'all',
      author: (raw.author as AuthorFilter | undefined) ?? 'mine',
      timezone: ctx.timezone,
    },
  };
}

/** "All repos", the repo's id, or "N repos". */
export function repoScopeLabel(repos: readonly string[]): string {
  if (repos.length === 0) return 'All repos';
  return repos.length === 1 ? repos[0]! : `${repos.length} repos`;
}

/** The scope line under delivery figures. */
export function deliveryScopeLabel(scope: Pick<Scope, 'repos' | 'author'>): string {
  return `${repoScopeLabel(scope.repos)} · ${scope.author === 'mine' ? 'Authored by you' : 'All authors'}`;
}

/** The scope line under usage figures. */
export function usageScopeLabel(scope: Pick<Scope, 'repos' | 'provider'>): string {
  const provider = scope.provider === 'all' ? 'All providers' : PROVIDER_NAMES[scope.provider];
  return `This machine · ${repoScopeLabel(scope.repos)} · ${provider}`;
}

/** The providers a `provider` filter selects. */
export const providersInScope = (provider: ProviderFilter): ('codex' | 'claude')[] =>
  provider === 'all' ? ['codex', 'claude'] : [provider];
