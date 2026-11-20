import { Button } from '@astryxdesign/core/Button';
import { useToast } from '@astryxdesign/core/Toast';
import { useRef, useState } from 'react';
import { StatusTag } from '../../../components/StatusTag';
import { useCaptureChange, useClaudePlanLimitsCheck, type Account } from '../../../lib/accounts';
import { useBootstrap } from '../../../lib/bootstrap';
import {
  CLAUDE_PLAN_COPY,
  claudePlanPresentation,
  limitHasReset,
  limitPercent,
} from '../../../lib/claudePlanLimits';
import { SOURCES_COPY } from '../../../lib/copy';
import { formatWhen } from '../../../lib/format';
import { useNow } from '../../../lib/useNow';
import { CapturePanel, refusalOf } from './CapturePanel';
import { ACCOUNTS_COPY } from './copy';
import { Alert, BUTTON, ROW } from './parts';

const COPY = ACCOUNTS_COPY.claude;

export function ClaudeRow({ card }: { card: Account }) {
  const toast = useToast();
  const bootstrap = useBootstrap().data;
  const check = useClaudePlanLimitsCheck();
  const removal = useCaptureChange();
  const [open, setOpen] = useState(false);
  const checkButton = useRef<HTMLButtonElement>(null);
  const removalButton = useRef<HTMLButtonElement>(null);
  const plan = card.planLimits;
  const retryAt = plan?.retryAt ?? null;
  const now = useNow(retryAt);
  const coolingDown = retryAt !== null && Date.parse(retryAt) > now;
  const report = plan?.report;
  const status = claudePlanPresentation(card);
  const health = card.captureHealth;

  const when = (instant: string): string =>
    formatWhen(instant, bootstrap ? { timeZone: bootstrap.timezone, today: bootstrap.today } : {});
  const guidance = coolingDown ? CLAUDE_PLAN_COPY.activeCooldown(when(retryAt)) : status.guidance;

  function closePreview(removed = false) {
    setOpen(false);
    removal.reset();
    (removed ? checkButton.current : removalButton.current)?.focus();
  }

  return (
    <li className={ROW}>
      <div className="flex flex-col gap-1">
        <b className="text-copy font-bold text-ink">{COPY.title}</b>
        <span role="status">
          {check.isPending ? (
            <StatusTag kind="checking">{COPY.checking}</StatusTag>
          ) : (
            <StatusTag kind={status.kind}>{status.text}</StatusTag>
          )}
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-1 text-caption text-ink-muted">
        <p id="claude-plan-check-description">
          {report?.provenance === 'claude_code_oauth'
            ? SOURCES_COPY.accounts.claudeRefresh
            : SOURCES_COPY.accounts.purpose.claude}
        </p>
        {plan?.lastCheckedAt && <p>{CLAUDE_PLAN_COPY.lastChecked(when(plan.lastCheckedAt))}</p>}
        {report && (
          <>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {report.rateLimits?.map((limit) => (
                <li key={limit.limitId}>
                  <span className="font-semibold text-ink">{limit.label ?? COPY.window}</span>
                  {' · '}
                  {limitHasReset(limit, now) ? (
                    CLAUDE_PLAN_COPY.hasReset
                  ) : (
                    <>
                      {limitPercent(limit)}% used
                      {limit.resetsAt && ` · resets ${when(limit.resetsAt)}`}
                    </>
                  )}
                </li>
              ))}
            </ul>
            {report.provenance === 'claude_statusline' ? (
              <p>{CLAUDE_PLAN_COPY.legacyReport(when(report.refreshedAt))}</p>
            ) : (
              report.stale && <p>{CLAUDE_PLAN_COPY.staleReport(when(report.refreshedAt))}</p>
            )}
          </>
        )}
        {check.isError ? <Alert>{COPY.checkFailed}</Alert> : guidance && <Alert>{guidance}</Alert>}
        <a
          href="https://claude.ai/settings/usage"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-fit items-center text-action underline max-[719px]:min-h-11"
        >
          View usage on Claude.ai
        </a>
        {health?.recorded && <p>{COPY.legacyHook}</p>}
        {health?.state === 'state_unreadable' && <p>{COPY.recordUnreadable}</p>}
      </div>
      <div className="flex flex-wrap justify-end gap-2 max-[719px]:justify-start">
        <Button
          ref={checkButton}
          label={plan?.lastCheckedAt ? COPY.checkAgain : COPY.check}
          size="sm"
          variant="secondary"
          className={BUTTON}
          aria-describedby="claude-plan-check-description"
          aria-busy={check.isPending || undefined}
          aria-disabled={check.isPending || coolingDown || undefined}
          onClick={() => {
            if (!check.isPending && !coolingDown) check.mutate();
          }}
        />
        {health?.recorded && (
          <Button
            ref={removalButton}
            label={COPY.remove}
            size="sm"
            variant="secondary"
            className={BUTTON}
            aria-expanded={open}
            aria-disabled={removal.isPending || undefined}
            onClick={() => {
              if (removal.isPending) return;
              removal.reset();
              setOpen(true);
            }}
          />
        )}
      </div>

      {open && (
        <CapturePanel
          pending={removal.isPending}
          refusal={removal.isError ? refusalOf(removal.error, ACCOUNTS_COPY.fallback) : null}
          onClose={() => {
            if (!removal.isPending) closePreview();
          }}
          onSubmit={() => {
            if (removal.isPending) return;
            removal.mutate(
              { action: 'verify_remove' },
              {
                onSuccess: () => {
                  closePreview(true);
                  toast({ body: COPY.removed });
                },
              },
            );
          }}
        />
      )}
    </li>
  );
}
