import { Button } from '@astryxdesign/core/Button';
import type { ReactNode } from 'react';
import { CrewArt } from '../../components/CrewArt';
import { Icon } from '../../components/Icon';
import { cx } from '../../lib/cx';
import { AfkScene } from './AfkScene';
import { HQ_COPY } from './copy';

// The page's states that are not the roster. Each says what is happening in words; the art beside a line is decorative.

/** A line of context above the roster: "warn" for something that limits what is shown. Words first, icon second. */
export function HqNotice({
  tone = 'warn',
  children,
  action,
}: {
  tone?: 'info' | 'warn';
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className={cx(
        'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-sm px-3 py-2 text-caption text-ink',
        tone === 'warn' ? 'bg-warning-surface' : 'bg-sunken',
      )}
    >
      <span className="flex min-w-0 flex-1 items-start gap-2">
        <Icon
          name={tone === 'warn' ? 'alert' : 'info'}
          className={cx('mt-px', tone === 'warn' ? 'text-warning' : 'text-ink-muted')}
        />
        <span className="min-w-0">{children}</span>
      </span>
      {action}
    </div>
  );
}

/** The first answer is on its way: quiet bars where the sessions will be, and the state named once for assistive technology. */
export function HqLoading() {
  return (
    <section
      aria-busy="true"
      className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4 shadow-card"
    >
      <div aria-hidden="true" className="flex flex-col gap-2.5">
        <div className="h-3 w-4/5 rounded-sm bg-sunken motion-safe:animate-pulse" />
        <div className="h-3 w-3/5 rounded-sm bg-sunken motion-safe:animate-pulse" />
        <div className="h-3 w-2/3 rounded-sm bg-sunken motion-safe:animate-pulse" />
      </div>
      <p role="status" className="sr-only">
        {HQ_COPY.loading}
      </p>
    </section>
  );
}

/**
 * The request failed. With a roster already on screen it is a notice above it (the last answer stays); with none it stands where
 * the roster would be. Retry asks again at once; the page also keeps polling.
 */
export function HqRequestError({ stale, onRetry }: { stale: boolean; onRetry: () => void }) {
  const copy = HQ_COPY.requestError;
  const retry = (
    <Button
      label={copy.retry}
      variant="secondary"
      size="sm"
      onClick={onRetry}
      className="max-[719px]:min-h-11"
    />
  );
  if (stale) {
    return (
      <div role="alert">
        <HqNotice action={retry}>{copy.stale}</HqNotice>
      </div>
    );
  }
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-2 rounded-md border border-dashed border-border-strong p-4"
    >
      <p className="font-semibold text-ink">{copy.title}</p>
      <p className="max-w-[60ch] text-copy text-ink-muted">{copy.body}</p>
      {retry}
    </div>
  );
}

/** Nothing here can show live agents (every feed is unavailable): one plain sentence. */
export function HqUnavailable() {
  return (
    <section className="flex flex-col items-start gap-2 rounded-md border border-dashed border-border-strong bg-surface p-6">
      <CrewArt mood="search" />
      <p className="max-w-[60ch] text-copy text-ink-muted">{HQ_COPY.unavailable}</p>
    </section>
  );
}

/** Every feed is live and nobody is running: the empty room with its AFK sign, and one quiet line under it. */
export function HqQuiet() {
  return (
    <section className="flex min-w-0 flex-col items-start gap-2">
      <AfkScene />
      <p className="max-w-[60ch] text-caption text-ink-muted">{HQ_COPY.quiet}</p>
    </section>
  );
}
