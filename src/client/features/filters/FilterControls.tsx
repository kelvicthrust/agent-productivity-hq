import { Button } from '@astryxdesign/core/Button';
import { Popover } from '@astryxdesign/core/Popover';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { formatRange } from '../../../shared/domain/periods';
import { PERIOD_LABEL } from '../../lib/copy';
import type { FilterChange, FilterContext, Filters, Period, PeriodPreset } from '../../lib/filters';
import type { FilterGroupId } from '../../lib/filterSlot';
import { CustomRangePanel } from './CustomRangePanel';
import {
  AUTHOR_OPTIONS,
  COPY,
  GRAN_OPTIONS,
  GROUPS,
  PROVIDER_OPTIONS,
  SEGMENT_PRESETS,
  timezoneLine,
} from './copy';
import { secondaryGroups } from './groups';
import { FilterIcon } from './icons';
import { RepoPanel, type RepoList } from './RepoPanel';

// The filter groups a screen uses, drawn two ways. On a wide screen the bar is one row: the period track, the date range, a
// Filters button and the time zone; the button's popover holds the screen's other groups (Group by, Repos, Provider, Author).
// On a phone the same groups are in the bottom sheet, one under another. The group rendering is shared (SecondaryGroups); what
// differs is where the Custom range and repo panels open: a popover anchored to the Custom button on a wide screen, in place
// (`inline`) inside the sheet and inside the Filters popover, where a popover over a popover or a sheet would crowd.

interface Props {
  inline: boolean;
  /** The groups the screen uses (the route's own list). */
  groups: readonly FilterGroupId[];
  /** How many of the secondary groups are off their default: the number on the Filters button. */
  activeCount: number;
  ctx: FilterContext;
  filters: Filters;
  period: Period;
  timezone: string | undefined;
  repoList: RepoList;
  repoLabel: string;
  apply: (change: FilterChange) => void;
}

function Group({
  id,
  label,
  scope,
  stacked = false,
  children,
}: {
  id?: string;
  label: string;
  scope?: string | undefined;
  /** The label always above its control (inside the Filters popover and the sheet); otherwise beside it from 720px. */
  stacked?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={
        stacked
          ? 'flex flex-col items-start gap-1.5'
          : 'flex flex-col items-start gap-1.5 min-[720px]:flex-row min-[720px]:items-center min-[720px]:gap-2'
      }
    >
      <span id={id} className="whitespace-nowrap text-caption text-ink-muted">
        {label}
        {scope !== undefined && <b className="font-semibold text-ink"> · {scope}</b>}
      </span>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  /** A value that is not one of the options leaves every segment unselected. */
  value: string;
  options: ReadonlyArray<readonly [T, string]>;
  onChange: (value: T) => void;
}) {
  return (
    <SegmentedControl
      label={label}
      value={value}
      onChange={(next) => {
        const hit = options.find(([option]) => option === next);
        if (hit) onChange(hit[0]);
      }}
    >
      {options.map(([option, text]) => (
        <SegmentedControlItem key={option} value={option} label={text} />
      ))}
    </SegmentedControl>
  );
}

const PILL_TRIGGER =
  'rounded-full aria-pressed:bg-selection-surface aria-pressed:font-semibold max-[719px]:min-h-11';

// The period track's last segment, on a wide screen and in the phone's sheet alike: the same 28px pill as the Astryx segments
// beside it, no border of its own, and the selected one a grape tint with a 1px grape ring, as the selected segments are. On a
// phone a pseudo-element grows the tap area to 44px (the button has a 1px border, so 9px past its padding box), as the segments' own rule does.
const SEGMENT_TRIGGER = [
  'relative h-7 min-h-0 gap-1.5 rounded-full border-transparent bg-transparent px-3 text-ink-muted shadow-none hover:text-ink',
  'aria-pressed:bg-selection-surface aria-pressed:font-semibold aria-pressed:text-action aria-pressed:ring-1 aria-pressed:ring-action',
  "max-[719px]:before:absolute max-[719px]:before:inset-x-0 max-[719px]:before:-inset-y-[9px] max-[719px]:before:content-['']",
].join(' ');

/** A panel that opens in place inside the sheet (the prototype's `.popover` is static and full width below 720px). */
function InlinePanel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="w-full rounded-md border border-border bg-canvas p-3"
    >
      {children}
    </div>
  );
}

/**
 * A button that opens a panel: a popover on a wide screen, an in-place disclosure inside the sheet. A `segment` is a button inside
 * the period track, so in the sheet it is only the button: its panel is drawn by the caller, below the whole track.
 */
