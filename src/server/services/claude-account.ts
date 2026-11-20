import type {
  AccountReport,
  CaptureRequest,
  ClaudePlanLimitsCheckRequest,
} from '../../shared/contracts/accounts.ts';
import type { AccountStatus, ClaudePlanLimitsState } from '../../shared/contracts/sources.ts';
import type { NetFetch } from '../collectors/github/ports.ts';
import type { Db } from '../db/open.ts';
import {
  readAccountSnapshot,
  readClaudePlanOutcome,
  writeClaudePlanOutcome,
  type ClaudePlanOutcome,
} from '../db/queries/accounts.ts';
import type { ClaudeCapture } from '../integrations/claudeCapture/index.ts';
import type { RemovalPreview } from '../integrations/claudeCapture/revert.ts';
import type {
  ClaudePlanProfile,
  ReadClaudePlanCredential,
} from '../integrations/claudePlan/credentials.ts';
import { readClaudePlanUsage } from '../integrations/claudePlan/usage.ts';
import { windowLabel } from './accounts.ts';

const CLAUDE_NAME = 'Claude';
const iso = (ms: number): string => new Date(ms).toISOString();

const PLAN_STATUS: Record<ClaudePlanLimitsState, [AccountStatus['status'], string]> = {
  unchecked: ['notconnected', 'Plan limits haven’t been checked'],
  ok: ['connected', 'Plan limits checked'],
  signed_out: ['notconnected', 'Sign in to your Claude subscription in Claude Code'],
  credential_denied: ['failed', 'Claude Code sign-in couldn’t be accessed'],
  unsupported: ['unavailable', 'Claude Code sign-in doesn’t report subscription plan limits'],
  reconnect: ['reconnect', 'Sign in to Claude Code again'],
  limited: ['failed', 'Claude has temporarily rate-limited plan checks'],
  failed: ['failed', 'Couldn’t check Claude plan limits'],
};

function buildClaudeReport(
  db: Db,
  now: number,
  outcome: ClaudePlanOutcome | null,
): AccountReport | null {
  const legacy = outcome?.snapshot == null;
  const { rateLimits, fetchedAt } = outcome?.snapshot ?? readAccountSnapshot(db, 'claude');
  if (rateLimits.length === 0 || fetchedAt === null) return null;
  const allWindowsReset = rateLimits.every(
    (window) => (window.resetsAt ?? fetchedAt + (window.windowMinutes ?? Infinity) * 60_000) <= now,
  );
  return {
    account: 'claude',
    unit: 'percent',
    scopeLabel: legacy ? 'Claude Code status-line history' : 'Claude subscription plan limits',
    provenance: legacy ? 'claude_statusline' : 'claude_code_oauth',
    refreshedAt: iso(fetchedAt),
    stale: legacy || outcome?.state !== 'ok' || outcome.checkedAt !== fetchedAt || allWindowsReset,
    rateLimits: rateLimits.map((limit) => ({
      limitId: limit.limitId,
      label:
        limit.limitId === 'seven_day_sonnet'
          ? 'Weekly Sonnet'
          : limit.limitId === 'seven_day_opus'
            ? 'Weekly Opus'
            : windowLabel(limit.windowMinutes),
      usedPercent: limit.usedPercent,
      windowMinutes: limit.windowMinutes,
      resetsAt: limit.resetsAt === null ? null : iso(limit.resetsAt),
    })),
  };
}

/** Passive reads use only the saved outcome and report. */
export function claudePlanStatus(db: Db, now: number, profile?: string): AccountStatus {
  const outcome = profile === undefined ? null : readClaudePlanOutcome(db, profile);
  const state = outcome?.state ?? 'unchecked';
  const [status, statusText] = PLAN_STATUS[state];
  return {
    id: 'claude',
    name: CLAUDE_NAME,
    status,
    statusText,
    via: state === 'ok' || state === 'reconnect' || state === 'limited' ? 'claude_code' : null,
    planLimits: {
      state,
      lastCheckedAt: outcome === null ? null : iso(outcome.checkedAt),
      retryAt: outcome?.retryAt != null && outcome.retryAt > now ? iso(outcome.retryAt) : null,
      report: buildClaudeReport(db, now, outcome),
    },
  };
}

export interface ClaudeAccounts {
  status(): AccountStatus;
  planStatus(): AccountStatus;
  check(mode?: ClaudePlanLimitsCheckRequest['mode']): Promise<{ account: AccountStatus }>;
  preview(action: 'remove'): Promise<RemovalPreview>;
  change(request: CaptureRequest): Promise<{ account: AccountStatus }>;
}

export interface ClaudePlanLimitsPorts {
  readCredential: ReadClaudePlanCredential;
  net: NetFetch;
}

export interface ClaudeAccountsDeps {
  capture: ClaudeCapture;
  db: Db;
  now?: () => number;
  profile?: () => ClaudePlanProfile | null;
  planLimits?: ClaudePlanLimitsPorts;
}

export function createClaudeAccounts(deps: ClaudeAccountsDeps): ClaudeAccounts {
  const { capture, db, planLimits } = deps;
  const now = deps.now ?? Date.now;
  const planStatus = (): AccountStatus => {
    const profile = deps.profile?.();
    const stored = claudePlanStatus(db, now(), profile?.key);
    if (planLimits && profile) return stored;
    return {
      ...stored,
      status: 'unavailable',
      statusText: planLimits
        ? 'Choose one Claude Code profile before checking plan limits'
        : 'Checking Claude plan limits isn’t available in this session',
      reason: planLimits ? 'ambiguous_profile' : 'check_unavailable',
      planLimits: {
        state: 'unsupported',
        lastCheckedAt: null,
        retryAt: null,
        report: stored.planLimits?.report ?? null,
      },
    };
  };
  const status = (): AccountStatus => ({
    ...planStatus(),
    captureEnabled: false,
    captureHealth: capture.removalHealth(),
  });

  type Check = Promise<{ account: AccountStatus }>;
  const pending = new Map<string, Check>();

  async function checkProfile(profile: ClaudePlanProfile, ports: ClaudePlanLimitsPorts): Check {
    const last = readClaudePlanOutcome(db, profile.key);
    if (last?.retryAt != null && last.retryAt > now()) return { account: status() };

    const credential = await ports
      .readCredential(profile, now())
      .catch(() => ({ state: 'failed' }) as const);
    const usage =
      credential.state === 'ok'
        ? await readClaudePlanUsage(ports.net, credential.accessToken, now)
        : credential;
    writeClaudePlanOutcome(
      db,
      profile.key,
      {
        state: usage.state,
        checkedAt: now(),
        retryAt: usage.state === 'limited' ? usage.retryAt : null,
      },
      usage.state === 'ok' ? usage.limits : undefined,
    );
    return { account: status() };
  }

  return {
    status,
    planStatus,
    check(mode) {
      const profile = deps.profile?.();
      if (!planLimits || !profile) return Promise.resolve({ account: status() });
      // A saved OAuth snapshot is proof that this profile was checked successfully. Legacy capture lives elsewhere.
      if (mode === 'refresh' && !readClaudePlanOutcome(db, profile.key)?.snapshot) {
        return Promise.resolve({ account: status() });
      }
      const active = pending.get(profile.key);
      if (active) return active;
      const checked = checkProfile(profile, planLimits).finally(() => pending.delete(profile.key));
      pending.set(profile.key, checked);
      return checked;
    },
    preview: (action) => capture.preview(action),
    async change(request) {
      capture.change(request);
      return { account: status() };
    },
  };
}
