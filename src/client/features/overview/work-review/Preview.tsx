import { Button } from '@astryxdesign/core/Button';
import { Dialog } from '@astryxdesign/core/Dialog';
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { WorkReviewState } from '../../../../shared/contracts/work-review';
import { formatRange } from '../../../../shared/domain/periods';
import { deliveryScopeLabel, usageScopeLabel } from '../../../../shared/domain/scope';
import { Icon } from '../../../components/Icon';
import {
  periodOf,
  searchFor,
  type FilterContext,
  type Filters,
  type Period,
} from '../../../lib/filters';
import { isPaseoBrowser } from '../../../lib/paseoBrowser';
import { GenerateReview } from './GenerateReview';
import { CopyReview, ReviewReport } from './ReviewReport';
import { reviewScopeKey, useReviewAccount, useWorkReview } from './data';

export const REVIEW_LINK =
  'inline-flex w-fit items-center gap-1.5 rounded-sm text-label font-semibold text-action underline underline-offset-2 max-[719px]:min-h-11';

const CARD =
  'flex w-full min-w-0 cursor-pointer items-center justify-between gap-3 rounded-md border border-border bg-surface p-4 text-left text-ink no-underline shadow-card hover:bg-sunken focus-visible:rounded-md focus-visible:bg-sunken';

export function WorkReviewPreview({
  filters,
  ctx,
  timeZone,
}: {
  filters: Filters;
  ctx: FilterContext;
  timeZone: string;
}) {
  return (
    <section aria-label="Work Review">
      {isPaseoBrowser() ? (
        <a href={`/work-review${searchFor('', filters, ctx)}`} className={CARD}>
          <CardContent>Open owner Work Review</CardContent>
        </a>
      ) : (
        <PreviewContent
          key={reviewScopeKey(filters)}
          filters={filters}
          href={`/delivery${searchFor('section=work-review', filters, ctx)}`}
          timeZone={timeZone}
          period={periodOf(filters, ctx)}
        />
      )}
    </section>
  );
}

function CardContent({ children }: { children: ReactNode }) {
  return (
    <>
      <span className="min-w-0">
        <span className="block font-display text-title-section text-ink">Work Review</span>
        <span className="mt-0.5 line-clamp-2 text-copy text-ink-muted [overflow-wrap:anywhere]">
          {children}
        </span>
      </span>
      <span className="shrink-0 text-action">
        <Icon name="chevronRight" size={19} />
      </span>
    </>
  );
}

const PERIOD_TITLE: Partial<Record<Period, string>> = {
  today: 'Daily work review',
  'this-week': 'Weekly work review',
  'last-week': 'Weekly work review',
  'this-month': 'Monthly work review',
  'last-month': 'Monthly work review',
};

