import { Button } from '@astryxdesign/core/Button';
import { useId, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { createPortal } from 'react-dom';
import type { WorkReviewVersion } from '../../../../shared/contracts/work-review';
import { formatStarted } from '../../../lib/format';
import { EvidenceList } from './Evidence';

const SECTIONS = [
  ['shipped', 'Shipped'],
  ['team', 'Team merges'],
  ['progress', 'Other progress'],
  ['open', 'Still open'],
] as const;

export function CopyReview({
  review,
  range,
  variant = 'secondary',
  actionRef,
  feedbackContainer,
}: {
  review: WorkReviewVersion;
  range: string;
  variant?: 'primary' | 'secondary';
  actionRef?: Ref<HTMLButtonElement>;
  feedbackContainer?: HTMLElement | null;
}) {
  const [copy, setCopy] = useState<'ready' | 'done' | 'failed'>('ready');
  const id = useId();
  const manual = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (copy === 'failed' && feedbackContainer) manual.current?.focus();
  }, [copy, feedbackContainer]);
  const plainText = [
    `Work Review · ${range}`,
    review.headline,
    ...SECTIONS.flatMap(([kind, title]) => {
      const bullets = review.bullets.filter((bullet) => bullet.kind === kind);
      return bullets.length ? [[title, ...bullets.map(({ text }) => `- ${text}`)].join('\n')] : [];
    }),
  ].join('\n\n');

  async function copyText() {
    try {
      await navigator.clipboard.writeText(plainText);
      setCopy('done');
    } catch {
      setCopy('failed');
    }
  }

  const feedback =
    copy === 'done' ? (
      <p role="status" className="text-caption text-ink-muted">
        Copied to clipboard.
      </p>
    ) : copy === 'failed' ? (
      <div className="flex basis-full flex-col gap-1">
        <label htmlFor={id} className="text-copy text-ink-muted">
          Clipboard access is unavailable. Copy the review from this field.
        </label>
        <textarea
          ref={manual}
          id={id}
          rows={6}
          readOnly
          value={plainText}
          onFocus={(event) => event.currentTarget.select()}
          className="w-full rounded-sm border border-control-border bg-surface p-2 text-copy text-ink"
        />
      </div>
    ) : null;

  return (
    <>
      <Button
        ref={actionRef}
        label="Copy update"
        size="sm"
        variant={variant}
        className={variant === 'primary' ? 'min-h-10 max-[719px]:min-h-11' : 'max-[719px]:min-h-11'}
        onClick={() => void copyText()}
      />
      {feedbackContainer ? createPortal(feedback, feedbackContainer) : feedback}
    </>
  );
}

export function ReviewReport({
  review,
  timeZone,
  presentation = 'page',
  headingLevel = 2,
}: {
  review: WorkReviewVersion;
  timeZone: string;
  presentation?: 'page' | 'dialog';
  headingLevel?: 2 | 3;
}) {
  const heading = useId();
  const inDialog = presentation === 'dialog';
  const Headline = headingLevel === 3 ? 'h3' : 'h2';
  const SectionHeading = headingLevel === 3 ? 'h4' : 'h3';
  return (
    <article
      aria-labelledby={heading}
      className="flex min-w-0 flex-col gap-3 [overflow-wrap:anywhere]"
    >
      <header>
        {!inDialog && (
          <p className="text-caption text-ink-muted">
            Version {review.version} · Saved{' '}
            <time dateTime={review.createdAt}>{formatStarted(review.createdAt, timeZone)}</time>
          </p>
        )}
        <Headline
          id={heading}
          className={
            inDialog ? 'text-copy text-ink' : 'mt-1 font-display text-title-section text-ink'
          }
        >
          {review.headline}
        </Headline>
        <EvidenceList evidence={review.headlineEvidence} />
      </header>
      {SECTIONS.map(([kind, title]) => {
        const bullets = review.bullets.filter((bullet) => bullet.kind === kind);
        if (bullets.length === 0) return null;
        return (
          <section key={kind} className={inDialog ? undefined : 'border-t border-border pt-3'}>
            <SectionHeading className="font-display text-title-section text-ink">
              {title}
            </SectionHeading>
            <ul className="mt-1 list-disc space-y-3 ps-5 text-copy text-ink">
              {bullets.map((bullet, index) => (
                <li key={index}>
                  <p>{bullet.text}</p>
                  <EvidenceList evidence={bullet.evidence} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {review.coverage.length > 0 && (
        <section className="border-t border-border pt-3">
          <SectionHeading
            className={inDialog ? 'sr-only' : 'font-display text-title-section text-ink'}
          >
            Source coverage
          </SectionHeading>
          <ul
            className={
              inDialog
                ? 'space-y-1 text-caption text-ink-muted'
                : 'mt-1 list-disc space-y-1 ps-5 text-copy text-ink-muted'
            }
          >
            {review.coverage.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
