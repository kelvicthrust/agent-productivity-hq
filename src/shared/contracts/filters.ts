import { z } from 'zod';
import { AuthorFilter, DateString, Granularity, ProviderFilter } from './common.ts';

/** The shared query parameters on every analytics route, as they arrive: strings, all optional. Defaults are applied by `resolveScope` (domain/scope.ts). */
export const FilterQuery = {
  start: DateString,
  end: DateString,
  gran: Granularity,
  repos: z.string(),
  provider: ProviderFilter,
  author: AuthorFilter,
} as const;

export const LimitQuery = (max: number) => z.int().max(max);