function Disclosure({
  inline,
  open,
  onOpenChange,
  dialogLabel,
  triggerRef,
  trigger,
  segment = false,
  width = 320,
  children,
}: {
  inline: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dialogLabel: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  trigger: { content: ReactNode; label: string; pressed?: boolean; describedBy?: string };
  /** Drawn as the last segment of the period track; in the sheet its panel is the caller's, under the track. */
  segment?: boolean;
  width?: number;
  children: ReactNode;
}) {
  const button = (extra: { onClick?: () => void; expanded?: boolean }) => (
    <Button
      ref={triggerRef}
      label={trigger.label}
      size="sm"
      variant="secondary"
      aria-pressed={trigger.pressed}
      aria-describedby={trigger.describedBy}
      aria-expanded={extra.expanded}
      className={segment ? SEGMENT_TRIGGER : PILL_TRIGGER}
      onClick={extra.onClick}
    >
      {trigger.content}
    </Button>
  );
  if (inline && segment) return button({ onClick: () => onOpenChange(!open), expanded: open });
  if (inline) {
    return (
      <div className="flex w-full flex-col items-start gap-2">
        {button({ onClick: () => onOpenChange(!open), expanded: open })}
        {open && <InlinePanel label={dialogLabel}>{children}</InlinePanel>}
      </div>
    );
  }
  // Popover wires the trigger's own press, aria-expanded and aria-haspopup, so the button gets none of its own.
  return (
    <Popover
      isOpen={open}
      onOpenChange={onOpenChange}
      label={dialogLabel}
      width={width}
      padding={4}
      placement="below"
      alignment="start"
      content={children}
    >
      {button({})}
    </Popover>
  );
}

/** The screen's groups behind the Filters button, in a fixed order. Their panels open in place: they are already inside a popover or the sheet. */
function SecondaryGroups({
  groups,
  filters,
  repoList,
  repoLabel,
  apply,
}: Pick<Props, 'filters' | 'repoList' | 'repoLabel' | 'apply'> & {
  groups: readonly FilterGroupId[];
}) {
  const ids = useId();
  const [reposOpen, setReposOpen] = useState(false);
  const reposTrigger = useRef<HTMLButtonElement>(null);
  const has = (group: FilterGroupId) => groups.includes(group);
  return (
    <>
      {has('gran') && (
        <Group label={GROUPS.groupBy.label} stacked>
          <Segmented
            label={GROUPS.groupBy.label}
            value={filters.gran}
            options={GRAN_OPTIONS}
            onChange={(gran) => apply({ gran })}
          />
        </Group>
      )}
      {has('repos') && (
        <Group id={`${ids}-repos`} label={GROUPS.repos.label} scope={GROUPS.repos.scope} stacked>
          <Disclosure
            inline
            open={reposOpen}
            onOpenChange={setReposOpen}
            dialogLabel={COPY.repoDialog}
            triggerRef={reposTrigger}
            trigger={{
              label: repoLabel,
              describedBy: `${ids}-repos`,
              content: (
                <span className="flex items-center gap-1.5">
                  {repoLabel}
                  <FilterIcon name="chevronDown" className="text-ink-muted" />
                </span>
              ),
            }}
          >
            <RepoPanel
              list={repoList}
              selected={filters.repos}
              onChange={(repos) => apply({ repos })}
              onDone={() => {
                setReposOpen(false);
                reposTrigger.current?.focus();
              }}
            />
          </Disclosure>
        </Group>
      )}
      {has('provider') && (
        <Group label={GROUPS.provider.label} scope={GROUPS.provider.scope} stacked>
          <Segmented
            label={`${GROUPS.provider.label}, applies to ${GROUPS.provider.scope}`}
            value={filters.provider}
            options={PROVIDER_OPTIONS}
            onChange={(provider) => apply({ provider })}
          />
        </Group>
      )}
      {has('author') && (
        <Group label={GROUPS.author.label} scope={GROUPS.author.scope} stacked>
          <Segmented
            label={`PR ${GROUPS.author.label.toLowerCase()}, applies to ${GROUPS.author.scope}`}
            value={filters.author}
            options={AUTHOR_OPTIONS}
            onChange={(author) => apply({ author })}
          />
        </Group>
      )}
    </>
  );
}

