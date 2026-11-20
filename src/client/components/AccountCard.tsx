import type { ReactNode } from 'react';
import type { AccountReport } from '../../shared/contracts/accounts';
import type { Provider } from '../../shared/contracts/common';
import type { AccountStatus } from '../../shared/contracts/sources';
import {
  CLAUDE_PLAN_COPY,
  claudePlanPresentation,
  limitHasReset,
  limitPercent,
} from '../lib/claudePlanLimits';
import { cx } from '../lib/cx';
import { STATUS_TEXT } from '../lib/copy';
import { formatWhen } from '../lib/format';
import { Buddy } from './Buddy';
import { Icon } from './Icon';
import { StatusTag, type StatusKind } from './StatusTag';

export type ReportingAccount = AccountStatus & { id: 'chatgpt' | 'claude' };

const PLAN: Record<ReportingAccount['id'], string> = {
  chatgpt: 'Codex plan',
  claude: 'Claude Code plan',
};

const STATUS: Record<AccountStatus['status'], { kind: StatusKind; text: string }> = {
  notconnected: { kind: 'notconnected', text: STATUS_TEXT.notConnected },
  unavailable: { kind: 'none', text: 'Unavailable' },
  needsapp: { kind: 'notconnected', text: STATUS_TEXT.notConnected },
  existing: { kind: 'existing', text: STATUS_TEXT.existingSignIn },
  connected: { kind: 'connected', text: STATUS_TEXT.connected },
  connecting: { kind: 'connecting', text: STATUS_TEXT.waitingForSignIn },
  reconnect: { kind: 'reconnect', text: STATUS_TEXT.reconnectNeeded },
  failed: { kind: 'failed', text: STATUS_TEXT.refreshFailed },
};

/** The connection state as its short words and icon kind, for the card and the Sources row. */
export function accountTag(status: AccountStatus['status']): { kind: StatusKind; text: string } {
  return STATUS[status];
}

const PROVIDER_OF: Record<ReportingAccount['id'], Provider> = {
  chatgpt: 'codex',
  claude: 'claude',
};

interface When {
  timeZone: string;
  today: string;
  now: number;
}

type Limit = NonNullable<AccountReport['rateLimits']>[number];

function WeeklyUsage({ limit, when }: { limit: Limit; when: When }) {
  const reset = limit.resetsAt ? formatWhen(limit.resetsAt, when) : null;
  if (reset !== null && limitHasReset(limit, when.now)) {
    return <p className="text-label font-semibold text-ink">Weekly window reset {reset}.</p>;
  }
  return (
    <>
      <p className="font-display text-metric text-ink">
        {limitPercent(limit)}%
        <small className="font-sans text-label tracking-normal text-ink-muted">
          {' '}
          of weekly usage limit used
        </small>
      </p>
      {reset !== null && (
        <span className="inline-flex h-6 w-fit items-center gap-1 rounded-full bg-sunken px-2.5 text-caption whitespace-nowrap text-ink-muted">
          <Icon name="clock" />
          Resets {reset}
        </span>
      )}
    </>
  );
}

function fiveHourText(limit: Limit | undefined, when: When): string {
  if (!limit) return '5-hour window unavailable.';
  const reset = limit.resetsAt ? formatWhen(limit.resetsAt, when) : null;
  if (reset !== null && limitHasReset(limit, when.now)) return `5-hour window reset ${reset}.`;
  return `5-hour window: ${limitPercent(limit)}%${reset === null ? '' : ` · resets ${reset}`}`;
}

export function AccountCard({
  account,
  report,
  when,
  action,
  className,
}: {
  account: ReportingAccount;
  report: AccountReport | null;
  when: When;
  action?: ReactNode;
  className?: string;
}) {
  const claude = account.id === 'claude';
  const presentation = claude ? claudePlanPresentation(account) : accountTag(account.status);
  const { kind, text } = presentation;
  const guidance = 'guidance' in presentation ? presentation.guidance : null;
  const connectionProblem =
    !claude &&
    (account.status === 'failed' || account.status === 'unavailable') &&
    account.statusText !== text
      ? account.statusText
      : null;
  const usage = report?.unit === 'percent' ? report : null;
  // Claude's model-specific weekly windows may be present without the general weekly window.
  const weekly = usage?.rateLimits?.find(
    (limit) => limit.windowMinutes === 10_080 && !limit.limitId.startsWith('seven_day_'),
  );
  const fiveHour = claude
    ? usage?.rateLimits?.find((limit) => limit.windowMinutes === 300)
    : undefined;
  const unchecked = claude && kind === 'none' && usage === null;
  const checkedAt = usage && formatWhen(usage.refreshedAt, when);
  return (
    <li
      className={cx(
        'flex flex-col gap-2 border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0',
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5">
          <Buddy kind={PROVIDER_OF[account.id]} size={15} />
          <b className="font-bold text-ink">{account.name}</b>
          <span className="text-caption text-ink-muted">· {PLAN[account.id]}</span>
        </span>
        <StatusTag kind={kind}>{text}</StatusTag>
      </div>
      {weekly ? (
        <WeeklyUsage limit={weekly} when={when} />
      ) : (
        <p className="text-caption text-ink-muted">
          {unchecked ? CLAUDE_PLAN_COPY.unchecked : 'Weekly usage unavailable.'}
        </p>
      )}
      {usage && checkedAt && (
        <p className="text-caption text-ink-muted">
          {usage.provenance === 'claude_statusline'
            ? CLAUDE_PLAN_COPY.legacyReport(checkedAt)
            : claude
              ? (usage.stale ? CLAUDE_PLAN_COPY.staleReport : CLAUDE_PLAN_COPY.lastChecked)(
                  checkedAt,
                )
              : usage.stale
                ? `Last report ${checkedAt}, so these figures may be out of date.`
                : `As of ${checkedAt}`}
        </p>
      )}
      {claude && <p className="text-caption text-ink-muted">{fiveHourText(fiveHour, when)}</p>}
      {guidance && <p className="text-caption text-ink">{guidance}</p>}
      {connectionProblem && <p className="text-caption text-ink">{connectionProblem}</p>}
      {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
    </li>
  );
}
