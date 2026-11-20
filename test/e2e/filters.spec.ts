import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import {
  addDays,
  applyChange,
  canonicalSearch,
  checkCustomRange,
  decodeFilters,
  defaultFilters,
  defaultGranularity,
  diffDays,
  encodeFilters,
  filtersQuery,
  isIsoDate,
  monthEnd,
  monthStart,
  periodOf,
  presetRange,
  searchAfter,
  searchFor,
  weekEnd,
  weekStart,
  type FilterContext,
  type Filters,
  type PeriodPreset,
} from '../../src/client/lib/filters';
import { queryString } from '../../src/client/lib/api';
import * as shared from '../../src/shared/domain/periods.ts';
import { expect, test } from './fixtures';
import { closeFilters, filtersButton, filtersPanel, openFilters } from './helpers/filtersPopover';
import { ORIGIN } from './helpers/virtualOrigin';

// The filter bar (M4: A15). The first half is the URL codec (src/client/lib/filters.ts), checked in Node: it is pure, so
// no browser is needed, and every date helper in it is compared with the server's shared/domain/periods.ts. The second
// half drives the real build in a real browser against the seeded world: the bar on a desktop (one row under the page title:
// period, range, a Filters popover holding the screen's other groups, time zone), the phone summary and its Astryx Bottom
// Sheet, the URL they write, and the scope each group states. Each screen carries only the groups its data answers to. The fixed clock is Wed 2026-11-04 in
// America/Los_Angeles, so This week is Mon Nov 2 to Sun Nov 8.

const TODAY = '2026-11-04';
const CTX: FilterContext = { today: TODAY, lookbackStart: shared.lookbackStart(TODAY) }; // 2025-11-04
const WEEK = { start: '2026-11-02', end: '2026-11-08' };

const decode = (search: string, ctx = CTX): Filters =>
  decodeFilters(new URLSearchParams(search), ctx);

