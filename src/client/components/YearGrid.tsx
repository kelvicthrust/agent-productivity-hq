import { useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import type { YearResponse } from '../../shared/contracts/series';
import { formatDay, formatDayLong } from '../../shared/domain/periods';
import { addDays, diffDays, weekStart } from '../lib/filters';
import { cx } from '../lib/cx';
import { int, plural } from '../lib/format';

// A year of merges: one cell per day, Monday-start weeks as columns, drawn as SVG (ported from ui.js `yearGrid`, which built
// the same picture as a string; the geometry constants are the prototype's). Level 0 is a covered zero: the API leaves a day with
// no merge out of `counts`, and every day from `start` to `today` is drawn, so an empty cell means "covered, none". Days before
// `start` and after `today` are not drawn.
//
// The drawing is a picture with a text summary, not a control (design-to-code, "Year grid cells not keyboard-focusable"):
//   - the SVG is `role="img"` named by the summary sentence, and each cell has a `<title>` ("Mon, Nov 2, 2026: 3 merged PRs")
//     for a pointer;
//   - a cell is a pointer target when `onSelectDay` is given. A keyboard reaches any day through Custom range and the chart's
//     table view; that is an accepted, recorded limitation, not an oversight;
//   - the grid scrolls sideways inside its own region, which is focusable so a keyboard can scroll it (WCAG 2.1.1), shows a soft
//     edge on each side that has more to see, and opens on the newest weeks.
//
// The grid fills the width of its region: the step grows from the prototype's 14px to floor((width - padLeft) / columns), and
// the cell stays 3px smaller than the step. It never goes below the prototype's sizes, so a narrow screen scrolls sideways, and stops
// at a 22px step so a very wide window doesn't get oversized day cells.
//
// `layoutYearGrid` is the whole geometry as a pure function, so a unit test can check it without a browser.

// ---- layout (pure) ----------------------------------------------------------------------------------------------------------

/**
 * The prototype's constants, which are also the smallest sizes: 14px between cells, an 11px cell, 30px for the weekday labels,
 * 18px for the month labels. `gap` is the space between cells, so a wider step gives a wider cell.
 */
export const YEAR_GEOMETRY = {
  step: 14,
  cell: 11,
  padLeft: 30,
  padTop: 18,
  gap: 3,
  maxStep: 22,
} as const;

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;
/** Monday first. Only Mon, Wed and Fri are written beside the rows, as in the prototype. */
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const LABELLED_ROWS: ReadonlySet<number> = new Set([0, 2, 4]);
/** Two month labels are never closer than this many week columns, so "Nov" and "Dec" cannot overlap. */
const MONTH_LABEL_GAP = 3;

export type YearLevel = 0 | 1 | 2 | 3 | 4;

export interface YearGridInput {
  /** First day drawn, `YYYY-MM-DD`. */
  start: string;
  /** Last day drawn, `YYYY-MM-DD`. */
  today: string;
  /** Date → merged PRs. A date that is absent is a covered zero. */
  counts: Readonly<Record<string, number>>;
  /** The selected period, outlined. Days of it that lie outside `start..today` are simply not drawn. */
  range?: { start: string; end: string } | undefined;
  /** The pixel width available for the grid. Omitted or too small, the prototype's sizes are used. */
  width?: number | undefined;
}

export interface YearCell {
  date: string;
  /** The week column, 0 for the week that contains `start`. */
  col: number;
  /** 0 = Monday … 6 = Sunday. */
  row: number;
  x: number;
  y: number;
  count: number;
  /** 0 for none, then 1, 2, 3, and 4 for four or more: the colour step. */
  level: YearLevel;
  /** Inside the selected period. */
  inRange: boolean;
}

export interface YearLabel {
  text: string;
  x: number;
  y: number;
}

export interface YearGridLayout {
  /** Pixels between the cells' left edges, and a cell's own side. */
  step: number;
  cell: number;
  width: number;
  height: number;
  /** Week columns drawn: from the Monday on or before `start` to the week of `today`. */
  columns: number;
  cells: YearCell[];
  /** "Nov", "Dec"…: at the first day of a month, at most one per three columns. */
  months: YearLabel[];
  /** "Mon", "Wed", "Fri". */
  weekdays: YearLabel[];
}

/** The colour step of a day's count: 0, 1, 2, 3, or 4 for four and over. */
export const levelOf = (count: number): YearLevel =>
  count <= 0 ? 0 : count >= 4 ? 4 : (count as YearLevel);

/** Where every day from `start` to `today` goes, and what to write around them. */
export function layoutYearGrid(input: YearGridInput): YearGridLayout {
  const { padLeft, padTop, gap } = YEAR_GEOMETRY;
  const empty = input.today < input.start;
  const first = weekStart(input.start);
  const offset = empty ? 0 : diffDays(first, input.start);
  const days = empty ? 0 : diffDays(input.start, input.today) + 1;
  const columns = empty ? 0 : Math.floor((offset + days - 1) / 7) + 1;
  const step =
    columns > 0 && input.width
      ? Math.min(
          YEAR_GEOMETRY.maxStep,
          Math.max(YEAR_GEOMETRY.step, Math.floor((input.width - padLeft) / columns)),
        )
      : YEAR_GEOMETRY.step;
  const cell = step - gap;
  const height = padTop + 7 * step;
  const weekdays: YearLabel[] = WEEKDAYS.flatMap((text, row) =>
    LABELLED_ROWS.has(row)
      ? [{ text, x: 0, y: padTop + row * step + Math.round(cell / 2 + 3.5) }]
      : [],
  );
  if (empty) {
    return { step, cell, width: padLeft, height, columns: 0, cells: [], months: [], weekdays };
  }

  const { range } = input;

  const cells: YearCell[] = [];
  const months: YearLabel[] = [];
  let lastMonthCol = -MONTH_LABEL_GAP - 6;
  for (let index = 0; index < days; index += 1) {
    const date = addDays(input.start, index);
    const col = Math.floor((offset + index) / 7);
    const row = (offset + index) % 7;
    const x = padLeft + col * step;
    const y = padTop + row * step;
    if (date.slice(8) === '01' && col - lastMonthCol >= MONTH_LABEL_GAP) {
      months.push({ text: MONTHS[Number(date.slice(5, 7)) - 1]!, x, y: 11 });
      lastMonthCol = col;
    }
    const count = input.counts[date] ?? 0;
    cells.push({
      date,
      col,
      row,
      x,
      y,
      count,
      level: levelOf(count),
      inRange: range !== undefined && date >= range.start && date <= range.end,
    });
  }
  return { step, cell, width: padLeft + columns * step, height, columns, cells, months, weekdays };
}

// ---- words ------------------------------------------------------------------------------------------------------------------

/** What a cell's `<title>` says: "Mon, Nov 2, 2026: 3 merged PRs". */
export function cellTitle(cell: Pick<YearCell, 'date' | 'row' | 'count'>): string {
  return `${WEEKDAYS[cell.row]}, ${formatDayLong(cell.date)}: ${cell.count} merged ${plural(cell.count, 'PR')}`;
}

type YearData = Pick<YearResponse, 'start' | 'today' | 'counts' | 'total' | 'daysWithMerge'> &
  Partial<Pick<YearResponse, 'busiestDay'>>;

/**
 * The picture in words (ported from app.js `yearCard`): the total, how many days had a merge, the busiest day, and, when a
 * period is selected, that its days are outlined. This is the SVG's accessible name.
 */
export function yearSummary(data: YearData, outlined: boolean): string {
  const busiest = data.busiestDay;
  return [
    `Merged PRs per day for the last 12 months: ${int(data.total)} in total across ${int(data.daysWithMerge)} ${plural(data.daysWithMerge, 'day')}.`,
    busiest?.date !== undefined && busiest.count !== undefined
      ? `Busiest day ${formatDayLong(busiest.date)} with ${busiest.count}.`
      : null,
    outlined ? 'Days in the selected period are outlined.' : null,
  ]
    .filter((part) => part !== null)
    .join(' ');
}

const COPY = {
  scrollerLabel: 'A year of merges, scrolls sideways',
  fewer: 'Fewer',
  more: 'More',
  hint: 'Scroll sideways to see the full year; it opens on the newest weeks.',
} as const;

// ---- drawing ----------------------------------------------------------------------------------------------------------------

/** The edge cue (ported from app.css `.year-wrap`): a shadow on each side with more to scroll, drawn with background layers. */
const SCROLL_CUE = [
  'linear-gradient(to right, var(--color-surface), transparent) left center / 24px 100% no-repeat local',
  'linear-gradient(to left, var(--color-surface), transparent) right center / 24px 100% no-repeat local',
  'radial-gradient(farthest-side at 0 50%, var(--scroll-edge), transparent) left center / 10px 100% no-repeat scroll',
  'radial-gradient(farthest-side at 100% 50%, var(--scroll-edge), transparent) right center / 10px 100% no-repeat scroll',
].join(', ');

const LEVEL_FILL: Record<YearLevel, string> = {
  0: 'fill-sunken',
  1: 'fill-heat-1',
  2: 'fill-heat-2',
  3: 'fill-heat-3',
  4: 'fill-heat-4',
};
const LEVEL_SWATCH: Record<YearLevel, string> = {
  0: 'bg-sunken',
  1: 'bg-heat-1',
  2: 'bg-heat-2',
  3: 'bg-heat-3',
  4: 'bg-heat-4',
};

/** "Fewer ▢▢▢▢▢ More": the five colour steps. Decorative; the counts are in each cell's title and the summary. */
export function YearLegend({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx('flex items-center gap-1 text-caption text-ink-muted', className)}
    >
      {COPY.fewer}
      {([0, 1, 2, 3, 4] as const).map((level) => (
        <i
          key={level}
          className={cx('inline-block size-[11px] rounded-[3px]', LEVEL_SWATCH[level])}
        />
      ))}
      {COPY.more}
    </span>
  );
}

