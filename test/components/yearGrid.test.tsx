// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  YEAR_GEOMETRY,
  YearGrid,
  cellTitle,
  layoutYearGrid,
  levelOf,
  yearSummary,
} from '../../src/client/components/YearGrid';

// G6_9: the year grid. `layoutYearGrid` is the whole geometry as a pure function; the component draws it with a text summary,
// a title on every cell and a focusable local scroller that opens on the newest weeks (the rendered check is in the browser
// specs once Trends mounts it, M7).

afterEach(cleanup);

// The API's window: today minus 365 days through today, so 366 days. 2025-11-04 is a Tuesday, 2026-11-04 a Wednesday.
const START = '2025-11-04';
const TODAY = '2026-11-04';
const COUNTS = {
  '2026-11-02': 3,
  '2026-10-30': 1,
  '2026-10-29': 9,
  '2026-01-05': 2,
  '2025-11-04': 4,
};
const DATA = {
  start: START,
  today: TODAY,
  counts: COUNTS,
  total: 19,
  daysWithMerge: 5,
  busiestDay: { date: '2026-10-29', count: 9 },
};

/** 0 = Monday … 6 = Sunday, worked out independently of the layout. */
const mondayFirst = (date: string) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;

describe('layoutYearGrid', () => {
  const layout = layoutYearGrid({ start: START, today: TODAY, counts: COUNTS });

  it('draws one cell for each day from start to today, and none outside', () => {
    expect(layout.cells).toHaveLength(366);
    expect(layout.cells[0]?.date).toBe(START);
    expect(layout.cells.at(-1)?.date).toBe(TODAY);
    expect(new Set(layout.cells.map((cell) => cell.date)).size).toBe(366);
  });

  it('puts Monday in row 0 and starts a new column each Monday', () => {
    for (const cell of layout.cells) expect(cell.row, cell.date).toBe(mondayFirst(cell.date));
    // the first day is a Tuesday, so it sits in row 1 of column 0 and the next Monday opens column 1
    expect(layout.cells[0]).toMatchObject({ col: 0, row: 1 });
    expect(layout.cells.find((cell) => cell.date === '2025-11-10')).toMatchObject({
      col: 1,
      row: 0,
    });
    expect(layout.cells.at(-1)).toMatchObject({ row: 2 });
  });

  it('places cells on the prototype grid: 14px apart, 30px for the weekday labels, 18px for the month labels', () => {
    const { step, padLeft, padTop } = YEAR_GEOMETRY;
    expect({ step, padLeft, padTop, cell: YEAR_GEOMETRY.cell }).toEqual({
      step: 14,
      padLeft: 30,
      padTop: 18,
      cell: 11,
    });
    for (const cell of layout.cells) {
      expect(cell.x, cell.date).toBe(padLeft + cell.col * step);
      expect(cell.y, cell.date).toBe(padTop + cell.row * step);
    }
    expect(layout.columns).toBe(53);
    expect(layout.width).toBe(padLeft + 53 * step);
    expect(layout.height).toBe(padTop + 7 * step);
  });

  it('grows the step to fill a measured width: floor((width - padLeft) / columns), the cell 3px smaller', () => {
    const wide = layoutYearGrid({ start: START, today: TODAY, counts: COUNTS, width: 1100 });
    // 53 columns: (1100 - 30) / 53 = 20.18, so a 20px step and a 17px cell
    expect(wide).toMatchObject({ step: 20, cell: 17, columns: 53, width: 30 + 53 * 20 });
    expect(wide.height).toBe(YEAR_GEOMETRY.padTop + 7 * 20);
    const third = wide.cells.find((cell) => cell.col === 2 && cell.row === 3)!;
    expect(third).toMatchObject({ x: 30 + 2 * 20, y: YEAR_GEOMETRY.padTop + 3 * 20 });
    expect(wide.width).toBeLessThanOrEqual(1100);
  });

  it('stops growing at a 22px step on very wide cards', () => {
    const huge = layoutYearGrid({ start: START, today: TODAY, counts: COUNTS, width: 3000 });
    expect(huge).toMatchObject({ step: 22, cell: 19, width: 30 + 53 * 22 });
  });

  it('never shrinks below the prototype step: a narrow width keeps 14px and 11px, and scrolls', () => {
    for (const width of [0, 240, 600, 772]) {
      const narrow = layoutYearGrid({ start: START, today: TODAY, counts: COUNTS, width });
      expect(narrow, `width ${width}`).toMatchObject({ step: 14, cell: 11, width: 30 + 53 * 14 });
    }
  });

  it('turns a count into a colour step, 4 and over being the darkest, and an absent day into a covered zero', () => {
    expect([0, 1, 2, 3, 4, 5, 9, -1].map(levelOf)).toEqual([0, 1, 2, 3, 4, 4, 4, 0]);
    const byDate = Object.fromEntries(layout.cells.map((cell) => [cell.date, cell]));
    expect(byDate['2026-11-02']).toMatchObject({ count: 3, level: 3 });
    expect(byDate['2026-10-29']).toMatchObject({ count: 9, level: 4 });
    expect(byDate['2025-11-04']).toMatchObject({ count: 4, level: 4 });
    expect(byDate['2026-03-03']).toMatchObject({ count: 0, level: 0 });
  });

  it('labels Mon, Wed and Fri beside the rows, and each month once, at least three columns apart', () => {
    expect(layout.weekdays.map((label) => label.text)).toEqual(['Mon', 'Wed', 'Fri']);
    const texts = layout.months.map((label) => label.text);
    expect(texts).toContain('Dec');
    expect(texts).toContain('Nov');
    const xs = layout.months.map((label) => label.x);
    for (let i = 1; i < xs.length; i += 1) {
      expect(xs[i]! - xs[i - 1]!, texts[i]).toBeGreaterThanOrEqual(3 * YEAR_GEOMETRY.step);
    }
    // a label sits above the column of a first-of-month day
    const dec = layout.cells.find((cell) => cell.date === '2025-12-01');
    expect(layout.months.find((label) => label.text === 'Dec')?.x).toBe(dec?.x);
  });

  it('outlines only the days of the selected period, and a period that runs past the window draws nothing extra', () => {
    const ranged = layoutYearGrid({
      start: START,
      today: TODAY,
      counts: COUNTS,
      range: { start: '2026-11-02', end: '2026-12-31' },
    });
    expect(ranged.cells).toHaveLength(366);
    expect(ranged.cells.filter((cell) => cell.inRange).map((cell) => cell.date)).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ]);
    expect(layout.cells.some((cell) => cell.inRange)).toBe(false);
  });

  it('draws nothing but the label column when today is before start', () => {
    const empty = layoutYearGrid({ start: '2026-11-05', today: '2026-11-04', counts: {} });
    expect(empty).toMatchObject({
      columns: 0,
      cells: [],
      months: [],
      width: YEAR_GEOMETRY.padLeft,
    });
  });
});

