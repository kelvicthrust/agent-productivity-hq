import { Button } from '@astryxdesign/core/Button';
import { useState } from 'react';
import { Link } from 'react-router';
import { formatRange } from '../../../../shared/domain/periods';
import { deliveryScopeLabel, usageScopeLabel } from '../../../../shared/domain/scope';
import { PageHeader } from '../../../components/PageHeader';
import { useBootstrap } from '../../../lib/bootstrap';
import { PERIOD_LABEL } from '../../../lib/copy';
import { searchFor, useFilters, type Filters } from '../../../lib/filters';
import { isPaseoBrowser } from '../../../lib/paseoBrowser';
import { GenerateReview } from './GenerateReview';
import { REVIEW_LINK } from './Preview';
import { ReviewAccount } from './ReviewAccount';
import { CopyReview, ReviewReport } from './ReviewReport';
import { reviewScopeKey, useReviewAccount, useWorkReview } from './data';

export function WorkReviewRoute() {
  const { filters, ctx, period } = useFilters();
  const timeZone = useBootstrap().data?.timezone;
  const ownerLink = filters && ctx ? `/work-review${searchFor('', filters, ctx)}` : '/work-review';
  if (isPaseoBrowser()) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Work Review" />
        <a href={ownerLink} className={REVIEW_LINK}>
          Open owner Work Review
        </a>
      </div>
    );
  }
  if (!filters || !ctx || !period || !timeZone) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Work Review" />
        <p role="status" className="text-copy text-ink-muted">
          Loading work review…
        </p>
      </div>
    );
  }
  const range = formatRange(filters.start, filters.end);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Work Review" subtitle={`${PERIOD_LABEL[period]} · ${range}`} />
      <Link to={{ pathname: '/', search: searchFor('', filters, ctx) }} className={REVIEW_LINK}>
        Back to Overview
      </Link>
      <ReviewAccount />
      <ReviewScope
        key={reviewScopeKey(filters)}
        filters={filters}
        range={range}
        timeZone={timeZone}
      />
    </div>
  );
}

function ReviewScope({
  filters,
  range,
  timeZone,
}: {
  filters: Filters;
  range: string;
  timeZone: string;
}) {
  const [version, setVersion] = useState<number>();
  const result = useWorkReview(filters, version);
  const account = useReviewAccount();
  const state = result.data;
  const canGenerate = account.data?.status === 'connected' && !account.isError;

  return (
    <>
      <p className="text-caption text-ink-muted [overflow-wrap:anywhere]">
        PRs · {deliveryScopeLabel(filters)}. Sessions · {usageScopeLabel(filters)}.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {version === undefined && state && canGenerate && (
          <GenerateReview filters={filters} state={state} />
        )}
        {state?.review && (
          <CopyReview key={state.review.version} review={state.review} range={range} />
        )}
        {(version !== undefined || (state?.versions.length ?? 0) > 1) && (
          <label className="inline-flex flex-wrap items-center gap-2 text-label font-semibold text-ink">
            Review version
            <select
              value={version ?? ''}
              onChange={(event) =>
                setVersion(event.target.value ? Number(event.target.value) : undefined)
              }
              className="rounded-sm border border-control-border bg-surface px-2 py-1 text-copy text-ink max-[719px]:min-h-11"
            >
              <option value="">Latest version</option>
              {(state?.versions ?? (version === undefined ? [] : [version]))
                .toSorted((a, b) => b - a)
                .map((number) => (
                  <option key={number} value={number}>
                    Version {number}
                  </option>
                ))}
            </select>
          </label>
        )}
      </div>
      {state?.status === 'failed' && version === undefined && (
        <p role="alert" className="text-copy text-danger">
          {state.message ?? 'The work review couldn’t be generated. Try again.'}
        </p>
      )}
      {state?.review && state.changed && state.status === 'idle' && version === undefined && (
        <p role="status" className="text-copy text-ink-muted">
          {state.locked
            ? 'New evidence is available for this closed period.'
            : 'New evidence is available for this period.'}
        </p>
      )}
      {result.isPending && (
        <p role="status" className="text-copy text-ink-muted">
          Loading work review…
        </p>
      )}
      {result.isError && !state && (
        <div className="flex flex-wrap items-center gap-3" role="alert">
          <p className="text-copy text-danger">Couldn’t load the work review.</p>
          <Button
            label="Try again"
            size="sm"
            variant="secondary"
            onClick={() => void result.refetch()}
          />
        </div>
      )}
      {state?.review ? (
        <ReviewReport key={state.review.version} review={state.review} timeZone={timeZone} />
      ) : state?.status === 'idle' ? (
        <p className="rounded-md border border-dashed border-border-strong bg-surface p-4 text-copy text-ink-muted">
          No review has been saved for this scope.
          {canGenerate &&
            ' Generate an update to summarize merged pull requests and local session progress.'}
        </p>
      ) : null}
    </>
  );
}
