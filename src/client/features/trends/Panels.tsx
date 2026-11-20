import { Button } from '@astryxdesign/core/Button';
import { cx } from '../../lib/cx';
import { TRENDS_COPY } from './copy';

// A card's states that are not data. A card that is still loading keeps its real title and shows quiet bars where its content
// goes; one that could not be read says so in words and offers Try again where the content would be. The bars breathe (opacity)
// and hold still for a reader who asked for less motion; the status line names the state once.

/** A card frame with its real title, for an answer that is on its way. */
export function CardSkeleton({
  title,
  loading,
  className,
}: {
  title: string;
  loading: string;
  className?: string;
}) {
  return (
    <section
      aria-label={title}
      aria-busy="true"
      className={cx(
        'flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4 shadow-card',
        className,
      )}
    >
      <h2 className="font-display text-title-section text-ink">{title}</h2>
      <div aria-hidden="true" className="flex flex-col gap-2.5">
        <div className="h-3 w-4/5 rounded-sm bg-sunken motion-safe:animate-pulse" />
        <div className="h-3 w-3/5 rounded-sm bg-sunken motion-safe:animate-pulse" />
        <div className="h-3 w-2/3 rounded-sm bg-sunken motion-safe:animate-pulse" />
      </div>
      <p role="status" className="sr-only">
        {loading}
      </p>
    </section>
  );
}

/** What stands in a card's body when its answer could not be read. The card's title stays above it. */
export function LoadFailed({ onRetry }: { onRetry: () => void }) {
  const copy = TRENDS_COPY.failed;
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-2 rounded-md border border-dashed border-border-strong p-4"
    >
      <p className="font-semibold text-ink">{copy.title}</p>
      <p className="max-w-[60ch] text-copy text-ink-muted">{copy.body}</p>
      <Button
        label={copy.retry}
        variant="secondary"
        size="sm"
        onClick={onRetry}
        className="max-[719px]:min-h-11"
      />
    </div>
  );
}
