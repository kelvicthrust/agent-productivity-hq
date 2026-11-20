// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SeriesBucket } from '../../src/client/lib/analytics';
import {
  RecordsDrawerProvider,
  bucketDrillUrl,
  bucketRef,
  useRecordsDrawer,
  type BucketRef,
} from '../../src/client/lib/recordsDrawer';
import {
  decodeFilters,
  defaultFilters,
  type FilterContext,
  type Filters,
} from '../../src/client/lib/filters';
import { checkRange } from '../../src/shared/domain/periods';

// The records drawer's shared state: Overview and Trends open it, the drawer feature shows it, the shell mounts both. And the
// "Open in Delivery/Usage" address, which carries the bucket's dates.

afterEach(cleanup);

const CTX: FilterContext = { today: '2026-11-04', lookbackStart: '2025-11-04' };
const bucket = (overrides: Partial<BucketRef> = {}): BucketRef => ({
  chart: 'overview',
  index: 2,
  start: '2026-11-02',
  end: '2026-11-02',
  label: 'Mon, Nov 2, 2026',
  ...overrides,
});

function Probe() {
  const drawer = useRecordsDrawer();
  const navigate = useNavigate();
  return (
    <div>
      <button type="button" onClick={() => drawer.open(bucket())}>
        open bar
      </button>
      <button
        type="button"
        onClick={() => drawer.open(bucket({ index: 3, label: 'Tue, Nov 3, 2026' }))}
      >
        open next
      </button>
      <button
        type="button"
        onClick={() =>
          drawer.open(bucket(), { returnFocus: () => screen.getByText('elsewhere').focus() })
        }
      >
        open custom
      </button>
      <button type="button" onClick={() => drawer.close()}>
        close
      </button>
      <button type="button" onClick={() => drawer.close({ restoreFocus: false })}>
        close quietly
      </button>
      <button type="button" onClick={() => void navigate('/trends')}>
        go
      </button>
      <button type="button">elsewhere</button>
      <output data-testid="state">
        {drawer.bucket ? `${drawer.bucket.label}|${drawer.bucket.index}` : 'closed'}
      </output>
    </div>
  );
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <RecordsDrawerProvider>
        <Probe />
      </RecordsDrawerProvider>
    </MemoryRouter>,
  );
}
const state = () => screen.getByTestId('state').textContent;
const press = (name: string) => fireEvent.click(screen.getByText(name));
const focused = () => document.activeElement?.textContent;

describe('RecordsDrawerProvider', () => {
  it('opens on a bucket and closes', () => {
    mount();
    expect(state()).toBe('closed');
    press('open bar');
    expect(state()).toBe('Mon, Nov 2, 2026|2');
    press('close');
    expect(state()).toBe('closed');
  });

  it('hands focus back to the element that opened it, once the drawer is gone', () => {
    mount();
    const opener = screen.getByText('open bar');
    opener.focus();
    fireEvent.click(opener);
    screen.getByText('elsewhere').focus(); // focus moves while the drawer is open
    press('close');
    expect(focused()).toBe('open bar');
  });

  it("uses the caller's own way of putting focus back when it gives one", () => {
    mount();
    screen.getByText('open custom').focus();
    press('open custom');
    press('close');
    expect(focused()).toBe('elsewhere');
  });

  it('keeps the first opener when the drawer is opened on another bucket while it is open', () => {
    mount();
    const opener = screen.getByText('open bar');
    opener.focus();
    fireEvent.click(opener);
    screen.getByText('open next').focus(); // stands in for focus inside the open drawer
    press('open next');
    expect(state()).toBe('Tue, Nov 3, 2026|3');
    press('close');
    expect(focused()).toBe('open bar');
  });

  it('does not touch focus when closed with restoreFocus false', () => {
    mount();
    const opener = screen.getByText('open bar');
    opener.focus();
    fireEvent.click(opener);
    screen.getByText('elsewhere').focus();
    press('close quietly');
    expect(focused()).toBe('elsewhere');
  });

  it('closes, without taking focus, when the page changes', () => {
    mount();
    const opener = screen.getByText('open bar');
    opener.focus();
    fireEvent.click(opener);
    expect(state()).not.toBe('closed');
    screen.getByText('elsewhere').focus();
    act(() => press('go'));
    expect(state()).toBe('closed');
    expect(focused()).toBe('elsewhere');
  });

  it('refuses to be used outside the provider, and says where it comes from', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      render(
        <MemoryRouter>
          <Probe />
        </MemoryRouter>,
      ),
    ).toThrow(/RecordsDrawerProvider/);
    quiet.mockRestore();
  });
});