export function FilterControls({
  inline,
  groups,
  activeCount,
  ctx,
  filters,
  period,
  timezone,
  repoList,
  repoLabel,
  apply,
}: Props) {
  const ids = useId();
  const [customOpen, setCustomOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const presetSelected = SEGMENT_PRESETS.find((preset) => preset === period) ?? '';
  const customActive = presetSelected === '';
  const customTrigger = useRef<HTMLButtonElement>(null);
  const filtersTrigger = useRef<HTMLButtonElement>(null);
  const hasSecondary = secondaryGroups(groups).length > 0;
  const choose = (change: FilterChange) => {
    apply(change);
    setCustomOpen(false);
  };
  // Closing the Custom panel from a button inside it hands focus back to the button that opened it. A popover does that itself;
  // an in-place panel in the sheet does not, and the button that had focus is gone with it.
  const closeCustom = () => {
    setCustomOpen(false);
    customTrigger.current?.focus();
  };

  const customPanel = (
    <CustomRangePanel
      ctx={ctx}
      filters={filters}
      period={period}
      onPreset={(preset) => {
        apply({ period: preset });
        closeCustom();
      }}
      onApply={(range) => {
        apply({ range });
        closeCustom();
      }}
      onCancel={closeCustom}
    />
  );

  // The prototype's .seg: one track holding the presets and Custom. A pill from 720px up, the medium radius below it, where a
  // wrapped track of pills looks wrong (and the sheet's Custom panel opens under the whole track).
  const periodTrack = (
    <div
      className={`inline-flex max-w-full flex-wrap items-center gap-0.5 bg-sunken p-0.5 [&>[role=radiogroup]]:bg-transparent [&>[role=radiogroup]]:p-0 ${
        inline ? 'rounded-md' : 'rounded-pill'
      }`}
    >
      <Segmented
        label={GROUPS.period.label}
        value={presetSelected}
        options={SEGMENT_PRESETS.map((preset) => [preset, PERIOD_LABEL[preset]] as const)}
        onChange={(preset: PeriodPreset) => choose({ period: preset })}
      />
      <Disclosure
        inline={inline}
        open={customOpen}
        onOpenChange={setCustomOpen}
        dialogLabel={COPY.customDialog}
        triggerRef={customTrigger}
        segment
        trigger={{
          label: customActive ? PERIOD_LABEL[period] : COPY.custom,
          pressed: customActive,
          content: (
            <span className="flex items-center gap-1.5">
              <FilterIcon name="calendar" />
              {customActive ? PERIOD_LABEL[period] : COPY.custom}
            </span>
          ),
        }}
      >
        {customPanel}
      </Disclosure>
    </div>
  );
  const range = (
    <span className="whitespace-nowrap text-label font-semibold">
      {formatRange(filters.start, filters.end)}
    </span>
  );
  const timezoneCaption = timezone !== undefined && (
    <span className="whitespace-nowrap text-caption text-ink-muted">{timezoneLine(timezone)}</span>
  );

  if (!inline) {
    const filtersLabel = activeCount > 0 ? `${COPY.filters} · ${activeCount}` : COPY.filters;
    // Read aloud, the bare count needs its noun: "Filters, 2 active".
    const filtersName = activeCount > 0 ? `${COPY.filters}, ${activeCount} active` : COPY.filters;
    // Two groups that wrap as wholes: the controls (period and Filters) always share a row, and the captions (dates and timezone)
    // follow on that row when it has room, or together on the next line at narrower widths, never one control alone.
    return (
      <>
        <div className="flex flex-none items-center gap-x-4">
          {periodTrack}
          {hasSecondary && (
            <Disclosure
              inline={false}
              open={filtersOpen}
              onOpenChange={setFiltersOpen}
              dialogLabel={COPY.filters}
              triggerRef={filtersTrigger}
              width={360}
              trigger={{
                label: filtersName,
                content: (
                  <span className="flex items-center gap-1.5">
                    <FilterIcon name="filter" />
                    {filtersLabel}
                    <FilterIcon name="chevronDown" className="text-ink-muted" />
                  </span>
                ),
              }}
            >
              <div className="flex flex-col gap-4 p-1">
                <SecondaryGroups
                  groups={groups}
                  filters={filters}
                  repoList={repoList}
                  repoLabel={repoLabel}
                  apply={apply}
                />
              </div>
            </Disclosure>
          )}
        </div>
        <div className="flex min-w-fit flex-1 items-baseline justify-between gap-x-4">
          {range}
          {timezoneCaption}
        </div>
      </>
    );
  }

  return (
    <>
      <Group id={`${ids}-period`} label={GROUPS.period.label}>
        {periodTrack}
        {customOpen && <InlinePanel label={COPY.customDialog}>{customPanel}</InlinePanel>}
      </Group>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {range}
        {timezoneCaption}
      </div>
      <SecondaryGroups
        groups={groups}
        filters={filters}
        repoList={repoList}
        repoLabel={repoLabel}
        apply={apply}
      />
    </>
  );
}