test.describe('URL codec', () => {
  test('no params means This week, all repos, all providers, mine', () => {
    expect(decode('')).toEqual({
      ...WEEK,
      gran: 'day',
      repos: [],
      provider: 'all',
      author: 'mine',
    });
    expect(encodeFilters(defaultFilters(CTX), CTX)).toEqual({});
    expect(searchFor('', defaultFilters(CTX), CTX)).toBe('');
  });

  test('defaults are omitted: only what differs is written, in a fixed order', () => {
    const base = defaultFilters(CTX);
    expect(searchAfter('', { provider: 'codex' }, CTX)).toBe('?provider=codex');
    expect(searchAfter('', { author: 'all' }, CTX)).toBe('?author=all');
    expect(searchAfter('', { gran: 'week' }, CTX)).toBe('?gran=week');
    expect(searchAfter('', { period: 'today' }, CTX)).toBe(`?start=${TODAY}&end=${TODAY}`);
    expect(
      encodeFilters({ ...base, provider: 'claude', author: 'all', repos: ['kelvin/a'] }, CTX),
    ).toEqual({
      repos: 'kelvin/a',
      provider: 'claude',
      author: 'all',
    });
    expect(
      Object.keys(
        encodeFilters(
          {
            ...base,
            ...presetRange('last-30', CTX),
            gran: 'week',
            repos: ['x/y'],
            provider: 'codex',
            author: 'all',
          },
          CTX,
        ),
      ),
    ).toEqual(['start', 'end', 'gran', 'repos', 'provider', 'author']);
    // Choosing the default again takes the param back out.
    expect(searchAfter('?provider=codex', { provider: 'all' }, CTX)).toBe('');
    expect(searchAfter(`?start=${TODAY}&end=${TODAY}`, { period: 'this-week' }, CTX)).toBe('');
    expect(searchAfter('?gran=week', { gran: 'day' }, CTX)).toBe('');
  });

  test('the granularity default follows the length of the range', () => {
    const gran = (days: number) =>
      defaultGranularity('2026-01-01', addDays('2026-01-01', days - 1));
    expect([gran(1), gran(45), gran(46), gran(200), gran(201), gran(366)]).toEqual([
      'day',
      'day',
      'week',
      'week',
      'month',
      'month',
    ]);
    // 91 days is Week by default, so choosing Week writes nothing; choosing Day writes it.
    const quarter = presetRange('last-90', CTX);
    expect(searchAfter(`?start=${quarter.start}&end=${quarter.end}`, { gran: 'week' }, CTX)).toBe(
      `?start=${quarter.start}&end=${quarter.end}`,
    );
    expect(searchAfter(`?start=${quarter.start}&end=${quarter.end}`, { gran: 'day' }, CTX)).toBe(
      `?start=${quarter.start}&end=${quarter.end}&gran=day`,
    );
  });

  test('every preset is a range, and a range that matches no preset is Custom', () => {
    const presets: PeriodPreset[] = [
      'today',
      'this-week',
      'this-month',
      'last-30',
      'last-90',
      'last-12m',
    ];
    for (const preset of presets) {
      const range = presetRange(preset, CTX);
      expect(periodOf(range, CTX), preset).toBe(preset);
      // A preset survives the URL: write it, read it back, and it is the same preset.
      const next = applyChange(defaultFilters(CTX), { period: preset }, CTX);
      expect(periodOf(decode(searchFor('', next, CTX)), CTX), preset).toBe(preset);
    }
    expect(presetRange('this-month', CTX)).toEqual({ start: '2026-11-01', end: '2026-11-30' });
    expect(presetRange('last-30', CTX)).toEqual({ start: '2026-10-06', end: TODAY });
    expect(presetRange('last-12m', CTX)).toEqual({ start: CTX.lookbackStart, end: TODAY });
    expect(periodOf({ start: '2026-10-01', end: '2026-10-31' }, CTX)).toBe('custom');
  });

  test('a new range takes the default grouping for its length; other changes keep the grouping', () => {
    const weekly = { ...defaultFilters(CTX), gran: 'week' as const };
    expect(applyChange(weekly, { period: 'today' }, CTX).gran).toBe('day');
    expect(applyChange(weekly, { period: 'last-12m' }, CTX).gran).toBe('month');
    expect(
      applyChange(weekly, { range: { start: '2026-09-01', end: '2026-09-30' } }, CTX).gran,
    ).toBe('day');
    expect(applyChange(weekly, { provider: 'codex' }, CTX).gran).toBe('week');
    expect(applyChange(weekly, { reset: true }, CTX)).toEqual(defaultFilters(CTX));
  });

  test('Custom is clamped to the 12-month lookback and to the end of this week or month', () => {
    // Before the lookback starts: held at the first day the data covers.
    expect(decode('start=2020-01-01&end=2026-11-04')).toMatchObject({
      start: CTX.lookbackStart,
      end: TODAY,
    });
    // After the current month ends: held at the last day the API accepts (the end of the month here, Nov 30).
    expect(decode('start=2026-10-01&end=2030-01-01')).toMatchObject({
      start: '2026-10-01',
      end: '2026-11-30',
    });
    // A week that runs into the next month is allowed to finish (Mon 2026-11-30 .. Sun 2026-12-06).
    const monday = { today: '2026-11-30', lookbackStart: shared.lookbackStart('2026-11-30') };
    expect(decode('start=2026-11-30&end=2027-06-01', monday).end).toBe('2026-12-06');
    // Wholly out of range: both ends are pulled in, and the range is still valid.
    expect(decode('start=2019-01-01&end=2019-02-01')).toMatchObject({
      start: CTX.lookbackStart,
      end: CTX.lookbackStart,
    });
    // Backwards: the dates are swapped, not refused.
    expect(decode('start=2026-11-03&end=2026-10-01')).toMatchObject({
      start: '2026-10-01',
      end: '2026-11-03',
    });
    // Not dates at all: ignored, so the week stands. One date alone borrows the other from the week.
    expect(decode('start=nope&end=2026-02-30')).toMatchObject(WEEK);
    expect(decode('start=2026-11-03')).toMatchObject({ start: '2026-11-03', end: WEEK.end });
    expect(decode('end=2026-11-03')).toMatchObject({ start: WEEK.start, end: '2026-11-03' });
  });

  test('anything the URL says decodes to a range the API accepts, and decoding what was encoded changes nothing', () => {
    // A small deterministic generator: a spread of valid dates, impossible dates and noise.
    let seed = 20261104;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
    const dates = [
      '',
      'nope',
      '2026-13-01',
      '2026-02-30',
      '0000-00-00',
      '2999-12-31',
      '1999-01-01',
    ];
    for (let i = 0; i < 400; i++) {
      dates.push(addDays('2024-06-01', Math.floor(next() * 1000)));
    }
    const pick = () => dates[Math.floor(next() * dates.length)]!;
    for (const today of [TODAY, '2026-11-30', '2027-03-01', '2028-02-29', '2026-03-29']) {
      const ctx = { today, lookbackStart: shared.lookbackStart(today) };
      for (let i = 0; i < 150; i++) {
        const params = new URLSearchParams({
          start: pick(),
          end: pick(),
          gran: i % 5 === 0 ? 'hour' : 'week',
        });
        const filters = decodeFilters(params, ctx);
        expect(shared.checkRange(filters.start, filters.end, today), `${today} ${params}`).toEqual({
          ok: true,
        });
        const again = decodeFilters(new URLSearchParams(searchFor('', filters, ctx)), ctx);
        expect(again, `${today} ${params}`).toEqual(filters);
      }
    }
  });

  test('provider, author, gran and repos fall back to their defaults when they are not valid', () => {
    expect(decode('provider=gemini&author=nobody&gran=hour')).toEqual(defaultFilters(CTX));
    expect(decode('provider=claude&author=all&gran=month')).toMatchObject({
      provider: 'claude',
      author: 'all',
      gran: 'month',
    });
    // Repos: trimmed, de-duplicated and ordered, so one selection is one URL.
    expect(decode('repos=b/x, a/y,,b/x').repos).toEqual(['a/y', 'b/x']);
    expect(searchAfter('', { repos: ['kelvin/b', 'kelvin/a', 'kelvin/a'] }, CTX)).toBe(
      '?repos=kelvin/a,kelvin/b',
    );
    expect(decode('repos=kelvin%2Fa%2Ckelvin%2Fb').repos).toEqual(['kelvin/a', 'kelvin/b']);
  });

  test('the URL is rewritten only when it says more or less than it means', () => {
    expect(canonicalSearch('', CTX)).toBeNull();
    expect(canonicalSearch('?provider=codex&q=late', CTX)).toBeNull();
    expect(canonicalSearch('?repos=kelvin%2Fa%2Ckelvin%2Fb', CTX)).toBeNull();
    expect(canonicalSearch('?provider=all&author=mine', CTX)).toBe('');
    expect(canonicalSearch(`?start=${WEEK.start}&end=${WEEK.end}&gran=day`, CTX)).toBe('');
    expect(canonicalSearch('?provider=codex&provider=claude', CTX)).toBe('?provider=codex');
    expect(canonicalSearch('?start=2020-01-01&end=2026-11-04&q=late', CTX)).toBe(
      `?start=${CTX.lookbackStart}&end=${TODAY}&q=late`,
    );
    expect(canonicalSearch('?start=garbage', CTX)).toBe('');
    // Writing the canonical form is a fixed point.
    const once = canonicalSearch('?end=2031-01-01&provider=all&repos=b,a', CTX)!;
    expect(canonicalSearch(once, CTX)).toBeNull();
  });

  test('other params are kept, and a selected bucket is dropped only when the range or grouping moves', () => {
    const here = '?q=late&sel=2026-11-03';
    expect(searchAfter(here, { provider: 'claude' }, CTX)).toBe(
      '?provider=claude&q=late&sel=2026-11-03',
    );
    expect(searchAfter(here, { period: 'today' }, CTX)).toBe(`?start=${TODAY}&end=${TODAY}&q=late`);
    expect(searchAfter(here, { gran: 'week' }, CTX)).toBe('?gran=week&q=late');
    expect(searchAfter(here, { period: 'this-week' }, CTX)).toBe(here);
    // Reset keeps the bucket while the range stays the same, and drops it when Reset moves the range back to the week.
    expect(searchAfter('?sel=a&q=b&provider=codex', { reset: true }, CTX)).toBe('?sel=a&q=b');
    expect(searchAfter(`?start=${TODAY}&end=${TODAY}&sel=a&q=b`, { reset: true }, CTX)).toBe(
      '?q=b',
    );
  });

  test('a custom range is checked for both dates, their order and the lookback', () => {
    const check = (start: string, end: string) => checkCustomRange(start, end, CTX);
    expect(check('2026-10-01', '2026-10-31')).toEqual({ ok: true });
    expect(check(CTX.lookbackStart, TODAY)).toEqual({ ok: true });
    expect(check('', TODAY)).toEqual({ ok: false, reason: 'missing' });
    expect(check('2026-10-01', '2026-02-30')).toEqual({ ok: false, reason: 'missing' });
    expect(check('2026-10-31', '2026-10-01')).toEqual({ ok: false, reason: 'order' });
    expect(check('2025-11-03', TODAY)).toEqual({ ok: false, reason: 'outside' });
    expect(check('2026-11-01', '2026-11-05')).toEqual({ ok: false, reason: 'outside' }); // tomorrow is not a custom date
  });

  test('the API query carries every filter, repos joined by commas', () => {
    const filters: Filters = {
      ...defaultFilters(CTX),
      repos: ['kelvin/a', 'kelvin/b'],
      provider: 'codex',
    };
    expect(queryString(filtersQuery(filters))).toBe(
      '?author=mine&end=2026-11-08&gran=day&provider=codex&repos=kelvin%2Fa%2Ckelvin%2Fb&start=2026-11-02',
    );
    expect(queryString(filtersQuery(defaultFilters(CTX)))).not.toContain('repos');
  });

  test('the date helpers agree with the server for every day of four years', () => {
    // The browser does its own calendar arithmetic (no Temporal there); the server's shared/domain/periods.ts is the
    // reference, so any drift between them fails here.
    for (let d = '2024-01-01'; d <= '2027-12-31'; d = shared.addDays(d, 1)) {
      expect(isIsoDate(d), d).toBe(true);
      expect(addDays(d, -37), d).toBe(shared.addDays(d, -37));
      expect(addDays(d, 366), d).toBe(shared.addDays(d, 366));
      expect(diffDays(d, '2027-12-31'), d).toBe(shared.diffDays(d, '2027-12-31'));
      expect(weekStart(d), d).toBe(shared.weekStart(d));
      expect(weekEnd(d), d).toBe(shared.weekEnd(d));
      expect(monthStart(d), d).toBe(shared.monthStart(d));
      expect(monthEnd(d), d).toBe(shared.monthEnd(d));
      const ctx = { today: d, lookbackStart: shared.lookbackStart(d) };
      for (const [mine, theirs] of [
        ['this-week', 'this-week'],
        ['this-month', 'this-month'],
        ['last-30', 'last-30'],
        ['last-90', 'last-90'],
        ['last-12m', 'last-12m'],
      ] as const) {
        expect(presetRange(mine, ctx), `${mine} on ${d}`).toEqual(shared.presetRange(theirs, d));
      }
      expect(presetRange('today', ctx)).toEqual({ start: d, end: d });
    }
    for (const bad of [
      '2026-02-29',
      '2026-13-01',
      '2026-00-10',
      '2026-1-1',
      '26-01-01',
      '2026-01-01T00:00',
    ]) {
      expect(isIsoDate(bad), bad).toBe(shared.isDateString(bad));
    }
    for (const days of [1, 7, 45, 46, 120, 200, 201, 366]) {
      expect(defaultGranularity('2026-01-01', addDays('2026-01-01', days - 1))).toBe(
        shared.defaultGranularity('2026-01-01', shared.addDays('2026-01-01', days - 1)),
      );
    }
  });
});

