import { providersInScope } from '../../../shared/domain/scope';
import { ScopeLine } from '../../components/ScopeLine';
import type { Filters } from '../../lib/filters';
import type { Provider } from '../../../shared/contracts/common';
import { USAGE_COPY } from './copy';
import { useExpandedSet } from './expandedSet';
import { useUsageGroups } from './queries';
import { UsageTreeList } from './UsageTreeList';
import { UsageTreeTable } from './UsageTreeTable';
import { useIsPhone } from './useIsPhone';

// Sessions by repository. This component chooses the renderer and owns what both share:
//   - ONE media query read (`useIsPhone`) picks `UsageTreeTable` (640px and wider) or `UsageTreeList` (below). CSS never
//     decides which one exists and never changes a table's `display`;
//   - ONE expanded-set (`useExpandedSet`), so a group opened in the table is still open in the list and the other way
//     round when the window crosses 640px;
//   - the group summaries, which are cheap. A group's sessions are read only when it is opened (`useGroupView`).

const TREE = USAGE_COPY.tree;

export function UsageTree({
  filters,
  uncovered,
  timeZone,
}: {
  filters: Filters;
  /** Providers with no figures for the period: their group totals read "—" instead of a covered 0. */
  uncovered: ReadonlySet<Provider>;
  timeZone: string;
}) {
  const phone = useIsPhone();
  const expanded = useExpandedSet();
  const groups = useUsageGroups(filters);
  const ctx = {
    filters,
    providers: providersInScope(filters.provider),
    uncovered,
    timeZone,
    expanded,
  };
  const rows = groups.data?.groups ?? [];
  return (
    <section
      aria-labelledby="us-tree-title"
      aria-busy={groups.isFetching || undefined}
      className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4 shadow-card"
    >
      <div className="min-w-0">
        <h2 id="us-tree-title" className="font-display text-title-section text-ink">
          {TREE.title}
        </h2>
        <ScopeLine usage={filters}>{TREE.scope}</ScopeLine>
      </div>
      {groups.isError && !groups.data ? (
        <p role="alert" className="text-copy text-danger">
          {USAGE_COPY.loadFailed}
        </p>
      ) : !groups.data ? (
        <p role="status" className="text-copy text-ink-muted">
          {USAGE_COPY.loading}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-copy text-ink-muted">{TREE.empty}</p>
      ) : phone ? (
        <UsageTreeList groups={rows} ctx={ctx} />
      ) : (
        <UsageTreeTable groups={rows} ctx={ctx} />
      )}
    </section>
  );
}
