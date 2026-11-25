import { Button } from '@astryxdesign/core/Button';
import { useId } from 'react';
import { useChangeReviewAutomation, useReviewAutomation } from './data';

const TOUCH = 'max-[719px]:min-h-11';

export function ReviewAutomation({
  connected,
  accountBusy,
}: {
  connected: boolean;
  accountBusy: boolean;
}) {
  const id = useId();
  const result = useReviewAutomation();
  const change = useChangeReviewAutomation();
  const enabled = result.data?.enabled;
  const disabled = change.isPending || accountBusy || (!enabled && (!connected || result.isError));
  const changeFailed = change.isError && enabled !== change.variables;
  const action = enabled ? 'Turn off automatic refresh' : 'Turn on automatic refresh';
  let status = '';
  if (change.isPending) status = 'Saving automatic refresh setting…';
  else if (result.isPending) status = 'Checking automatic refresh…';
  else if (enabled === true)
    status = connected ? 'On' : 'Paused. Connect ChatGPT to resume automatic refresh.';
  else if (enabled === false)
    status = connected ? 'Off' : 'Off. Connect ChatGPT to turn on automatic refresh.';

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4 shadow-card"
    >
      <div className="space-y-1">
        <h3 id={`${id}-title`} className="font-display text-title-section text-ink">
          Keep this week up to date
        </h3>
        <p id={`${id}-description`} className="max-w-[75ch] text-copy text-ink-muted">
          When enabled, HQ can refresh the current week’s review when evidence changes and HQ is
          running, at most once every 6 hours. This continues each week until you turn it off. The
          review covers My PRs, all repos and both providers. A refresh can send selected session
          excerpts and pull request metadata to OpenAI and use the allowance of your connected
          ChatGPT plan.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p id={`${id}-status`} role="status" className="text-copy text-ink">
          {status}
        </p>
        {enabled !== undefined && (
          <Button
            label={action}
            size="sm"
            variant="secondary"
            className={TOUCH}
            aria-describedby={`${id}-description ${id}-status`}
            aria-disabled={disabled || undefined}
            onClick={() => {
              if (!disabled) change.mutate(!enabled);
            }}
          />
        )}
      </div>
      {changeFailed && (
        <p role="alert" className="text-copy text-danger">
          {change.variables
            ? 'Couldn’t turn on automatic refresh. Try again.'
            : 'Couldn’t turn off automatic refresh. Try again.'}
        </p>
      )}
      {result.isError && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-copy text-danger">
            Couldn’t read the automatic refresh setting.
          </p>
          <Button
            label="Try again"
            size="sm"
            variant="secondary"
            className={TOUCH}
            onClick={() => void result.refetch()}
          />
        </div>
      )}
    </section>
  );
}