function PreviewContent({
  filters,
  href,
  timeZone,
  period,
}: {
  filters: Filters;
  href: string;
  timeZone: string;
  period: Period;
}) {
  const result = useWorkReview(filters);
  const [open, setOpen] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<HTMLDivElement | null>(null);
  const id = useId();
  const state = result.data;
  const review = state?.review;
  const range = formatRange(filters.start, filters.end);
  const title = PERIOD_TITLE[period] ?? 'Work review';
  const summary =
    review?.headline ??
    (state?.status === 'running'
      ? 'Generating the work review…'
      : state?.status === 'failed' || result.isError
        ? 'The work review couldn’t be loaded or generated.'
        : result.isPending
          ? 'Loading the work review…'
          : 'No review has been saved for this scope.');

  return (
    <>
      <button
        type="button"
        className={CARD}
        aria-haspopup="dialog"
        aria-controls={id}
        onClick={(event) => {
          event.currentTarget.focus({ preventScroll: true });
          setOpen(true);
        }}
      >
        <CardContent>{summary}</CardContent>
      </button>
      <Dialog
        id={id}
        isOpen={open}
        onOpenChange={setOpen}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-period`}
        width={640}
        maxHeight="min(82dvh, 760px)"
        padding={0}
        className="overflow-hidden rounded-lg border border-border bg-surface text-ink shadow-overlay backdrop:bg-(--scrim) max-[550px]:max-h-[90dvh] max-[550px]:max-w-[calc(100dvw-1rem)]"
      >
        {open && (
          <>
            <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3 min-[551px]:px-[22px] min-[551px]:py-[15px]">
              <div className="min-w-0">
                <h2 id={`${id}-title`} className="font-display text-title-section text-ink">
                  {title}
                </h2>
                <p id={`${id}-period`} className="mt-0.5 text-caption text-ink-muted">
                  {range}
                </p>
              </div>
              <Button
                label="Close"
                size="sm"
                variant="secondary"
                className="min-h-10 shrink-0 max-[719px]:min-h-11"
                data-autofocus
                onClick={() => setOpen(false)}
              />
            </header>
            <div className="min-h-0 overflow-y-auto overscroll-contain px-4 py-3.5 min-[551px]:px-[22px]">
              {result.isError ? (
                <div className="mb-3 flex flex-wrap items-center gap-3">
                  <p role="alert" className="text-copy text-danger">
                    {review
                      ? 'Couldn’t refresh the work review. Showing the last saved update.'
                      : 'Couldn’t load the work review.'}
                  </p>
                  <Button
                    label="Try again"
                    variant="secondary"
                    size="sm"
                    className="max-[719px]:min-h-11"
                    onClick={() => void result.refetch()}
                  />
                </div>
              ) : state?.status === 'failed' ? (
                <p role="alert" className="mb-3 text-copy text-danger">
                  {state.message ?? 'The work review couldn’t be generated. Try again.'}
                </p>
              ) : null}
              {review ? (
                <ReviewReport
                  review={review}
                  timeZone={timeZone}
                  presentation="dialog"
                  headingLevel={3}
                />
              ) : !result.isError ? (
                <div className="space-y-2">
                  <p className="text-caption text-ink-muted [overflow-wrap:anywhere]">
                    PRs · {deliveryScopeLabel(filters)}. Sessions · {usageScopeLabel(filters)}.
                  </p>
                  {state?.status !== 'failed' && (
                    <p role="status" className="text-copy text-ink-muted">
                      {summary}
                    </p>
                  )}
                </div>
              ) : null}
            </div>
            <div
              ref={setCopyFeedback}
              className="max-h-[28dvh] shrink-0 overflow-y-auto px-4 py-2 empty:hidden min-[551px]:px-[22px]"
            />
            <ReviewFooter
              state={state}
              loadFailed={result.isError}
              filters={filters}
              range={range}
              href={href}
              copyFeedback={copyFeedback}
            />
          </>
        )}
      </Dialog>
    </>
  );
}

function ReviewFooter({
  filters,
  state,
  loadFailed,
  range,
  href,
  copyFeedback,
}: {
  filters: Filters;
  state: WorkReviewState | undefined;
  loadFailed: boolean;
  range: string;
  href: string;
  copyFeedback: HTMLDivElement | null;
}) {
  const account = useReviewAccount();
  const review = state?.review;
  const copyButton = useRef<HTMLButtonElement>(null);
  const [sawGeneration, setSawGeneration] = useState(false);
  if (!sawGeneration && !review && state?.status === 'running') setSawGeneration(true);
  const completed = sawGeneration && Boolean(review);
  useLayoutEffect(() => {
    const button = copyButton.current;
    if (!completed || !button) return;
    const doc = button.ownerDocument;
    // Removing the focused Generate button can leave focus on the document body.
    if (doc.activeElement === doc.body && doc.hasFocus()) button.focus({ preventScroll: true });
  }, [completed]);

  const canGenerate = account.data?.status === 'connected' && !account.isError;
  const connect = !review && state && !loadFailed && !account.isPending && !canGenerate;
  return (
    <footer className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-t border-border px-4 py-3 min-[551px]:px-[22px] min-[551px]:py-[15px] [&>button]:justify-self-end [&>p]:col-span-full">
      <Link to={href} className={`${REVIEW_LINK} max-w-full [overflow-wrap:anywhere]`}>
        {connect ? 'Manage ChatGPT connection' : 'Manage review'}
      </Link>
      {review ? (
        <CopyReview
          key={review.version}
          review={review}
          range={range}
          variant="primary"
          actionRef={copyButton}
          feedbackContainer={copyFeedback}
        />
      ) : state && !loadFailed && canGenerate ? (
        <GenerateReview filters={filters} state={state} />
      ) : null}
      <p role="status" className="sr-only">
        {completed ? 'Work review ready.' : ''}
      </p>
    </footer>
  );
}
