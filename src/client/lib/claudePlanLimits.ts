import type { AccountReport } from '../../shared/contracts/accounts';
import type { AccountStatus } from '../../shared/contracts/sources';

type State = NonNullable<AccountStatus['planLimits']>['state'];

const CLAUDE_PLAN_STATUS = {
  unchecked: { kind: 'none', text: 'Not checked', guidance: null },
  ok: { kind: 'ok', text: 'Checked', guidance: null },
  signed_out: {
    kind: 'notconnected',
    text: 'Sign-in needed',
    guidance: 'Sign in with your subscription in Claude Code on this machine, then check again.',
  },
  unsupported: {
    kind: 'warn',
    text: 'Unsupported sign-in',
    guidance: 'Use a Claude subscription sign-in in Claude Code, then check again.',
  },
  reconnect: {
    kind: 'reconnect',
    text: 'Sign in again',
    guidance: 'Renew your sign-in in Claude Code on this machine, then check again.',
  },
  credential_denied: {
    kind: 'denied',
    text: 'Access denied',
    guidance: 'Allow access to the Claude Code sign-in in macOS, then check again.',
  },
  limited: {
    kind: 'warn',
    text: 'Rate limited',
    guidance: 'Anthropic limited this check. Try again.',
  },
  failed: {
    kind: 'failed',
    text: 'Check failed',
    guidance:
      'Agent Productivity HQ couldn’t read plan limits. Check your internet connection, then try again.',
  },
} as const satisfies Record<State, { kind: string; text: string; guidance: string | null }>;

export function claudePlanPresentation(account: AccountStatus) {
  switch (account.reason) {
    case 'ambiguous_profile':
      return {
        kind: 'warn',
        text: 'Choose a profile',
        guidance:
          'Select one Claude Code profile on the machine running Agent Productivity HQ, then check again.',
      } as const;
    case 'check_unavailable':
      return {
        kind: 'warn',
        text: 'Check unavailable',
        guidance: 'Claude plan checks aren’t available in this session.',
      } as const;
    default:
      return CLAUDE_PLAN_STATUS[account.planLimits?.state ?? 'unchecked'];
  }
}

export const CLAUDE_PLAN_COPY = {
  unchecked: 'Claude plan limits haven’t been checked yet.',
  missing: 'No Claude plan limits available.',
  activeCooldown: (when: string) => `Anthropic limited this check. Try again ${when}.`,
  lastChecked: (when: string) => `Last checked ${when}`,
  staleReport: (when: string) => `Saved limits from ${when}. These figures may be out of date.`,
  legacyReport: (when: string) =>
    `Saved status-line snapshot from ${when}. These figures may be out of date.`,
  hasReset: 'Window reset',
} as const;

type Limit = NonNullable<AccountReport['rateLimits']>[number];

export const limitHasReset = (limit: Limit, now: number): boolean =>
  limit.resetsAt != null && Date.parse(limit.resetsAt) <= now;

export const limitPercent = (limit: Limit): number =>
  Math.min(100, Math.max(0, Math.round(limit.usedPercent)));