// ---- the bar in a browser ----------------------------------------------------------------------------------------------

const bar = (page: Page) => page.getByRole('region', { name: 'Filters' });
const period = (page: Page, name: string) => page.getByRole('radio', { name });

async function open(page: Page, path = '/', width = 1280) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`${ORIGIN}${path}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

/** What the page's own server says today and the lookback start are, so a test never hard-codes the clock. */
async function bootstrap(page: Page) {
  return page.evaluate(
    async () =>
      (await (await fetch('/api/bootstrap')).json()) as { today: string; lookbackStart: string },
  );
}

const search = (page: Page) => new URL(page.url()).search;

test.describe('on a desktop', () => {
  // `world` serves the production build and the real API over a seeded database on the page.
  test.beforeEach(async ({ world }) => {
    void world;
  });

  test('no params opens on This week, with a clean URL', async ({ page }) => {
    await open(page);
    await expect(period(page, 'This week')).toBeChecked();
    await expect(bar(page)).toContainText('Nov 2 – Nov 8, 2026');
    await expect(bar(page)).toContainText('Times in America/Los_Angeles (this machine)');
    // Nothing is off its default, so the button carries no number. The other groups are behind it.
    await expect(filtersButton(page)).toHaveText('Filters');
    await expect(page.getByRole('radio', { name: 'Mine' })).toHaveCount(0);
    const panel = await openFilters(page);
    await expect(panel.getByRole('button', { name: 'All repos' })).toBeVisible();
    await expect(panel.getByRole('radio', { name: 'All', exact: true })).toBeChecked(); // provider
    await expect(panel.getByRole('radio', { name: 'Mine' })).toBeChecked();
    await expect(panel.getByRole('radio', { name: 'Day', exact: true })).toBeChecked();
    expect(search(page)).toBe('');
  });

  test('the bar is one row under the title: period, range, Filters, and the time zone at the right', async ({
    page,
  }) => {
    await open(page, '/', 1280);
    const title = await page.getByRole('heading', { level: 1 }).boundingBox();
    const centre = async (locator: ReturnType<Page['locator']>) => {
      const box = await locator.boundingBox();
      return (box?.y ?? 0) + (box?.height ?? 0) / 2;
    };
    const today = await centre(period(page, 'Today'));
    const filters = await centre(filtersButton(page));
    const zone = await centre(bar(page).getByText(/^Times in /));
    expect(Math.abs(today - filters)).toBeLessThanOrEqual(4);
    expect(Math.abs(today - zone)).toBeLessThanOrEqual(4);
    // Under the title, and as short as one row of controls: no tall panel.
    expect((await bar(page).boundingBox())?.y ?? 0).toBeGreaterThan(
      (title?.y ?? 0) + (title?.height ?? 0),
    );
    expect((await bar(page).boundingBox())?.height ?? 0).toBeLessThanOrEqual(56);
    const zoneBox = await bar(page)
      .getByText(/^Times in /)
      .boundingBox();
    const filtersBox = await filtersButton(page).boundingBox();
    expect(zoneBox?.x ?? 0).toBeGreaterThan((filtersBox?.x ?? 0) + (filtersBox?.width ?? 0));
  });

  test('a year-long range wraps as whole groups at the desktop breakpoint, and fits one row on a wide screen', async ({
    page,
  }) => {
    const centre = async (locator: Locator) => {
      const box = await locator.boundingBox();
      return box!.y + box!.height / 2;
    };
    const parts = () => {
      const row = bar(page);
      return {
        period: row.getByRole('button', { name: 'Last 12 months' }),
        filters: filtersButton(page),
        range: row.getByText('Nov 4, 2025 – Nov 4, 2026', { exact: true }),
        zone: row.getByText(/^Times in /),
      };
    };
    // 720px cannot hold all four (about 1,010px of content): the controls keep one row, the captions share the next.
    await open(page, '/?start=2025-11-04&end=2026-11-04&provider=codex&author=all', 720);
    let p = parts();
    for (const part of Object.values(p)) await expect(part).toBeVisible();
    expect(Math.abs((await centre(p.period)) - (await centre(p.filters)))).toBeLessThanOrEqual(4);
    expect(Math.abs((await centre(p.range)) - (await centre(p.zone)))).toBeLessThanOrEqual(4);
    expect(await centre(p.range)).toBeGreaterThan(await centre(p.filters));
    // A wide screen has room for everything on one row.
    await open(page, '/?start=2025-11-04&end=2026-11-04&provider=codex&author=all', 1440);
    p = parts();
    const centres = await Promise.all(Object.values(p).map(centre));
    expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(4);
  });

  test('each group label states its scope, and provider and author say what they apply to', async ({
    page,
  }) => {
    await open(page);
    const panel = await openFilters(page);
    await expect(panel.getByText('Repos · usage & delivery')).toBeVisible();
    await expect(panel.getByText('Provider · usage only')).toBeVisible();
    await expect(panel.getByText('Author · delivery only')).toBeVisible();
    await expect(
      panel.getByRole('radiogroup', { name: 'Provider, applies to usage only' }),
    ).toBeVisible();
    await expect(
      panel.getByRole('radiogroup', { name: 'PR author, applies to delivery only' }),
    ).toBeVisible();
    // The repo button is described by its scope label, so a screen reader hears it with the button.
    const repoButton = panel.getByRole('button', { name: 'All repos' });
    await expect(repoButton).toHaveAccessibleDescription('Repos · usage & delivery');
  });

  test('choosing a period writes start and end; choosing This week again writes nothing', async ({
    page,
  }) => {
    await open(page);
    await period(page, 'Today').click();
    await expect(page).toHaveURL(`${ORIGIN}/?start=2026-11-04&end=2026-11-04`);
    await expect(period(page, 'Today')).toBeChecked();
    await expect(bar(page)).toContainText('Nov 4, 2026');
    await period(page, 'This month').click();
    await expect(page).toHaveURL(`${ORIGIN}/?start=2026-11-01&end=2026-11-30`);
    await expect(bar(page)).toContainText('Nov 1 – Nov 30, 2026');
    await period(page, 'This week').click();
    await expect(page).toHaveURL(`${ORIGIN}/`);
    await expect(period(page, 'This week')).toBeChecked();
  });

  test('provider, author and grouping write only what is not the default', async ({ page }) => {
    await open(page);
    const panel = await openFilters(page);
    await panel.getByRole('radio', { name: 'Codex' }).click();
    await expect(page).toHaveURL(`${ORIGIN}/?provider=codex`);
    await expect(filtersButton(page)).toHaveText('Filters · 1');
    await panel.getByRole('radio', { name: 'All in tracked repos' }).click();
    await expect(page).toHaveURL(`${ORIGIN}/?provider=codex&author=all`);
    await panel.getByRole('radio', { name: 'Week', exact: true }).click();
    await expect(page).toHaveURL(`${ORIGIN}/?gran=week&provider=codex&author=all`);
    await expect(filtersButton(page)).toHaveText('Filters · 3');
    // Back to every default: the URL is empty again and the button carries no number.
    await panel.getByRole('radio', { name: 'All', exact: true }).click();
    await panel.getByRole('radio', { name: 'Mine' }).click();
    await panel.getByRole('radio', { name: 'Day', exact: true }).click();
    await expect(page).toHaveURL(`${ORIGIN}/`);
    await expect(filtersButton(page)).toHaveText('Filters');
  });

  test('a shared link restores every filter, and Back and Forward move through them', async ({
    page,
  }) => {
    // Delivery answers to the period, repos and author: those are the groups its popover holds.
    await open(page, '/delivery?author=all&repos=kelvin/atlas-api');
    await expect(filtersButton(page)).toHaveText('Filters · 2');
    const delivery = await openFilters(page);
    await expect(delivery.getByRole('radio', { name: 'All in tracked repos' })).toBeChecked();
    await expect(delivery.getByRole('button', { name: /atlas-api/ })).toBeVisible();

    await open(page, '/usage');
    await period(page, 'Today').click();
    await expect(page).toHaveURL(`${ORIGIN}/usage?start=2026-11-04&end=2026-11-04`);
    const panel = await openFilters(page);
    await panel.getByRole('radio', { name: 'Codex' }).click();
    await expect(page).toHaveURL(`${ORIGIN}/usage?start=2026-11-04&end=2026-11-04&provider=codex`);
    await closeFilters(page);
    await page.goBack();
    await expect(page).toHaveURL(`${ORIGIN}/usage?start=2026-11-04&end=2026-11-04`);
    await expect(filtersButton(page)).toHaveText('Filters');
    await expect(
      (await openFilters(page)).getByRole('radio', { name: 'All', exact: true }),
    ).toBeChecked();
    await closeFilters(page);
    await page.goBack();
    await expect(page).toHaveURL(`${ORIGIN}/usage`);
    await expect(period(page, 'This week')).toBeChecked();
    await page.goForward();
    await expect(period(page, 'Today')).toBeChecked();
  });

  test('the filter bar sits under the title of Overview, Trends, Delivery and Usage, and nowhere else', async ({
    page,
  }) => {
    for (const path of ['/', '/trends', '/delivery', '/usage']) {
      await open(page, path);
      await expect(bar(page), path).toBeVisible();
      // Title, then subtitle, then the bar.
      const order = await page.evaluate(() => {
        const heading = document.querySelector('h1');
        const region = document.querySelector('section[aria-label="Filters"]');
        return heading && region
          ? Boolean(heading.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING)
          : false;
      });
      expect(order, path).toBe(true);
    }
    // Sources and HQ have nothing to filter by. Setup is a separate route without navigation or filters, and an address that matches
    // no screen has none either.
    for (const path of ['/sources', '/hq', '/setup', '/nowhere']) {
      await open(page, path);
      await expect(bar(page), path).toHaveCount(0);
      await expect(filtersButton(page), path).toHaveCount(0);
    }
  });

  // What each screen's data answers to (src/client/app/routes.ts). The popover holds exactly these, each with the scope it states.
  const groupsOf = [
    ['/', { gran: true, repos: true, provider: true, author: true }],
    ['/trends', { gran: true, repos: true, provider: true, author: true }],
    ['/delivery', { gran: false, repos: true, provider: false, author: true }],
    ['/usage', { gran: false, repos: true, provider: true, author: false }],
  ] as const;
  for (const [path, groups] of groupsOf) {
    test(`${path}: the Filters popover holds only the groups the screen uses`, async ({ page }) => {
      await open(page, path);
      const panel = await openFilters(page);
      const count = (on: boolean) => (on ? 1 : 0);
      await expect(panel.getByRole('radiogroup', { name: 'Group by' })).toHaveCount(
        count(groups.gran),
      );
      await expect(panel.getByText('Repos · usage & delivery')).toHaveCount(count(groups.repos));
      await expect(panel.getByText('Provider · usage only')).toHaveCount(count(groups.provider));
      await expect(panel.getByText('Author · delivery only')).toHaveCount(count(groups.author));
      // The period has its own control on the bar, not in the popover.
      await expect(panel.getByRole('radio', { name: 'This week' })).toHaveCount(0);
      await expect(period(page, 'This week')).toBeVisible();
    });
  }

  test('the Filters popover is a dialog: Enter opens it, Escape closes it and focus returns to the button', async ({
    page,
  }) => {
    await open(page);
    await filtersButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(filtersPanel(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(filtersPanel(page)).toBeHidden();
    await expect(filtersButton(page)).toBeFocused();
  });

  test('the button counts only the screen’s own groups that are off their default', async ({
    page,
  }) => {
    await open(page, '/usage?provider=codex&author=all&repos=kelvin/atlas-api');
    await expect(filtersButton(page)).toHaveText('Filters · 2'); // repos and provider; Usage has no author
    await open(page, '/delivery?provider=codex&author=all&gran=week');
    await expect(filtersButton(page)).toHaveText('Filters · 1'); // author only
  });

  test('an address outside the lookback is clamped and rewritten in place', async ({ page }) => {
    await open(page, '/?start=2020-01-01&end=2030-01-01&provider=all&author=mine');
    const { lookbackStart } = await bootstrap(page);
    // The month ends Nov 30, the latest date the API accepts here; the lookback starts a year before today.
    await expect(page).toHaveURL(`${ORIGIN}/?start=${lookbackStart}&end=2026-11-30`);
    await expect(page.getByRole('button', { name: 'Custom range' })).toBeVisible();
    await expect(bar(page)).toContainText('Nov 4, 2025 – Nov 30, 2026');
    // Rewritten in place: no extra history entry was left behind.
    expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(2);
  });

  test('defaults spelled out in the address are dropped', async ({ page }) => {
    await open(
      page,
      '/delivery?provider=all&author=mine&gran=day&start=2026-11-02&end=2026-11-08&q=late',
    );
    await expect(page).toHaveURL(`${ORIGIN}/delivery?q=late`);
    await expect(period(page, 'This week')).toBeChecked();
  });

  test("a screen's own params survive a filter change, and a selected bucket goes when the range moves", async ({
    page,
  }) => {
    await open(page, '/trends?q=late&sel=2026-11-03');
    await (await openFilters(page)).getByRole('radio', { name: 'Codex' }).click();
    await expect(page).toHaveURL(`${ORIGIN}/trends?provider=codex&q=late&sel=2026-11-03`);
    await closeFilters(page);
    await period(page, 'Today').click();
    await expect(page).toHaveURL(
      `${ORIGIN}/trends?start=2026-11-04&end=2026-11-04&provider=codex&q=late`,
    );
  });

  test.describe('custom range', () => {
    test('quick ranges set the period and name it on the button', async ({ page }) => {
      await open(page);
      await page.getByRole('button', { name: 'Custom' }).click();
      const dialog = page.getByRole('dialog', { name: 'Custom range' });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Last 30 days' }).click();
      await expect(page).toHaveURL(`${ORIGIN}/?start=2026-10-06&end=2026-11-04`);
      await expect(dialog).toBeHidden();
      const custom = page.getByRole('button', { name: 'Last 30 days' });
      await expect(custom).toHaveAttribute('aria-pressed', 'true');
      await expect(period(page, 'This week')).not.toBeChecked();
      await expect(bar(page)).toContainText('Oct 6 – Nov 4, 2026');

      await custom.click();
      await page
        .getByRole('dialog', { name: 'Custom range' })
        .getByRole('button', { name: 'Last 12 months' })
        .click();
      const { lookbackStart } = await bootstrap(page);
      await expect(page).toHaveURL(`${ORIGIN}/?start=${lookbackStart}&end=2026-11-04`);
      await expect(
        (await openFilters(page)).getByRole('radio', { name: 'Month', exact: true }),
      ).toBeChecked(); // 366 days groups by month
    });

    test('typed dates apply; wrong ones are explained and nothing is written', async ({ page }) => {
      await open(page);
      const { lookbackStart, today } = await bootstrap(page);
      await page.getByRole('button', { name: 'Custom' }).click();
      const dialog = page.getByRole('dialog', { name: 'Custom range' });
      const from = dialog.getByLabel('From');
      const to = dialog.getByLabel('To');
      // The picker itself is held to the lookback.
      await expect(from).toHaveAttribute('min', lookbackStart);
      await expect(to).toHaveAttribute('max', today);

      await from.fill('2026-10-31');
      await to.fill('2026-10-01');
      await dialog.getByRole('button', { name: 'Apply' }).click();
      await expect(dialog.getByRole('alert')).toHaveText(
        'The start date must be on or before the end date.',
      );
      await expect(from).toHaveAttribute('aria-invalid', 'true');

      await from.fill('2024-01-01');
      await to.fill('2026-10-31');
      await dialog.getByRole('button', { name: 'Apply' }).click();
      await expect(dialog.getByRole('alert')).toHaveText(
        'Choose dates between Nov 4, 2025 and today.',
      );

      await to.fill('2026-11-05'); // tomorrow
      await from.fill('2026-10-01');
      await dialog.getByRole('button', { name: 'Apply' }).click();
      await expect(dialog.getByRole('alert')).toContainText('Choose dates between');
      expect(search(page)).toBe('');

      await to.fill('2026-10-31');
      await expect(dialog.getByRole('alert')).toHaveCount(0); // editing clears the message
      await dialog.getByRole('button', { name: 'Apply' }).click();
      await expect(page).toHaveURL(`${ORIGIN}/?start=2026-10-01&end=2026-10-31`);
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('button', { name: 'Custom range' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(bar(page)).toContainText('Oct 1 – Oct 31, 2026');
    });

    test('Cancel and Escape close it without changing anything, and focus returns to the button', async ({
      page,
    }) => {
      await open(page);
      const trigger = page.getByRole('button', { name: 'Custom' });
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: 'Custom range' });
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
      await trigger.click();
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
      expect(search(page)).toBe('');
    });
  });

  // The repo list is in the Filters popover and opens in place, under its button (the same group the phone's sheet draws), so
  // it is a group of the popover, not a dialog of its own.
  test.describe('repos', () => {
    const repoList = (page: Page) =>
      filtersPanel(page).getByRole('group', { name: 'Repository filter' });

    test('the list shows tracked repos; picking writes them, and the button counts them', async ({
      page,
    }) => {
      await open(page);
      const panel = await openFilters(page);
      await panel.getByRole('button', { name: 'All repos' }).click();
      const list = repoList(page);
      await expect(list).toBeVisible();
      await expect(list.getByRole('checkbox')).toHaveCount(5);
      await list.getByRole('checkbox', { name: 'kelvin/atlas-api' }).click();
      await expect(list.getByRole('checkbox', { name: 'kelvin/atlas-api' })).toBeChecked();
      await expect(page).toHaveURL(`${ORIGIN}/?repos=kelvin/atlas-api`);
      await expect(panel.getByRole('button', { name: 'kelvin/atlas-api' })).toBeVisible();
      await expect(filtersButton(page)).toHaveText('Filters · 1');
      await list.getByRole('checkbox', { name: 'open-tools/shared-schemas' }).click();
      await expect(list.getByRole('checkbox', { name: 'open-tools/shared-schemas' })).toBeChecked();
      await expect(page).toHaveURL(`${ORIGIN}/?repos=kelvin/atlas-api,open-tools/shared-schemas`);
      await expect(panel.getByRole('button', { name: '2 repos' })).toBeVisible();
      await list.getByRole('checkbox', { name: 'kelvin/atlas-api' }).click();
      await expect(list.getByRole('checkbox', { name: 'kelvin/atlas-api' })).not.toBeChecked();
      await expect(panel.getByRole('button', { name: 'open-tools/shared-schemas' })).toBeVisible();
      await list.getByRole('button', { name: 'All repos' }).click();
      await expect(page).toHaveURL(`${ORIGIN}/`);
      await list.getByRole('button', { name: 'Done' }).click();
      await expect(list).toHaveCount(0);
      await expect(panel.getByRole('button', { name: 'All repos' })).toBeFocused();
    });

    test('an inaccessible repo cannot be newly picked, and a repo the list does not know can still be cleared', async ({
      page,
    }) => {
      await open(page, '/?repos=kelvin/gone');
      await (await openFilters(page)).getByRole('button', { name: 'kelvin/gone' }).click();
      const list = repoList(page);
      await expect(
        list.getByRole('checkbox', { name: 'kelvin/archive-private (inaccessible)' }),
      ).toBeDisabled();
      const unknown = list.getByRole('checkbox', { name: 'kelvin/gone (not tracked)' });
      await expect(unknown).toBeChecked();
      await unknown.click();
      await expect(page).toHaveURL(`${ORIGIN}/`);
      await expect(unknown).toHaveCount(0); // nothing selected keeps it listed
    });

    test('a failed list says so and Try again loads it', async ({ page }) => {
      let broken = true;
      await page.route(`${ORIGIN}/api/repos`, async (route) => {
        if (!broken) return route.fallback();
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'internal', message: 'No.', retryable: false } }),
        });
      });
      await open(page);
      await (await openFilters(page)).getByRole('button', { name: 'All repos' }).click();
      const list = repoList(page);
      await expect(list.getByRole('alert')).toHaveText('The repository list could not be loaded.');
      broken = false;
      await list.getByRole('button', { name: 'Try again' }).click();
      await expect(list.getByRole('checkbox', { name: 'kelvin/atlas-web' })).toBeVisible();
    });

    test.describe('with no tracked repos', () => {
      test.use({ worldOptions: { scenario: 'no-repos' } });
      test('the list says there are none', async ({ page }) => {
        await open(page);
        await (await openFilters(page)).getByRole('button', { name: 'All repos' }).click();
        await expect(repoList(page)).toContainText('No tracked repositories yet.');
      });
    });
  });
});

test.describe('on a phone', () => {
  test.beforeEach(async ({ world }) => {
    void world;
  });

  const phoneFilters = (page: Page) => page.getByRole('button', { name: 'Filters', exact: true });
  const sheet = (page: Page) => page.getByRole('dialog', { name: 'Filters' });
  /** Whether keyboard focus is inside the open sheet (a native modal dialog). */
  const focusInSheet = (page: Page) =>
    page.evaluate(() => document.activeElement?.closest('dialog') != null);

  test('shows a one-line summary and a Filters button, not the controls', async ({ page }) => {
    await open(page, '/', 390);
    await expect(bar(page)).toContainText('This week · All repos · All providers · My PRs');
    await expect(phoneFilters(page)).toBeVisible();
    await expect(phoneFilters(page)).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(phoneFilters(page)).toHaveAttribute('aria-expanded', 'false');
    const box = await phoneFilters(page).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(44);
    await expect(period(page, 'Today')).toHaveCount(0); // the controls live in the sheet until it is opened
    await expect(sheet(page)).toBeHidden();
  });

  test('the summary follows the URL', async ({ page }) => {
    await open(
      page,
      '/usage?start=2026-10-01&end=2026-10-20&repos=kelvin/atlas-api,kelvin/atlas-web&provider=claude&author=all',
      390,
    );
    // Usage has no author group, so the summary does not name one.
    await expect(bar(page)).toContainText('Custom range · 2 repos · Claude Code');
    await expect(bar(page)).not.toContainText('PRs');
  });

  test(
    'the sheet traps focus, Escape closes it, and focus returns to Filters',
    { tag: '@a11y' },
    async ({ page }) => {
      await open(page, '/', 390);
      await phoneFilters(page).focus();
      await page.keyboard.press('Enter');
      await expect(sheet(page)).toBeVisible();
      await expect(phoneFilters(page)).toHaveAttribute('aria-expanded', 'true');
      expect(await focusInSheet(page)).toBe(true);

      // Tab and Shift+Tab around the whole sheet several times: focus never leaves it.
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab');
        expect(await focusInSheet(page), `Tab ${i + 1}`).toBe(true);
      }
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Shift+Tab');
        expect(await focusInSheet(page), `Shift+Tab ${i + 1}`).toBe(true);
      }

      await page.keyboard.press('Escape');
      await expect(sheet(page)).toBeHidden();
      await expect(phoneFilters(page)).toBeFocused();
      await expect(phoneFilters(page)).toHaveAttribute('aria-expanded', 'false');
    },
  );

  test(
    'Close and Show results also return focus to Filters',
    { tag: '@a11y' },
    async ({ page }) => {
      await open(page, '/', 390);
      for (const name of ['Close filters', 'Show results']) {
        await phoneFilters(page).click();
        await expect(sheet(page)).toBeVisible();
        await sheet(page).getByRole('button', { name }).click();
        await expect(sheet(page)).toBeHidden();
        await expect(phoneFilters(page), name).toBeFocused();
      }
    },
  );

  test('a change in the sheet writes the URL and the summary follows; Reset clears them', async ({
    page,
  }) => {
    await open(page, '/', 390);
    await phoneFilters(page).click();
    await period(page, 'Today').click();
    await page.getByRole('radio', { name: 'Codex' }).click();
    await page.getByRole('radio', { name: 'All in tracked repos' }).click();
    await expect(page).toHaveURL(
      `${ORIGIN}/?start=2026-11-04&end=2026-11-04&provider=codex&author=all`,
    );
    await sheet(page).getByRole('button', { name: 'Show results' }).click();
    await expect(bar(page)).toContainText('Today · All repos · Codex · All tracked PRs');

    await phoneFilters(page).click();
    await sheet(page).getByRole('button', { name: 'Reset' }).click();
    await expect(page).toHaveURL(`${ORIGIN}/`);
    await expect(period(page, 'This week')).toBeChecked();
    await sheet(page).getByRole('button', { name: 'Show results' }).click();
    await expect(bar(page)).toContainText('This week · All repos · All providers · My PRs');
  });

  test('Custom range and Repos open in place inside the sheet, not as a second overlay', async ({
    page,
  }) => {
    await open(page, '/', 390);
    await phoneFilters(page).click();
    await page.getByRole('button', { name: 'Custom' }).click();
    await expect(sheet(page).getByRole('group', { name: 'Custom range' })).toBeVisible();
    await sheet(page).getByRole('button', { name: 'Last 90 days' }).click();
    await expect(page).toHaveURL(`${ORIGIN}/?start=2026-08-07&end=2026-11-04`);
    await expect(sheet(page).getByRole('group', { name: 'Custom range' })).toHaveCount(0);

    await sheet(page).getByRole('button', { name: 'All repos' }).click();
    const list = sheet(page).getByRole('group', { name: 'Repository filter' });
    await expect(list).toBeVisible();
    await list.getByRole('checkbox', { name: 'kelvin/notes-cli' }).click();
    await expect(list.getByRole('checkbox', { name: 'kelvin/notes-cli' })).toBeChecked();
    await expect(page).toHaveURL(
      `${ORIGIN}/?start=2026-08-07&end=2026-11-04&repos=kelvin/notes-cli`,
    );
    await list.getByRole('button', { name: 'Done' }).click();
    await expect(list).toHaveCount(0);
    expect(await focusInSheet(page)).toBe(true);
  });

  test('widening past 720px closes the sheet and shows the panel; narrowing again does not reopen it', async ({
    page,
  }) => {
    await open(page, '/', 390);
    await phoneFilters(page).click();
    await expect(sheet(page)).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(period(page, 'This week')).toBeVisible();
    await expect(sheet(page)).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(phoneFilters(page)).toBeVisible();
    await expect(sheet(page)).toBeHidden();
  });
});

test.describe('inputs and layout', () => {
  test.beforeEach(async ({ world }) => {
    void world;
  });

  // Segmented controls are pills (DESIGN.md: "pill navigation, segments and chips"; the D7 prototype's .seg and .seg-btn): a pill track
  // and pill segments from 720px up, the medium radius below it (a wrapped track of pills looks wrong, as in the prototype), and the
  // selected segment drawn as a grape tint with a 1px grape ring (--color-selection-surface, --color-action). Astryx draws a track from --radius-element, so the product's own rule sets it.
  for (const [width, pill] of [
    [1280, true],
    [720, true],
    [719, false],
    [390, false],
    [320, false],
  ] as const) {
    test(
      `${width}px: a segmented control is ${pill ? 'a pill' : 'the medium radius'}, and its selected segment has a 1px ring`,
      { tag: '@responsive' },
      async ({ page }) => {
        await open(page, '/delivery', width);
        if (width < 720) await page.getByRole('button', { name: 'Filters', exact: true }).click();
        const selected = period(page, 'This week');
        await expect(selected).toBeChecked();
        // The sheet slides up and a segment fades to its selected look: read the settled state.
        await page.evaluate(() =>
          Promise.all(
            document.getAnimations().map((animation) => animation.finished.catch(() => null)),
          ),
        );
        const look = await selected.evaluate((item) => {
          const track = item.parentElement as HTMLElement;
          // Tokens are resolved by the browser: paint a probe with each and read it back as the colour the segment is compared with.
          const probe = (property: 'color' | 'backgroundColor', token: string) => {
            const el = document.createElement('span');
            el.style[property] = `var(${token})`;
            document.body.append(el);
            const value = getComputedStyle(el)[property];
            el.remove();
            return value;
          };
          return {
            track: getComputedStyle(track).borderTopLeftRadius,
            item: getComputedStyle(item).borderTopLeftRadius,
            shadow: getComputedStyle(item).boxShadow,
            color: getComputedStyle(item).color,
            actionColor: probe('color', '--color-action'),
            background: getComputedStyle(item).backgroundColor,
            tint: probe('backgroundColor', '--color-selection-surface'),
          };
        });
        expect(look.track).toBe(pill ? '999px' : '14px');
        if (pill) expect(parseFloat(look.item)).toBeGreaterThan(100);
        else expect(parseFloat(look.item)).toBeLessThan(14);
        expect(look.shadow).toContain('0px 0px 0px 1px');
        expect(look.shadow).toContain(look.actionColor);
        expect(look.color).toBe(look.actionColor);
        expect(look.background).toBe(look.tint);
      },
    );
  }

  // The prototype draws Custom (with its calendar icon) as the last segment of the period track, not as a button beside it: on a wide
  // screen, where it opens a popover, and in the phone's sheet, where its panel opens in place under the whole track.
  test(
    '1280px: Custom is the last segment of the period track',
    { tag: '@responsive' },
    async ({ page }) => {
      await open(page, '/', 1280);
      const look = await page.getByRole('button', { name: 'Custom' }).evaluate((button) => {
        const group = document.querySelector(
          '[role="radiogroup"][aria-label="Period"]',
        ) as HTMLElement | null;
        const track = group?.parentElement ?? null;
        const inside = track !== null && track.contains(button);
        const shape = button.getBoundingClientRect();
        const lastSegment = group
          ?.querySelector('[role="radio"]:last-of-type')
          ?.getBoundingClientRect();
        return {
          inside,
          trackRadius: track ? getComputedStyle(track).borderTopLeftRadius : '',
          height: Math.round(shape.height),
          right: Math.round((track?.getBoundingClientRect().right ?? 0) - shape.right),
          afterLast: lastSegment ? shape.left >= lastSegment.right - 0.5 : false,
        };
      });
      expect(look.inside).toBe(true);
      expect(look.trackRadius).toBe('999px');
      expect(look.height).toBe(28);
      expect(look.afterLast).toBe(true);
      expect(look.right).toBeLessThanOrEqual(4); // the track's own padding, nothing more
    },
  );

  for (const width of [390, 320]) {
    test(
      `${width}px: in the sheet Custom is a segment of the period track and its panel opens under the track`,
      { tag: '@responsive' },
      async ({ page }) => {
        await open(page, '/', width);
        await page.getByRole('button', { name: 'Filters', exact: true }).click();
        const custom = page.getByRole('button', { name: 'Custom' });
        await expect(custom).toBeVisible();
        // The sheet slides up; measure it where it stays.
        await page.evaluate(() =>
          Promise.all(
            document.getAnimations().map((animation) => animation.finished.catch(() => null)),
          ),
        );
        const read = () =>
          custom.evaluate((button) => {
            const group = document.querySelector(
              '[role="radiogroup"][aria-label="Period"]',
            ) as HTMLElement;
            const track = group.parentElement as HTMLElement;
            const shape = button.getBoundingClientRect();
            const box = track.getBoundingClientRect();
            const style = getComputedStyle(button);
            const above = document.elementFromPoint(shape.left + shape.width / 2, shape.top - 7.5);
            const below = document.elementFromPoint(
              shape.left + shape.width / 2,
              shape.bottom + 7.5,
            );
            return {
              inside: track.contains(button),
              presetsAreInTheTrack: track.contains(group),
              trackRadius: getComputedStyle(track).borderTopLeftRadius,
              trackBackground: getComputedStyle(track).backgroundColor,
              height: Math.round(shape.height),
              buttonRadius: parseFloat(style.borderTopLeftRadius),
              within: shape.right <= box.right + 0.5 && shape.left >= box.left - 0.5,
              // the tap area is 44px tall although the drawn pill is 28px
              hitAbove: button.contains(above),
              hitBelow: button.contains(below),
            };
          });
        const closed = await read();

        expect(closed.inside).toBe(true);
        expect(closed.presetsAreInTheTrack).toBe(true);
        expect(closed.trackRadius).toBe('14px'); // the medium radius below 720px, as in the prototype
        expect(closed.trackBackground).not.toBe('rgba(0, 0, 0, 0)'); // the track's sunken fill holds Custom too
        expect(closed.height).toBe(28);
        expect(closed.buttonRadius).toBeGreaterThan(100); // a pill segment, as the presets beside it
        expect(closed.within).toBe(true);
        expect(closed.hitAbove).toBe(true);
        expect(closed.hitBelow).toBe(true);

        await custom.click();
        const panel = page.getByRole('group', { name: 'Custom range' });
        await expect(panel).toBeVisible();
        // The sheet is anchored to the bottom of the screen, so it grows upward: compare the panel with the track as it is now.
        const place = await panel.evaluate((el) => {
          const box = el.getBoundingClientRect();
          const track = document.querySelector('[role="radiogroup"][aria-label="Period"]')
            ?.parentElement as HTMLElement;
          const sheet = el.closest('dialog, [role="dialog"]') as HTMLElement;
          return {
            below: box.top >= track.getBoundingClientRect().bottom - 0.5,
            insideTrack: track.contains(el),
            inSheet: sheet.contains(el) && box.right <= sheet.getBoundingClientRect().right + 0.5,
          };
        });
        expect(place.below).toBe(true);
        expect(place.insideTrack).toBe(false);
        expect(place.inSheet).toBe(true);
        await expect(custom).toHaveAttribute('aria-expanded', 'true');
      },
    );
  }

  // Date inputs are 16px below 720px so iOS does not zoom the page on focus, and the design's 14px from 720px up.
  for (const [width, size] of [
    [320, '16px'],
    [390, '16px'],
    [719, '16px'],
    [720, '14px'],
    [1280, '14px'],
  ] as const) {
    test(`${width}px: the date inputs are ${size}`, { tag: '@responsive' }, async ({ page }) => {
      await open(page, '/', width);
      if (width < 720) await page.getByRole('button', { name: 'Filters', exact: true }).click();
      await page.getByRole('button', { name: 'Custom' }).click();
      for (const label of ['From', 'To']) {
        const input = page.getByLabel(label, { exact: true });
        await expect(input).toBeVisible();
        expect(
          await input.evaluate((el) => getComputedStyle(el).fontSize),
          `${label} at ${width}`,
        ).toBe(size);
        if (width < 720) expect((await input.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      }
    });
  }

  for (const width of [1280, 1024, 800, 719, 390, 320]) {
    test(
      `${width}px: the bar fits and the page does not scroll sideways`,
      { tag: '@responsive' },
      async ({ page }) => {
        await open(page, '/delivery', width);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
        const box = await bar(page).boundingBox();
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
      },
    );
  }

  test(
    'the bar stays under the app bar (and the pill row from 720px to 1023px) while the page scrolls',
    {
      tag: '@responsive',
    },
    async ({ page }) => {
      for (const [width, top] of [
        [1280, 60],
        [800, 106],
        [390, 60],
      ] as const) {
        await open(page, '/usage', width);
        await page.evaluate(() => {
          const filler = document.createElement('div');
          filler.style.height = '3000px';
          // The bar sticks within the screen's own container, so the filler goes where the page content is.
          document.querySelector('h1')?.closest('header')?.parentElement?.append(filler);
        });
        await page.evaluate(() => window.scrollTo(0, 1500));
        const box = await bar(page).boundingBox();
        expect(box?.y, `${width}px`).toBeCloseTo(top, 0);
      }
    },
  );
});

test.describe('accessibility', () => {
  test.beforeEach(async ({ world }) => {
    void world;
  });

  async function expectNoViolations(page: Page) {
    // A popover or sheet that is still fading in has half-transparent text, which axe reads as low contrast. Scan the
    // settled state, which is what a person looks at.
    await page.evaluate(() =>
      Promise.all(
        document.getAnimations().map((animation) => animation.finished.catch(() => null)),
      ),
    );
    const { violations } = await new AxeBuilder({ page }).analyze();
    const summary = violations.map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).join('\n    ')}`,
    );
    expect(summary, `axe found ${violations.length} violation(s)`).toEqual([]);
  }

  test(
    'axe: the desktop bar, with the Filters popover, the repo list and the custom range open',
    { tag: '@a11y' },
    async ({ page }) => {
      await open(page, '/', 1280);
      await expectNoViolations(page);
      const panel = await openFilters(page);
      await expectNoViolations(page);
      await panel.getByRole('button', { name: 'All repos' }).click();
      await expect(panel.getByRole('group', { name: 'Repository filter' })).toBeVisible();
      await expectNoViolations(page);
      await closeFilters(page);
      await page.getByRole('button', { name: 'Custom' }).click();
      await expect(page.getByRole('dialog', { name: 'Custom range' })).toBeVisible();
      await expectNoViolations(page);
    },
  );

  for (const width of [390, 320]) {
    test(
      `axe: the phone summary and the open sheet at ${width}px`,
      { tag: '@a11y' },
      async ({ page }) => {
        await open(page, '/', width);
        await page.getByRole('button', { name: 'Filters', exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'Filters' })).toBeVisible();
        await page.getByRole('button', { name: 'Custom' }).click();
        await expect(page.getByRole('group', { name: 'Custom range' })).toBeVisible();
        await expectNoViolations(page);
      },
    );
  }
});
