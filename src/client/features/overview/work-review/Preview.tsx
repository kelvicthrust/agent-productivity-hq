import { Button } from '@astryxdesign/core/Button';
import { Link } from 'react-router';
import { formatRange } from '../../../../shared/domain/periods';
import { Icon } from '../../../components/Icon';
import { searchFor, type FilterContext, type Filters } from '../../../lib/filters';
import { isPaseoBrowser } from '../../../lib/paseoBrowser';
import { GenerateReview } from './GenerateReview';
import { reviewScopeKey, useReviewAccount, useWorkReview } from './data';

export const REVIEW_LINK =
  'inline-flex w-fit items-center gap-1.5 rounded-sm text-label font-semibold text-action underline underline-offset-2 max-[719px]:min-h-11';

export function WorkReviewPreview({ filters, ctx }: { filters: Filters; ctx: FilterContext }) {
  const search = searchFor('', filters, ctx);
  return (
    <section
      aria-labelledby="ov-work-review-title"
      className="flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-md border border-border bg-surface p-4 shadow-card"
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h2 id="ov-work-review-title" className="font-display text-title-section text-ink">
          Work Review
        </h2>
        <p className="text-caption text-ink-muted">{formatRange(filters.start, filters.end)}</p>
      </div>
      {isPaseoBrowser() ? (
        <a href={`/work-review${search}`} className={REVIEW_LINK}>
          Open owner Work Review
        </a>
      ) : (
        <PreviewContent key={reviewScopeKey(filters)} filters={filters} search={search} />
      )}
    </section>
  );
}

function PreviewContent({ filters, search }: { filters: Filters; search: string }) {
  const result = useWorkReview(filters);
  const account = useReviewAccount();
  const state = result.data;
  const canGenerate = account.data?.status === 'connected' && !account.isError;

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link to={{ pathname: '/work-review', search }} className={REVIEW_LINK}>
          Open Work Review <Icon name="chevronRight" size={14} />
        </Link>
        {state && canGenerate ? (
          <GenerateReview filters={filters} state={state} />
        ) : result.isError ? (
          <Button
            label="Try again"
            size="sm"
            variant="secondary"
            className="max-[719px]:min-h-11"
            onClick={() => void result.refetch()}
          />
        ) : null}
      </div>
      {state?.review && (
        <p className="basis-full break-words text-copy font-semibold text-ink" role="status">
          {state.review.headline}
        </p>
      )}
      {state?.status === 'failed' && (
        <p role="alert" className="basis-full text-copy text-danger">
          {state.message ?? 'The work review couldn’t be generated. Try again.'}
        </p>
      )}
      {state?.review === null && state.status === 'idle' && (
        <p className="basis-full text-copy text-ink-muted">
          {canGenerate
            ? 'Generate a summary of merges and session progress using your connected ChatGPT plan.'
            : 'Open Work Review to check the ChatGPT connection for this installation.'}
        </p>
      )}
      {result.isError && !state && (
        <p role="alert" className="basis-full text-copy text-danger">
          Couldn’t load the work review.
        </p>
      )}
    </>
  );
}