describe('the words', () => {
  it('writes a cell title with its weekday, date and count, singular for one', () => {
    expect(cellTitle({ date: '2026-11-02', row: 0, count: 3 })).toBe(
      'Mon, Nov 2, 2026: 3 merged PRs',
    );
    expect(cellTitle({ date: '2026-11-04', row: 2, count: 1 })).toBe(
      'Wed, Nov 4, 2026: 1 merged PR',
    );
    expect(cellTitle({ date: '2026-11-01', row: 6, count: 0 })).toBe(
      'Sun, Nov 1, 2026: 0 merged PRs',
    );
  });

  it('summarises the picture: the total, the days with a merge, the busiest day, and the outline', () => {
    const text = yearSummary(DATA, false);
    expect(text).toContain('Merged PRs per day for the last 12 months: 19 in total across 5 days.');
    expect(text).toContain('Busiest day');
    expect(text).toContain('with 9.');
    expect(text).not.toContain('outlined');
    expect(yearSummary(DATA, true)).toContain('Days in the selected period are outlined.');
    expect(yearSummary({ ...DATA, total: 0, daysWithMerge: 0, busiestDay: null }, false)).toBe(
      'Merged PRs per day for the last 12 months: 0 in total across 0 days.',
    );
  });
});

describe('YearGrid', () => {
  it('is a picture named by its summary, with a title on every cell', () => {
    const { container } = render(<YearGrid data={DATA} />);
    const picture = screen.getByRole('img');
    expect(picture.getAttribute('aria-label')).toBe(yearSummary(DATA, false));
    const titles = Array.from(container.querySelectorAll('svg title')).map((t) => t.textContent);
    expect(titles).toHaveLength(366);
    expect(titles).toContain('Mon, Nov 2, 2026: 3 merged PRs');
    expect(titles).toContain('Thu, Oct 29, 2026: 9 merged PRs');
    expect(titles).toContain('Tue, Nov 4, 2025: 4 merged PRs');
  });

  it('scrolls inside its own region, which a keyboard can reach and which has a name', () => {
    render(<YearGrid data={DATA} />);
    const region = screen.getByRole('region', { name: 'A year of merges, scrolls sideways' });
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(region.className).toContain('overflow-x-auto');
  });

  it('fills the width its region measures, and keeps the prototype size where there is none', () => {
    const { container, unmount } = render(<YearGrid data={DATA} />);
    expect(container.querySelector('svg')?.getAttribute('width')).toBe(String(30 + 53 * 14));
    unmount();
    const client = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1100);
    const wide = render(<YearGrid data={DATA} />);
    expect(wide.container.querySelector('svg')?.getAttribute('width')).toBe(String(30 + 53 * 20));
    expect(wide.container.querySelector('g[data-day] rect')?.getAttribute('width')).toBe('17');
    client.mockRestore();
  });

  it('opens on the newest weeks', () => {
    const width = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(772);
    render(<YearGrid data={DATA} />);
    expect(
      screen.getByRole('region', { name: 'A year of merges, scrolls sideways' }).scrollLeft,
    ).toBe(772);
    width.mockRestore();
  });

  it('outlines the selected period and says so in the summary', () => {
    const { container } = render(
      <YearGrid data={DATA} range={{ start: '2026-11-02', end: '2026-11-03' }} />,
    );
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('outlined');
    const outlined = Array.from(container.querySelectorAll('g[data-day]'))
      .filter((cell) => cell.querySelector('rect')?.getAttribute('class')?.includes('stroke-ink'))
      .map((cell) => cell.getAttribute('data-day'));
    expect(outlined).toEqual(['2026-11-02', '2026-11-03']);
  });

  it('answers a pointer on a day, and only then; there is no keyboard target (the recorded limitation)', () => {
    const onSelectDay = vi.fn();
    const { container, rerender } = render(
      <YearGrid data={DATA} onSelectDay={onSelectDay} dayHint="Click a day to look at it below." />,
    );
    fireEvent.click(container.querySelector('g[data-day="2026-11-02"] rect')!);
    expect(onSelectDay).toHaveBeenCalledExactlyOnceWith('2026-11-02');
    expect(screen.getByText('Click a day to look at it below.')).toBeTruthy();
    expect(container.querySelectorAll('svg a, svg button, svg [tabindex]')).toHaveLength(0);

    rerender(<YearGrid data={DATA} dayHint="Click a day to look at it below." />);
    fireEvent.click(container.querySelector('g[data-day="2026-11-02"] rect')!);
    expect(onSelectDay).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Click a day to look at it below.')).toBeNull();
  });

  it('says the same things in text under the picture', () => {
    const { container } = render(<YearGrid data={DATA} />);
    const text = container.querySelector('p')?.textContent ?? '';
    expect(text).toContain('19 merged PRs');
    expect(text).toContain('5 days with a merge');
    expect(text).toContain('Busiest day');
    expect(text).toContain('(9)');
  });
});