describe('bucketRef', () => {
  it('takes the dates and label of a series bucket and remembers where it came from', () => {
    const series = {
      start: '2026-11-02',
      end: '2026-11-08',
      label: 'Nov 2–Nov 8',
      short: 'Nov 2',
      prs: 3,
      delivery: 'ok',
      tokens: {},
      usage: {},
    } as SeriesBucket;
    expect(bucketRef('trends', series, 4)).toEqual({
      chart: 'trends',
      index: 4,
      start: '2026-11-02',
      end: '2026-11-08',
      label: 'Nov 2–Nov 8',
    });
  });
});

describe('bucketDrillUrl', () => {
  const base = defaultFilters(CTX);
  /** The range a page reads from an address: the codec's own decode, with defaults filled in. */
  const rangeRead = (url: string, ctx: FilterContext = CTX) => {
    const query = url.includes('?') ? url.slice(url.indexOf('?')) : '';
    const read = decodeFilters(new URLSearchParams(query), ctx);
    return { start: read.start, end: read.end };
  };

  it("opens the target page on the bucket's own dates", () => {
    expect(bucketDrillUrl('delivery', { start: '2026-11-02', end: '2026-11-02' }, base, CTX)).toBe(
      '/delivery?start=2026-11-02&end=2026-11-02',
    );
    expect(bucketDrillUrl('usage', { start: '2026-10-05', end: '2026-10-11' }, base, CTX)).toBe(
      '/usage?start=2026-10-05&end=2026-10-11',
    );
  });

  it('keeps every other filter as it was', () => {
    const scoped: Filters = {
      ...base,
      repos: ['kelvin/a', 'kelvin/b'],
      provider: 'codex',
      author: 'all',
    };
    const url = bucketDrillUrl('usage', { start: '2026-10-05', end: '2026-10-11' }, scoped, CTX);
    const params = new URLSearchParams(url.slice(url.indexOf('?')));
    expect(url.startsWith('/usage?')).toBe(true);
    expect(Object.fromEntries(params)).toEqual({
      start: '2026-10-05',
      end: '2026-10-11',
      repos: 'kelvin/a,kelvin/b',
      provider: 'codex',
      author: 'all',
    });
  });

  // Today is Wed Nov 4, so the API takes an end up to Nov 30: the end of the month is later than the end of the week.
  // What a destination takes is decided once (clampRange in lib/filters, the API's own rule), and a bucket is moved only where it
  // is outside that.
  it('keeps a week that runs to Sunday: Nov 2 to 8, not Nov 2 to 4', () => {
    // The week of today is the default period, and the address leaves defaults out ("no params means This week"), so the page
    // reads Nov 2 to 8 from a bare address. What is asserted is the range the destination reads, which is what a person sees.
    for (const target of ['delivery', 'usage'] as const) {
      const url = bucketDrillUrl(target, { start: '2026-11-02', end: '2026-11-08' }, base, CTX);
      expect(url).toBe(`/${target}`);
      expect(rangeRead(url)).toEqual({ start: '2026-11-02', end: '2026-11-08' });
    }
    // The same week with another filter set says nothing more about its dates: still Nov 2 to 8
    const scoped: Filters = { ...base, author: 'all' };
    const url = bucketDrillUrl('usage', { start: '2026-11-02', end: '2026-11-08' }, scoped, CTX);
    expect(url).toBe('/usage?author=all');
    expect(rangeRead(url)).toEqual({ start: '2026-11-02', end: '2026-11-08' });
  });

  it('keeps a month that runs to its last day: Nov 1 to 30, not Nov 1 to 4', () => {
    expect(bucketDrillUrl('delivery', { start: '2026-11-01', end: '2026-11-30' }, base, CTX)).toBe(
      '/delivery?start=2026-11-01&end=2026-11-30',
    );
    expect(bucketDrillUrl('usage', { start: '2026-11-01', end: '2026-11-30' }, base, CTX)).toBe(
      '/usage?start=2026-11-01&end=2026-11-30',
    );
  });

  it('keeps a day that has not happened yet: Fri Nov 6, not today', () => {
    expect(bucketDrillUrl('delivery', { start: '2026-11-06', end: '2026-11-06' }, base, CTX)).toBe(
      '/delivery?start=2026-11-06&end=2026-11-06',
    );
    expect(bucketDrillUrl('usage', { start: '2026-11-06', end: '2026-11-06' }, base, CTX)).toBe(
      '/usage?start=2026-11-06&end=2026-11-06',
    );
  });

  it('keeps a bucket that starts after today and ends at the end of the month', () => {
    expect(bucketDrillUrl('delivery', { start: '2026-11-09', end: '2026-11-15' }, base, CTX)).toBe(
      '/delivery?start=2026-11-09&end=2026-11-15',
    );
  });

  it('moves a start before the 12-month lookback to its first day, and keeps the end', () => {
    expect(bucketDrillUrl('usage', { start: '2025-10-27', end: '2025-11-09' }, base, CTX)).toBe(
      '/usage?start=2025-11-04&end=2025-11-09',
    );
  });

  it('moves a date later than the API takes to the latest it takes, and only that date', () => {
    // Nov 30 is the latest end; the API refuses anything after it
    expect(bucketDrillUrl('delivery', { start: '2026-11-23', end: '2026-12-06' }, base, CTX)).toBe(
      '/delivery?start=2026-11-23&end=2026-11-30',
    );
    expect(bucketDrillUrl('delivery', { start: '2026-12-01', end: '2026-12-06' }, base, CTX)).toBe(
      '/delivery?start=2026-11-30&end=2026-11-30',
    );
  });

  it('takes the end of the week when that is later than the end of the month', () => {
    // Wed Dec 30: the month ends Dec 31, the week ends Sun Jan 3, so Jan 3 is the latest end
    const late: FilterContext = { today: '2026-12-30', lookbackStart: '2025-12-30' };
    const filters = defaultFilters(late);
    // a bucket across the new year, to the end of the week: kept
    expect(bucketDrillUrl('usage', { start: '2026-12-31', end: '2027-01-03' }, filters, late)).toBe(
      '/usage?start=2026-12-31&end=2027-01-03',
    );
    // one that runs past the end of the week and the month: the end goes to Jan 3, the start stays
    expect(bucketDrillUrl('usage', { start: '2026-12-31', end: '2027-01-10' }, filters, late)).toBe(
      '/usage?start=2026-12-31&end=2027-01-03',
    );
  });

  it('is exactly what the destination page reads back: decoding the address gives the bucket’s own range', () => {
    const buckets = [
      { start: '2026-11-02', end: '2026-11-02' }, // a day
      { start: '2026-11-04', end: '2026-11-04' }, // today
      { start: '2026-11-06', end: '2026-11-06' }, // an upcoming day
      { start: '2026-11-02', end: '2026-11-08' }, // a week to Sunday
      { start: '2026-10-26', end: '2026-11-01' }, // a past week
      { start: '2026-11-01', end: '2026-11-30' }, // the current month
      { start: '2026-10-01', end: '2026-10-31' }, // a past month
      { start: '2026-11-09', end: '2026-11-15' }, // the week after, still inside the month
    ];
    for (const target of ['delivery', 'usage'] as const) {
      for (const range of buckets) {
        const url = bucketDrillUrl(target, range, base, CTX);
        const read = decodeFilters(new URLSearchParams(url.slice(url.indexOf('?'))), CTX);
        expect(
          { start: read.start, end: read.end },
          `${target} ${range.start}..${range.end}`,
        ).toEqual(range);
      }
    }
  });

  it('never gives a range the API refuses (checkRange), for any bucket in or around the history', () => {
    const edges = [
      '2025-10-01',
      '2025-11-03',
      '2025-11-04',
      '2026-01-31',
      '2026-10-31',
      '2026-11-02',
      '2026-11-04',
      '2026-11-08',
      '2026-11-09',
      '2026-11-30',
      '2026-12-01',
      '2027-02-01',
    ];
    for (const start of edges) {
      for (const end of edges) {
        if (start > end) continue;
        const url = bucketDrillUrl('delivery', { start, end }, base, CTX);
        const params = new URLSearchParams(url.slice(url.indexOf('?')));
        const read = decodeFilters(params, CTX);
        const check = checkRange(read.start, read.end, CTX.today);
        expect(check.ok, `${start}..${end} -> ${read.start}..${read.end}`).toBe(true);
      }
    }
  });
});
