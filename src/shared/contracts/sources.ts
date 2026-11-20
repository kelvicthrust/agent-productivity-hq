import { z } from 'zod';
import { AccountReport } from './account-report.ts';
import { DateString, Instant, Int } from './common.ts';
import { LinkRebuildResult } from './link-health.ts';

export const SourceStatus = z.object({
  id: z.enum(['codex', 'claude', 'paseo', 'github']),
  name: z.string(),
  status: z.enum([
    'checking',
    'ok',
    'partial',
    'failed',
    'notfound',
    'denied',
    'notrunning',
    'needspassword',
  ]),
  location: z.string().nullable().optional(),
  oldestDate: DateString.nullable().optional(),
  sessions: Int.nullable().optional(),
  /** Whether Agent Productivity HQ still holds records from this source, independent of discovery and attempts. */
  hasRetainedData: z.boolean().optional(),
  unreadable: Int.optional(),
  unsupported: Int.optional(),
  lastSuccessAt: Instant.nullable().optional(),
  lastAttemptAt: Instant.nullable().optional(),
  lastAttemptResult: z.enum(['succeeded', 'partial', 'failed']).nullable().optional(),
  /** Failed attempts in a row since the last attempt that was not a failure; 0 after any succeeded or partial attempt. */
  consecutiveFailures: Int.min(0).optional(),
  /** The last date fully collected before a failed refresh. */
  staleAfter: DateString.nullable().optional(),
  message: z.string().nullable().optional(),
  retentionNote: z.string().nullable().optional(),
});
export type SourceStatus = z.infer<typeof SourceStatus>;

export const ClaudePlanLimitsState = z.enum([
  'unchecked',
  'ok',
  'signed_out',
  'credential_denied',
  'unsupported',
  'reconnect',
  'limited',
  'failed',
]);
export type ClaudePlanLimitsState = z.infer<typeof ClaudePlanLimitsState>;

export const AccountStatus = z.object({
  id: z.enum(['github', 'chatgpt', 'claude']),
  name: z.string(),
  status: z.enum([
    'existing',
    'connected',
    'notconnected',
    'needsapp',
    'reconnect',
    'unavailable',
    'connecting',
    'failed',
  ]),
  statusText: z.string().optional(),
  login: z.string().nullable().optional(),
  via: z.enum(['gh', 'app', 'codex', 'statusline', 'claude_code']).nullable().optional(),
  appClientIdSaved: z.boolean().nullable().optional(),
  planLimits: z
    .object({
      state: ClaudePlanLimitsState,
      lastCheckedAt: Instant.nullable(),
      retryAt: Instant.nullable(),
      report: AccountReport.nullable(),
    })
    .optional(),
  captureEnabled: z.boolean().nullable().optional(),
  captureHealth: z
    .object({
      phase: z.enum(['off', 'awaiting_edit', 'active', 'awaiting_removal', 'needs_attention']),
      recorded: z.boolean(),
      state: z.enum([
        'off',
        'awaiting_edit',
        'awaiting_removal',
        'waiting',
        'ok',
        'no_limits',
        'idle',
        'replaced',
        'node_missing',
        'settings_unreadable',
        'profile_changed',
        'state_unreadable',
        'legacy_unverified',
      ]),
      lastInvokedAt: Instant.nullable().optional(),
      capturedAt: Instant.nullable().optional(),
      settingsPath: z.string().nullable().optional(),
      projectOverrides: Int.optional(),
      backupPath: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  reason: z.string().nullable().optional(),
});
export type AccountStatus = z.infer<typeof AccountStatus>;

export const RefreshRun = z.object({
  id: Int,
  state: z.enum(['running', 'succeeded', 'partial', 'failed', 'interrupted']),
  startedAt: Instant,
  finishedAt: Instant.nullable().optional(),
  linkRebuild: LinkRebuildResult.nullable(),
  sources: z.record(
    z.string(),
    z.object({
      state: z.enum(['queued', 'running', 'succeeded', 'partial', 'failed', 'skipped']).optional(),
      imported: Int.optional(),
      duplicatesSkipped: Int.optional(),
      unreadable: Int.optional(),
      message: z.string().nullable().optional(),
    }),
  ),
});
export type RefreshRun = z.infer<typeof RefreshRun>;

export const RefreshRequest = z.object({
  sources: z.array(z.enum(['codex', 'claude', 'paseo', 'github', 'chatgpt_account'])).optional(),
});

export const SourcesResponse = z.object({
  chatgptCoverage: z
    .object({
      unit: z.enum(['tokens', 'percent']),
      bucketSpan: z
        .object({ start: DateString.optional(), end: DateString.optional() })
        .nullable()
        .optional(),
      stale: z.boolean().optional(),
    })
    .optional(),
  sources: z.array(SourceStatus).optional(),
  accounts: z.array(AccountStatus).optional(),
  running: Int.nullable().optional(),
});

export const SetupDiscoverResponse = z.object({
  sources: z.array(SourceStatus).optional(),
  accounts: z.array(AccountStatus).optional(),
});
