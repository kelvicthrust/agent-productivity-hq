import { Fragment, useId, useState } from 'react';
import { Link } from 'react-router';
import { COVERAGE_COPY } from '../lib/copy';
import { cx } from '../lib/cx';
import type { CoverageGroup, CoverageSummary } from './coverageGroups';
import { Icon } from './Icon';
import { statusAppearance } from './StatusTag';

// The source coverage strip (D4), ported from app.js coverageStrip and app.css .coverage. It adapts to its own width with
// container queries, not the window's: compact groups (a label column and one row per source) by default, which always
// fit; the one-line capsule from 900px; and the group label stacks above its rows below 340px. A pill radius is used only
// in the capsule, where it stays one or two lines. Phones start with a disclosure above the same coverage body.
//
// State only, no prose: an icon and a few words per source. Build `groups` and `refreshed` with `describeCoverage`.

function Group({ group }: { group: CoverageGroup }) {
  const labelId = useId();
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className="grid grid-cols-[7.25rem_minmax(0,1fr)] items-start gap-x-3 gap-y-1 @max-[340px]:grid-cols-[minmax(0,1fr)] @[900px]:flex @[900px]:flex-wrap @[900px]:items-center @[900px]:gap-2"
    >
      <span
        id={labelId}
        className="pt-px text-caption font-semibold text-ink @[900px]:pt-0 @[900px]:font-normal @[900px]:text-ink-muted"
      >
        {group.label}
      </span>
      <div className="flex min-w-0 flex-col gap-1 @[900px]:contents">
        {group.items.map((item) => {
          const { icon, toneClass } = statusAppearance(item.state);
          return (
            <span
              key={item.name}
              className="inline-flex min-w-0 items-start gap-1.5 text-caption @[900px]:items-center"
            >
              <span className={`mt-px flex-none @[900px]:mt-0 ${toneClass}`}>
                <Icon name={icon} />
              </span>
              <span className="min-w-0">
                <b className="font-semibold text-ink">{item.name}</b> {item.text}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function CoverageStrip({
  groups,
  refreshed,
  attempted,
  manageTo = '/sources',
}: CoverageSummary & {
  /** Where "Manage sources" goes. */
  manageTo?: string;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const needsAttention = groups.some((group) =>
    group.items.some(({ state }) => ['partial', 'denied', 'failed', 'stale'].includes(state)),
  );
  return (
    <div className="@container">
      <section
        aria-label={COVERAGE_COPY.regionLabel}
        className="grid gap-0 rounded-md border border-border bg-surface min-[720px]:gap-2.5 min-[720px]:px-3.5 min-[720px]:py-3 @[900px]:flex @[900px]:flex-wrap @[900px]:items-center @[900px]:gap-x-4 @[900px]:gap-y-2 @[900px]:rounded-full @[900px]:px-4 @[900px]:py-2"
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((wasOpen) => !wasOpen)}
          className="flex min-h-11 min-w-0 cursor-pointer flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-md px-3.5 py-2 text-left text-label text-ink min-[720px]:hidden"
        >
          <span className="font-semibold">{COVERAGE_COPY.regionLabel}</span>
          <span className="ml-auto flex items-center gap-1.5">
            {needsAttention && (
              <span className="inline-flex items-center gap-1 text-caption text-warning">
                <Icon name="alert" />
                Needs attention
              </span>
            )}
            <Icon name={open ? 'chevronDown' : 'chevronRight'} />
          </span>
        </button>
        <div
          id={bodyId}
          className={cx(
            open ? 'grid gap-2.5 border-t border-border px-3.5 pt-3' : 'hidden',
            'min-[720px]:contents',
          )}
        >
          {groups.map((group, index) => (
            <Fragment key={group.id}>
              {index > 0 && (
                <span aria-hidden="true" className="hidden h-4 w-px bg-border @[900px]:block" />
              )}
              <Group group={group} />
            </Fragment>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border py-2.5 text-caption text-ink-muted min-[720px]:pb-0 @[900px]:ml-auto @[900px]:justify-start @[900px]:border-t-0 @[900px]:pt-0">
            {(refreshed || attempted) && (
              <span className="flex flex-wrap gap-x-3 gap-y-1">
                {refreshed && <span>{refreshed}</span>}
                {attempted && <span>{attempted}</span>}
              </span>
            )}
            <Link
              to={manageTo}
              // Keep a full touch target without putting extra space between the timestamps.
              className="inline-flex min-h-11 items-center min-[720px]:min-h-0"
            >
              {COVERAGE_COPY.manageSources}
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
