import { useIssueCount } from '../lib/bootstrap';

/**
 * The count of sources that need attention, on the Sources nav item. The visible digit is hidden from assistive
 * technology and the words are read instead, so the link's name is "Sources & repos, 2 issues". Nothing shows while the
 * count is unknown or zero.
 */
export function IssueBadge({ className }: { className?: string }) {
  const count = useIssueCount();
  if (count === null || count === 0) return null;
  return (
    <span
      className={`inline-flex h-5 min-w-5 flex-none items-center justify-center rounded-full bg-warning-surface px-1.5 text-caption font-bold text-warning ${className ?? ''}`}
    >
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">
        , {count} {count === 1 ? 'issue' : 'issues'}
      </span>
    </span>
  );
}
