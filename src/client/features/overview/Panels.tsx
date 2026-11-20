import { Button } from '@astryxdesign/core/Button';
import { CrewArt } from '../../components/CrewArt';
import { OVERVIEW_COPY } from './copy';

// The page's states that are not data: a card while its answer loads, the panel when the whole overview could not be read, and
// the quiet one. Each names its state in words; the bars and the art are decoration.

/**
 * A card frame with its real title and quiet bars where the content goes. The bars breathe (opacity), and hold still for a
 * reader who asked for less motion; the status line says what is loading, once.
 */
export function CardSkeleton({ title, loading }: { title: string; loading: string }) {
  return (
    <section
      aria-label={title}
      aria-busy="true"
      className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4 shadow-card"
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

/** The overview could not be read at all. Try again is the one way forward, and sits where the figures would be. */
export function OverviewFailed({ onRetry }: { onRetry: () => void }) {
  const copy = OVERVIEW_COPY.failed;
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-2 rounded-md border border-dashed border-border-strong bg-surface p-6"
    >
      <p className="font-semibold text-ink">{copy.title}</p>
      <p className="max-w-[60ch] text-copy text-ink-muted">{copy.body}</p>
      <Button
        label={copy.retry}
        variant="secondary"
        onClick={onRetry}
        className="max-[719px]:min-h-11"
      />
    </div>
  );
}

/** A true zero: every source was collecting and nothing happened. Said warmly, and plainly not "missing data". */
export function QuietOne() {
  const copy = OVERVIEW_COPY.quiet;
  return (
    <div
      role="status"
      className="flex items-center gap-4 rounded-md border border-dashed border-border-strong bg-surface px-4 py-3 max-[719px]:flex-col max-[719px]:items-start"
    >
      <CrewArt mood="sleep" />
      <p className="max-w-[62ch] text-copy text-ink-muted">
        <strong className="mb-0.5 block font-display text-title-section font-semibold text-ink">
          {copy.heading}
        </strong>
        {copy.body}
      </p>
    </div>
  );
}
