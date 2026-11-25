import { useState } from 'react';
import type { WorkReviewEvidence } from '../../../../shared/contracts/work-review';
import { formatDayLong } from '../../../../shared/domain/periods';
import { PrTitle } from '../../../components/DeliveryTable';
import { useEvidence } from '../../../lib/links';

export function EvidenceList({ evidence }: { evidence: WorkReviewEvidence[] }) {
  if (evidence.length === 0) return null;
  return (
    <ul aria-label="Evidence" className="mt-2 flex flex-col gap-1">
      {evidence.map((item) => (
        <li key={`${item.kind}-${item.id}-${item.date}`}>
          <EvidenceDetails item={item} />
        </li>
      ))}
    </ul>
  );
}

function EvidenceDetails({ item }: { item: WorkReviewEvidence }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="min-w-0" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="w-fit max-w-full cursor-pointer rounded-sm py-1 text-label font-semibold text-action [overflow-wrap:anywhere] hover:underline max-[719px]:py-3">
        <span className="ms-1.5">{item.label}</span>
      </summary>
      <div className="mb-1 ms-4 rounded-sm border border-border bg-sunken px-3 py-2 text-copy [overflow-wrap:anywhere]">
        <p className="text-caption text-ink-muted">
          {item.kind === 'pr' ? 'Merged pull request' : 'Local session'}
          {item.repo ? ` · ${item.repo}` : ''} ·{' '}
          <time dateTime={item.date}>{formatDayLong(item.date)}</time>
        </p>
        {open && item.kind === 'pr' && <PullRequestEvidence id={item.id} />}
        {item.kind === 'session' && item.notes !== undefined && item.notes.length > 0 && (
          <ul className="mt-1 list-disc space-y-1 ps-5 text-copy text-ink">
            {item.notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

function PullRequestEvidence({ id }: { id: string }) {
  const details = useEvidence(id);
  if (details.data?.pr) return <PrTitle pr={details.data.pr} />;
  if (details.isPending) return <p role="status">Loading pull request…</p>;
  return <p>Pull request details are unavailable.</p>;
}
