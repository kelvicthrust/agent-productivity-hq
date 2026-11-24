import { Button } from '@astryxdesign/core/Button';
import { Dialog } from '@astryxdesign/core/Dialog';
import { useId, useRef, useState } from 'react';
import type { WorkReviewState } from '../../../../shared/contracts/work-review';
import { formatRange } from '../../../../shared/domain/periods';
import { ApiRequestError } from '../../../lib/api';
import type { Filters } from '../../../lib/filters';
import { useGenerateWorkReview } from './data';

const TOUCH = 'max-[719px]:min-h-11';

export function GenerateReview({ filters, state }: { filters: Filters; state: WorkReviewState }) {
  const generate = useGenerateWorkReview(filters);
  const [open, setOpen] = useState(false);
  const confirming = useRef(false);
  const id = useId();
  const busy = generate.isPending || state.status === 'running';
  const revision = state.locked && state.review !== null;
  const canGenerate = state.review === null || state.changed || state.status === 'failed';
  const label = revision
    ? 'Create revision'
    : state.review === null
      ? 'Generate update'
      : 'Update review';
  const error =
    generate.error instanceof ApiRequestError
      ? generate.error.message
      : 'The work review couldn’t start. Try again.';

  return (
    <>
      {(canGenerate || busy) && (
        <Button
          label={busy ? 'Generating update…' : label}
          size="sm"
          variant="primary"
          className={`${TOUCH} aria-disabled:cursor-default aria-disabled:opacity-70`}
          aria-disabled={busy || undefined}
          onClick={(event) => {
            if (busy) return;
            event.currentTarget.focus();
            setOpen(true);
          }}
        />
      )}
      {generate.isError && state.status === 'idle' && (
        <p role="alert" className="basis-full text-copy text-danger">
          {error}
        </p>
      )}
      {busy && (
        <p role="status" className="sr-only">
          Generating the work review.
        </p>
      )}
      <Dialog
        isOpen={open}
        onOpenChange={setOpen}
        purpose="form"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        width={520}
      >
        {open && (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <h2 id={`${id}-title`} className="font-display text-title-section text-ink">
              {label} for {formatRange(filters.start, filters.end)}?
            </h2>
            <p id={`${id}-description`} className="overflow-y-auto text-copy text-ink">
              HQ sends selected session excerpts and pull request metadata for this scope to OpenAI
              for cloud processing. This uses the allowance of the ChatGPT plan you connected
              separately for Work Review. HQ saves generated session notes, reviews and evidence
              links on this machine.
            </p>
            <div className="flex shrink-0 flex-wrap justify-end gap-2">
              <Button
                label="Cancel"
                size="sm"
                variant="secondary"
                className={TOUCH}
                onClick={() => setOpen(false)}
                data-autofocus
              />
              <Button
                label={label}
                size="sm"
                variant="primary"
                className={TOUCH}
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (busy || confirming.current) return;
                  confirming.current = true;
                  setOpen(false);
                  generate.mutate(revision, {
                    onSettled: () => {
                      confirming.current = false;
                    },
                  });
                }}
              />
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
