import { z } from 'zod';

// Building blocks shared by every contract. docs/tech/local-api.md is the reviewable copy; test/contract/openapi.test.ts
// fails when these and that document disagree.

/** `YYYY-MM-DD`, a calendar date in the report timezone. */
export const DateString = z.iso.date();
/** An ISO-8601 UTC instant. */
export const Instant = z.iso.datetime();
/** An API integer. */
export const Int = z.int();

export const Provider = z.enum(['codex', 'claude']);
export const ProviderFilter = z.enum(['all', 'codex', 'claude']);
export const Granularity = z.enum(['day', 'week', 'month']);
export const AuthorFilter = z.enum(['mine', 'all']);

export const UsageCoverage = z.enum(['ok', 'partial', 'unavailable', 'stale', 'none', 'future']);
export const DeliveryCoverage = z.enum(['ok', 'syncing', 'none', 'future']);

/** A provider headline total. null when coverage is unavailable, none or future; 0 means covered with no activity. */
export const TokenCount = Int.nullable();

export const LinkClass = z.enum(['evidence', 'owner', 'suggested', 'unlinked']);

export const Scope = z.object({
  start: DateString,
  end: DateString,
  gran: Granularity,
  repos: z.array(z.string()),
  ignoredRepos: z.array(z.string()).optional(),
  provider: ProviderFilter,
  author: AuthorFilter,
  timezone: z.string(),
});

export type Provider = z.infer<typeof Provider>;
export type ProviderFilter = z.infer<typeof ProviderFilter>;
export type Granularity = z.infer<typeof Granularity>;
export type AuthorFilter = z.infer<typeof AuthorFilter>;
export type UsageCoverage = z.infer<typeof UsageCoverage>;
export type DeliveryCoverage = z.infer<typeof DeliveryCoverage>;
export type Scope = z.infer<typeof Scope>;