export interface YearGridProps {
  /** `GET /api/year`. */
  data: YearData;
  /** The selected period, outlined. */
  range?: { start: string; end: string } | undefined;
  /** A day was pressed. Cells are pointer targets only (see the note at the top of this file). */
  onSelectDay?: ((date: string) => void) | undefined;
  /** What pressing a day does, in words after the facts ("Click a day to look at it below."). Shown with `onSelectDay`. */
  dayHint?: string | undefined;
  className?: string;
}

export function YearGrid({ data, range, onSelectDay, dayHint, className }: YearGridProps) {
  // The grid is drawn to the width of its scroll region. Unmeasured (a first render, or no layout engine) it is the prototype's.
  const scroller = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setAvailable(Math.floor(element.clientWidth));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const layout = layoutYearGrid({
    start: data.start,
    today: data.today,
    counts: data.counts,
    range,
    width: available,
  });
  const summary = yearSummary(data, range !== undefined);
  const busiest = data.busiestDay;

  // Opens on the newest weeks. Only a change of width moves the scroll: a refetch with the same days keeps where the reader is.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element) element.scrollLeft = element.scrollWidth;
  }, [layout.width]);

  const select = onSelectDay
    ? (event: MouseEvent<SVGSVGElement>) => {
        const cell = event.target instanceof Element ? event.target.closest('[data-day]') : null;
        const day = cell?.getAttribute('data-day');
        if (day) onSelectDay(day);
      }
    : undefined;

  return (
    <div className={cx('flex min-w-0 flex-col gap-2', className)}>
      {/* A scrollable area a keyboard cannot focus fails WCAG 2.1.1 (axe `scrollable-region-focusable`), so the scroller is a
          labelled region with tabIndex 0. The lint rule allows tabIndex on a non-interactive element only for tabpanel. */}
      <div
        ref={scroller}
        role="region"
        aria-label={COPY.scrollerLabel}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className="overflow-x-auto pb-1"
        style={{ background: SCROLL_CUE }}
      >
        {/* The delegated click is the pointer path only: cells are not keyboard targets by design (recorded limitation). */}
        <svg
          role="img"
          aria-label={summary}
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className="block max-w-none"
          onClick={select}
        >
          {layout.weekdays.map((label) => (
            <text key={label.text} x={label.x} y={label.y} className="fill-ink-muted text-[11px]">
              {label.text}
            </text>
          ))}
          {layout.months.map((label) => (
            <text key={label.x} x={label.x} y={label.y} className="fill-ink-muted text-[11px]">
              {label.text}
            </text>
          ))}
          {layout.cells.map((cell) => (
            <g
              key={cell.date}
              data-day={cell.date}
              className={cx('group/cell', onSelectDay && 'cursor-pointer')}
            >
              <rect
                x={cell.x}
                y={cell.y}
                width={layout.cell}
                height={layout.cell}
                rx={3}
                className={cx(
                  LEVEL_FILL[cell.level],
                  cell.inRange && 'stroke-ink stroke-[1.2]',
                  onSelectDay && 'group-hover/cell:stroke-action group-hover/cell:stroke-[1.5]',
                )}
              >
                <title>{cellTitle(cell)}</title>
              </rect>
            </g>
          ))}
        </svg>
      </div>
      <p className="flex flex-wrap gap-x-6 gap-y-2 text-caption text-ink-muted">
        <span>
          <b className="text-label font-bold text-ink">{int(data.total)}</b> merged{' '}
          {plural(data.total, 'PR')}
        </span>
        <span>
          <b className="text-label font-bold text-ink">{int(data.daysWithMerge)}</b>{' '}
          {plural(data.daysWithMerge, 'day')} with a merge
        </span>
        {busiest?.date !== undefined && busiest.count !== undefined && (
          <span>
            Busiest day <b className="text-label font-bold text-ink">{formatDay(busiest.date)}</b> (
            {busiest.count})
          </span>
        )}
        {onSelectDay && dayHint && <span>{dayHint}</span>}
        <span className="min-[720px]:hidden">{COPY.hint}</span>
      </p>
    </div>
  );
}
