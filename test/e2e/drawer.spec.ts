import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { RecordsResponse } from '../../src/shared/contracts/prs.ts';
import {
  COVERAGE_PHRASES,
  EMPTY_REPOS,
  LINK_LABELS,
  PERIOD_NOT_HAPPENED,
} from '../../src/client/lib/copy';
import { compact } from '../../src/client/lib/format';
import { expect, test } from './fixtures';
import { ORIGIN } from './helpers/virtualOrigin';
import { answerApi, openWorld, type World, type WorldOptions } from './helpers/world';

// The records drawer (M7: A28, goal G7_6) in a real browser, against the real API over the seeded world. Nothing is stubbed unless a
// test says so: the lists on the page are the server's own, and the spec reads the same API to know what to expect.
//
// What is covered:
//   - opening from a chart bucket (pointer and keyboard), from the Table view and from a day of the year grid; the dialog named by
//     the bucket, modal, with focus on its heading; the request it makes (the bucket's own dates, the page's filters, 30 records)
//   - closing by Escape, the Close button and the scrim, and focus going back to the bucket that opened it (after the drawer has
//     slid away, which is when the page behind can take it); the chart's selection clearing
//   - the lists: merged PRs newest first and sessions largest first as the API sends them, each with its own facts; no total of
//     providers anywhere; counts in the tabs
//   - every way a bucket can have nothing to show, said in words from lib/copy: history unavailable, no local records, only part
//     covered, collection stale, no tracked repos, a covered zero, a period that has not happened; never a 0 nobody measured
//   - "Show more": 30, then up to 100, keeping the list and handing focus to it; the note when even that is not everything
//   - "Open in Delivery" and "Open in Usage": the bucket's dates, every other filter kept, the page changing after the drawer
//     has gone and focus landing on the new page's heading; a modified click left to the browser
//   - loading and failure inside the drawer; the product's motion tokens; reduced motion; a page change while it is open; axe
//
// The fixed clock is Wed 2026-11-04 in America/Los_Angeles, so the default period is Mon Nov 2 to Sun Nov 8; Fri Nov 6 has not happened.

// ---- helpers ------------------------------------------------------------------------------------------------------------

const TRENDS_YEAR_BY_MONTH = '/trends?start=2025-11-04&end=2026-11-04&gran=month&author=all';
const TRENDS_30_DAYS = '/trends?start=2026-10-06&end=2026-11-04&gran=day&author=all';

async function openApp(
  page: Page,
  path: string,
  options: { width?: number; world?: WorldOptions } = {},
): Promise<World> {
  await page.setViewportSize({ width: options.width ?? 1280, height: 900 });
  const world = await openWorld(page, options.world);
  await page.goto(`${ORIGIN}${path}`);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expect(chart(page)).toBeVisible();
  return world;
}

const chart = (page: Page): Locator =>
  page.getByRole('group', {
    name: /^Delivery and usage over time|^Merged PRs and recorded local tokens/,
  });
const bucket = (page: Page, index: number): Locator =>
  page.locator(`[data-bucket-index="${index}"]`).first();
const drawerOf = (page: Page, name?: string | RegExp): Locator =>
  page.getByRole('dialog', name === undefined ? {} : { name });
const dialogElement = (page: Page): Locator => page.locator('dialog.astryx-drawer');
const prList = (drawer: Locator): Locator =>
  drawer.getByRole('list', { name: 'Merged pull requests' });
const sessionList = (drawer: Locator): Locator => drawer.getByRole('list', { name: 'Sessions' });
const tab = (drawer: Locator, name: RegExp): Locator => drawer.getByRole('radio', { name });

/** Switches the chart to its Table view and presses the row of that day or month. */
async function pressRow(page: Page, name: RegExp): Promise<void> {
  await page.getByRole('radio', { name: 'Table' }).click();
  await page.getByRole('button', { name }).first().click();
}

/** The server's own answer for the same bucket. */
async function readRecords(world: World, query: string) {
  const answer = await answerApi(world.app, {
    method: 'GET',
    path: `/api/records?${query}`,
    headers: {},
  });
  expect(answer.status).toBe(200);
  return RecordsResponse.parse(JSON.parse(answer.body.toString('utf8')));
}

/** The /api/records requests the page makes, in order. */
function recordRequests(page: Page): URL[] {
  const seen: URL[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/records') seen.push(url);
  });
  return seen;
}

/** Changes one API answer on its way to the page. Register before the page loads: the last route registered wins. */
async function patchRecords(
  page: Page,
  world: World,
  patch: (body: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  await page.route(new RegExp(`${ORIGIN}/api/records(\\?|$)`), async (route) => {
    const url = new URL(route.request().url());
    const answer = await answerApi(world.app, {
      method: 'GET',
      path: url.pathname + url.search,
      headers: route.request().headers(),
    });
    const body = JSON.parse(answer.body.toString('utf8')) as Record<string, unknown>;
    await route.fulfill({
      status: answer.status,
      headers: answer.headers,
      body: JSON.stringify(patch(body)),
    });
  });
}

const FAIL_BODY = JSON.stringify({
  error: { code: 'internal', message: 'Something went wrong.', retryable: false },
});

/** The first request fails and the rest go through to the real app. */
async function failRecordsOnce(page: Page): Promise<{ failed: () => number }> {
  let count = 0;
  await page.route(new RegExp(`${ORIGIN}/api/records(\\?|$)`), async (route) => {
    if (count === 0) {
      count += 1;
      await route.fulfill({ status: 500, contentType: 'application/json', body: FAIL_BODY });
      return;
    }
    await route.fallback();
  });
  return { failed: () => count };
}

/** Waits `ms` before records go through to the real app, so the loading state can be looked at. */
async function slowRecords(page: Page, ms: number): Promise<void> {
  await page.route(new RegExp(`${ORIGIN}/api/records(\\?|$)`), async (route) => {
    await new Promise((done) => setTimeout(done, ms));
    await route.fallback();
  });
}

// ============================================================================================================================
// Opening
// ============================================================================================================================

test.describe('opening', () => {
  test('a click on a chart bucket opens a modal dialog named by the bucket, with focus on its heading', async ({
    page,
  }) => {
    await openApp(page, '/?author=all');
    await expect(dialogElement(page)).toBeHidden();
    await bucket(page, 1).click();

    const drawer = drawerOf(page, 'Tue, Nov 3, 2026');
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute('aria-modal', 'true');
    const heading = drawer.getByRole('heading', { level: 2, name: 'Tue, Nov 3, 2026' });
    await expect(heading).toBeFocused();
    await expect(drawer).toContainText(
      'Records in this period · PRs: All repos · All authors · Sessions: This machine · All repos · All providers',
    );
    // The selection on the chart is the drawer's open bucket.
    await expect(bucket(page, 1)).toHaveAttribute('data-selected', 'true');
  });

  test('the request is the bucket’s own dates under the page’s filters, 30 records at first', async ({
    page,
  }) => {
    const requests = recordRequests(page);
    await openApp(page, '/?author=all&provider=codex&repos=kelvin%2Fatlas-api');
    await bucket(page, 1).click();
    await expect(drawerOf(page, 'Tue, Nov 3, 2026')).toBeVisible();
    await expect.poll(() => requests.length).toBe(1);
    const params = Object.fromEntries(requests[0]!.searchParams);
    expect(params).toEqual({
      start: '2026-11-03',
      end: '2026-11-03',
      author: 'all',
      provider: 'codex',
      repos: 'kelvin/atlas-api',
      limit: '30',
    });
  });

  test('Enter on the keyboard cursor opens it, and Escape closes it with focus back on that bucket', async ({
    page,
  }) => {
    await openApp(page, '/?author=all');
    await chart(page).focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    const drawer = drawerOf(page, 'Mon, Nov 2, 2026');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('heading', { level: 2 })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialogElement(page)).toBeHidden();
    await expect(bucket(page, 0)).toBeFocused();
    await expect(page.locator('[data-selected="true"]')).toHaveCount(0);
  });

  // TECH journey J2, with no pointer at all: choose a period, move along the chart, open a bucket, read the records, come back.
  test('the whole journey by keyboard: a period, the chart, Enter, the drawer, Escape', async ({
    page,
  }) => {
    await openApp(page, '/');
    const startedAt = page.url();

    /** Tab until `target` (or something inside it) has focus; a page that cannot be tabbed through fails here. */
    const tabTo = async (target: Locator, what: string): Promise<void> => {
      for (let presses = 0; presses < 60; presses += 1) {
        const there = await target.evaluate((el) => el.contains(document.activeElement));
        if (there) return;
        await page.keyboard.press('Tab');
      }
      throw new Error(`Tab never reached ${what}`);
    };

    // 1. The period: Tab to the chosen preset, and an arrow key chooses the next one.
    await tabTo(
      page.getByRole('radio', { name: /^This week/, checked: true }),
      'the period control',
    );
    await page.keyboard.press('ArrowRight');
    await expect(page).not.toHaveURL(startedAt);
    await expect(chart(page)).toBeVisible();

    // 2. The chart: Tab to it, Home goes to its first bucket, Enter opens that bucket's records.
    await tabTo(chart(page), 'the chart');
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    const drawer = drawerOf(page);
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('heading', { level: 2 })).toBeFocused();

    // 3. Inside the drawer Tab stays inside it, and Escape closes it with focus back on the bucket.
    await page.keyboard.press('Tab');
    expect(await drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialogElement(page)).toBeHidden();
    await expect(bucket(page, 0)).toBeFocused();
  });

  test('a row of the Table view opens it, and focus goes back to that row', async ({ page }) => {
    await openApp(page, '/?author=all');
    await pressRow(page, /^Wed, Nov 4/);
    const drawer = drawerOf(page, 'Wed, Nov 4, 2026');
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialogElement(page)).toBeHidden();
    await expect(page.getByRole('button', { name: /^Wed, Nov 4/ })).toBeFocused();
  });

  test('a Trends bucket opens it and keeps its selection in the address; a day of the year grid opens that day', async ({
    page,
  }) => {
    const requests = recordRequests(page);
    await openApp(page, TRENDS_YEAR_BY_MONTH);
    await bucket(page, 8).click();
    await expect(drawerOf(page)).toBeVisible();
    const start = new URL(page.url()).searchParams.get('sel');
    expect(start).not.toBeNull();
    await page.keyboard.press('Escape');
    await expect(dialogElement(page)).toBeHidden();
    await expect(bucket(page, 8)).toBeFocused();
    // The selection is Trends' own and stays until it is cleared there.
    expect(new URL(page.url()).searchParams.get('sel')).toBe(start);

    // A day is not one of the chart's buckets: it opens as a bucket of one day, and focus goes to the grid's own scroll region.
    requests.length = 0;
    const grid = page.getByRole('img', { name: /^Merged PRs per day/ });
    await grid.locator('[data-day="2026-11-03"]').click();
    const drawer = drawerOf(page, 'Tue, Nov 3, 2026');
    await expect(drawer).toBeVisible();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0]!.searchParams.get('start')).toBe('2026-11-03');
    expect(requests[0]!.searchParams.get('end')).toBe('2026-11-03');
    expect(new URL(page.url()).searchParams.get('sel')).toBe(start);
    await page.keyboard.press('Escape');
    await expect(dialogElement(page)).toBeHidden();
    await expect(
      page.getByRole('region', { name: 'A year of merges' }).getByRole('region'),
    ).toBeFocused();
  });
});

// ============================================================================================================================
// Closing, and focus while it is open
// ============================================================================================================================

test.describe('closing', () => {
  test('the Close button closes it and focus goes back to the bucket', async ({ page }) => {
    await openApp(page, '/?author=all');
    await bucket(page, 2).click();
    const drawer = drawerOf(page, 'Wed, Nov 4, 2026');
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: 'Close' }).click();
    await expect(dialogElement(page)).toBeHidden();
    await expect(bucket(page, 2)).toBeFocused();
    await expect(page.locator('[data-selected="true"]')).toHaveCount(0);
  });

  test('a press on the scrim closes it', async ({ page }) => {
    await openApp(page, '/?author=all');
    await bucket(page, 1).click();
    await expect(drawerOf(page)).toBeVisible();
    await page.mouse.click(40, 450);
    await expect(dialogElement(page)).toBeHidden();
    await expect(bucket(page, 1)).toBeFocused();
  });

  test('Tab stays inside the drawer, from the heading to Close, the tabs and the links, and round again', async ({
    page,
  }) => {
    await openApp(page, '/?author=all');
    await bucket(page, 1).click();
    const drawer = drawerOf(page, 'Tue, Nov 3, 2026');
    await expect(drawer.getByRole('heading', { level: 2 })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(drawer.getByRole('button', { name: 'Close' })).toBeFocused();
    const inside = () => page.evaluate(() => document.activeElement?.closest('dialog') !== null);
    for (let press = 0; press < 14; press += 1) {
      await page.keyboard.press('Tab');
      expect(await inside(), `Tab ${press + 1}`).toBe(true);
    }
    await page.keyboard.press('Shift+Tab');
    expect(await inside()).toBe(true);
  });

  test('it can be opened again on another bucket and starts fresh', async ({ page }) => {
    await openApp(page, TRENDS_YEAR_BY_MONTH);
    await pressRow(page, /^Jul 2026/);
    let drawer = drawerOf(page, 'Jul 2026');
    await drawer.getByRole('button', { name: 'Show more' }).click();
    await expect(prList(drawer).getByRole('listitem')).toHaveCount(46);
    await drawer.getByRole('button', { name: 'Close' }).click();
    await expect(dialogElement(page)).toBeHidden();

    await page.getByRole('button', { name: /^Aug 2026/ }).click();
    drawer = drawerOf(page, 'Aug 2026');
    await expect(prList(drawer).getByRole('listitem')).toHaveCount(29);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Jul 2026/ }).click();
    drawer = drawerOf(page, 'Jul 2026');
    // 30 again, with its Show more: the limit of the last time is not remembered.
    await expect(prList(drawer).getByRole('listitem')).toHaveCount(30);
    await expect(drawer.getByRole('button', { name: 'Show more' })).toBeVisible();
  });

  test('a page change while it is open lets it slide away and leaves the new page usable', async ({
    page,
  }) => {
    await openApp(page, '/?author=all');
    await bucket(page, 1).click();
    await expect(drawerOf(page, 'Tue, Nov 3, 2026')).toBeVisible();
    // Back/forward or a typed address changes the page under it.
    await page.evaluate(() => {
      history.pushState({}, '', '/trends?author=all');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByRole('heading', { level: 1, name: 'Trends' })).toBeVisible();
    await expect(dialogElement(page)).toBeHidden();
    await expect(page.locator('main')).not.toHaveAttribute('inert');
    // And it opens again, on the new page's own buckets.
    await bucket(page, 0).click();
    await expect(drawerOf(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialogElement(page)).toBeHidden();
    await expect(bucket(page, 0)).toBeFocused();
  });
});

// ============================================================================================================================
// The lists
// ============================================================================================================================

test.describe('the lists', () => {
  test('merged PRs come newest first as the API sends them, each with its title, repo, time and link basis', async ({
    page,
  }) => {
    const world = await openApp(page, '/?author=all');
    const expected = await readRecords(world, 'start=2026-11-03&end=2026-11-03&author=all');
    await bucket(page, 1).click();
    const drawer = drawerOf(page, 'Tue, Nov 3, 2026');

    await expect(tab(drawer, /^Merged PRs 5$/)).toBeChecked();
    await expect(tab(drawer, /^Sessions 18$/)).toBeVisible();
    const rows = prList(drawer).getByRole('listitem');
    await expect(rows).toHaveCount(expected.prs!.length);
    expect(expected.prs!.length).toBeGreaterThan(1);
    for (const [index, pr] of expected.prs!.entries()) {
      const row = rows.nth(index);
      await expect(row).toContainText(pr.title);
      await expect(row).toContainText(`${pr.repo} #${pr.number}`);
      await expect(row).toContainText(LINK_LABELS[pr.linkClass]);
      const link = row.getByRole('link', { name: new RegExp(pr.title.slice(0, 20)) });
      await expect(link).toHaveAttribute('href', pr.url);
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', /noopener/);
    }
    // Someone else's PR says whose it is; yours does not.
    const bot = expected.prs!.find((pr) => !pr.authoredByMe && pr.author);
    expect(bot).toBeDefined();
    await expect(rows.filter({ hasText: bot!.title })).toContainText(`by ${bot!.author}`);
  });

  test('sessions come largest first, each with its own name, provider, model, start and tokens, and nothing is added up', async ({
    page,
  }) => {
    const world = await openApp(page, '/?author=all');
    const expected = await readRecords(world, 'start=2026-11-03&end=2026-11-03&author=all');
    await bucket(page, 1).click();
    const drawer = drawerOf(page, 'Tue, Nov 3, 2026');
    await tab(drawer, /^Sessions/).click();

    const rows = sessionList(drawer).getByRole('listitem');
    await expect(rows).toHaveCount(expected.sessions!.length);
    const sessions = expected.sessions!;
    const tokens = sessions.map((session) => session.tokens);
    expect(tokens).toEqual([...tokens].sort((a, b) => b - a));
    const providers = new Set(sessions.map((session) => session.provider));
    expect(providers.size, 'the day has both providers, so a sum would be visible').toBe(2);

    for (const [index, session] of sessions.entries()) {
      const row = rows.nth(index);
      await expect(row).toContainText(session.nameLead);
      await expect(row).toContainText(session.providerSessionRef);
      await expect(row).toContainText(session.provider === 'codex' ? 'Codex' : 'Claude Code');
      if (session.model) await expect(row).toContainText(session.model);
      await expect(row).toContainText('Started ');
      await expect(row).toContainText(`${compact(session.tokens)} tokens`);
      await expect(row.getByText('Session ID:')).toBeAttached();
    }
    // Counts are counts of records. There is no figure that adds the two providers' tokens, and no word for one.
    await expect(drawer).not.toContainText(/total/i);
  });

  test('the first tab is Merged PRs when there are some, and Sessions when there are none', async ({
    page,
  }) => {
    await openApp(page, TRENDS_30_DAYS);
    await pressRow(page, /^Sun, Nov 1, 2026/);
    // Nothing merged and nothing recorded that day: the machine's side leads (see "a covered zero" below).
    const drawer = drawerOf(page, 'Sun, Nov 1, 2026');
    await expect(tab(drawer, /^Sessions 0$/)).toBeChecked();
    await expect(tab(drawer, /^Merged PRs 0$/)).not.toBeChecked();
  });

  test('the drawer says what the filters are: another author, another repo, one provider', async ({
    page,
  }) => {
    const world = await openApp(page, '/?author=mine&provider=claude&repos=kelvin%2Fatlas-web');
    const expected = await readRecords(
      world,
      'start=2026-11-03&end=2026-11-03&author=mine&provider=claude&repos=kelvin%2Fatlas-web',
    );
    await bucket(page, 1).click();
    const drawer = drawerOf(page, 'Tue, Nov 3, 2026');
    await expect(drawer).toContainText('PRs: kelvin/atlas-web · Authored by you');
    await expect(drawer).toContainText('Sessions: This machine · kelvin/atlas-web · Claude Code');
    await expect(tab(drawer, new RegExp(`^Merged PRs ${expected.prTotal}$`))).toBeVisible();
    await expect(tab(drawer, new RegExp(`^Sessions ${expected.sessionTotal}$`))).toBeVisible();
    await tab(drawer, /^Sessions/).click();
    // One provider in scope: no sentence about the other.
    await expect(drawer).not.toContainText('Codex');
    for (const row of await sessionList(drawer).getByRole('listitem').all()) {
      await expect(row).toContainText('Claude Code');
    }
  });
});

// ============================================================================================================================
// Nothing to show, and why
// ============================================================================================================================

test.describe('where there is nothing to show', () => {
  test('history nobody has is said in words: no 0, no empty list that reads as one', async ({
    page,
  }) => {
    const world = await openApp(page, TRENDS_YEAR_BY_MONTH);
    const expected = await readRecords(world, 'start=2025-12-01&end=2025-12-31&author=all');
    expect(expected.sessionTotal).toBe(0);
    await pressRow(page, /^Dec 2025/);
    const drawer = drawerOf(page, 'Dec 2025');
    // Delivery history covers the lookback, so the PRs are real; the sessions were never recorded.
    await expect(tab(drawer, new RegExp(`^Merged PRs ${expected.prTotal}$`))).toBeVisible();
    await expect(tab(drawer, /^Sessions —$/)).toBeVisible();
    await expect(prList(drawer).getByRole('listitem')).toHaveCount(expected.prs!.length);
    expect(expected.prTotal).toBe(expected.prs!.length);

    await tab(drawer, /^Sessions/).click();
    await expect(
      drawer.getByText(`Codex: ${COVERAGE_PHRASES.historyUnavailableForPeriod}`),
    ).toBeVisible();
    await expect(
      drawer.getByText(`Claude Code: ${COVERAGE_PHRASES.historyUnavailableForPeriod}`),
    ).toBeVisible();
    await expect(sessionList(drawer)).toHaveCount(0);
    await expect(drawer).not.toContainText('true zero');
    await expect(drawer).not.toContainText(/\b0 sessions?\b/);
  });

  test('a period only partly covered lists what there is and says which provider is partial', async ({
    page,
  }) => {
    const world = await openApp(page, TRENDS_YEAR_BY_MONTH);
    const expected = await readRecords(world, 'start=2026-02-01&end=2026-02-28&author=all');
    expect(expected.coverage).toMatchObject({ codex: 'partial', claude: 'unavailable' });
    await pressRow(page, /^Feb 2026/);
    const drawer = drawerOf(page, 'Feb 2026');
    await tab(drawer, /^Sessions/).click();
    await expect(tab(drawer, new RegExp(`^Sessions ${expected.sessionTotal}$`))).toBeChecked();
    await expect(drawer.getByText('Codex: only part of this period is covered.')).toBeVisible();
    await expect(
      drawer.getByText(`Claude Code: ${COVERAGE_PHRASES.historyUnavailableForPeriod}`),
    ).toBeVisible();
    await expect(sessionList(drawer).getByRole('listitem').first()).toBeVisible();
  });

  test('a period that has not happened says so in both lists, and counts nothing', async ({
    page,
  }) => {
    const world = await openApp(page, '/?author=all');
    const expected = await readRecords(world, 'start=2026-11-06&end=2026-11-06&author=all');
    expect(expected.coverage).toEqual({ delivery: 'future', codex: 'future', claude: 'future' });
    await pressRow(page, /^Fri, Nov 6/);
    const drawer = drawerOf(page, 'Fri, Nov 6, 2026');
    await expect(tab(drawer, /^Merged PRs —$/)).toBeVisible();
    await expect(tab(drawer, /^Sessions —$/)).toBeVisible();
    await expect(drawer.getByText(PERIOD_NOT_HAPPENED)).toHaveCount(1);
    await tab(drawer, /^Sessions/).click();
    await expect(drawer.getByText(PERIOD_NOT_HAPPENED)).toHaveCount(1);
    await expect(drawer.getByRole('list')).toHaveCount(0);
    await expect(drawer.getByText(/Codex:|Claude Code:/)).toHaveCount(0);
  });

  test('a covered day with nothing in it is a true zero, in words, for both lists', async ({
    page,
  }) => {
    await openApp(page, TRENDS_30_DAYS);
    await pressRow(page, /^Sun, Nov 1, 2026/);
    const drawer = drawerOf(page, 'Sun, Nov 1, 2026');
    await expect(tab(drawer, /^Merged PRs 0$/)).toBeVisible();
    await expect(tab(drawer, /^Sessions 0$/)).toBeVisible();
    await expect(
      drawer.getByText(
        'No recorded sessions in this period. Covered sources had no activity, so this is a true zero.',
      ),
    ).toBeVisible();
    await tab(drawer, /^Merged PRs/).click();
    await expect(
      drawer.getByText(
        'No merged PRs in this period. GitHub history for tracked repos covers these dates, so this is a true zero.',
      ),
    ).toBeVisible();
  });

  test('the same zero says whose PRs they would have been when the filter is "mine"', async ({
    page,
  }) => {
    await openApp(page, '/trends?start=2026-10-06&end=2026-11-04&gran=day');
    await pressRow(page, /^Sun, Nov 1, 2026/);
    const drawer = drawerOf(page, 'Sun, Nov 1, 2026');
    await tab(drawer, /^Merged PRs/).click();
    await expect(drawer.getByText(/^No merged PRs in this period authored by you\./)).toBeVisible();
  });

  test('with no tracked repo there are no merged PRs to list: the way forward is to add one', async ({
    page,
  }) => {
    await openApp(page, '/?author=all', { world: { scenario: 'no-repos' } });
    await bucket(page, 1).click();
    const drawer = drawerOf(page, 'Tue, Nov 3, 2026');
    // The machine's side leads; the PRs tab is a dash, never a 0.
    await expect(tab(drawer, /^Sessions \d+$/)).toBeChecked();
    await expect(tab(drawer, /^Merged PRs —$/)).toBeVisible();
    await tab(drawer, /^Merged PRs/).click();
    await expect(
      drawer.getByRole('heading', { level: 3, name: EMPTY_REPOS.heading }),
    ).toBeVisible();
    await expect(drawer).toContainText(EMPTY_REPOS.body);

    // The action goes to Sources after the drawer has left, and the new page's heading takes focus.
    await drawer.getByRole('link', { name: EMPTY_REPOS.action }).click();
    await expect(page).toHaveURL(`${ORIGIN}/sources`);
    await expect(drawer).toBeHidden();
    await expect(page.getByRole('heading', { level: 1, name: 'Sources & repos' })).toBeFocused();
  });

  test('with no local records the sessions say so for each provider, and count nothing', async ({
    page,
  }) => {
    await openApp(page, '/?author=all', { world: { scenario: 'account-only' } });
    await bucket(page, 1).click();
    const drawer = drawerOf(page, 'Tue, Nov 3, 2026');
    await expect(tab(drawer, /^Sessions —$/)).toBeVisible();
    await tab(drawer, /^Sessions/).click();
    await expect(
      drawer.getByText(`Codex: ${COVERAGE_PHRASES.noLocalRecordsOnMachine}`),
    ).toBeVisible();
    await expect(
      drawer.getByText(`Claude Code: ${COVERAGE_PHRASES.noLocalRecordsOnMachine}`),
    ).toBeVisible();
    await expect(drawer).not.toContainText('true zero');
  });

  test('after a failed refresh the stale provider is named, as a warning, and its sessions are still listed', async ({
    page,
  }) => {
    const world = await openApp(page, '/?author=all', { world: { scenario: 'refresh-failed' } });
    const expected = await readRecords(world, 'start=2026-11-04&end=2026-11-04&author=all');
    expect(expected.coverage).toMatchObject({ codex: 'stale', claude: 'ok' });
    await pressRow(page, /^Wed, Nov 4/);
    const drawer = drawerOf(page, 'Wed, Nov 4, 2026');
    await tab(drawer, /^Sessions/).click();
    const note = drawer.getByText('Codex: not collected after the failed refresh.');
    await expect(note).toBeVisible();
    // A warning, not plain context: the tinted surface is the warning one.
    await expect(note.locator('xpath=..')).toHaveClass(/bg-warning-surface/);
    await expect(drawer.getByText(/^Claude Code:/)).toHaveCount(0);
    await expect(sessionList(drawer).getByRole('listitem')).toHaveCount(expected.sessions!.length);
  });

  test('a first sync still running says the PR list may be incomplete, and says none are listed yet when it is empty', async ({
    page,
  }) => {
    const world = await openWorld(page);
    await patchRecords(page, world, (body) => ({
      ...body,
      coverage: { ...(body['coverage'] as object), delivery: 'syncing' },
    }));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${ORIGIN}/?author=all`);
    await expect(chart(page)).toBeVisible();
    await bucket(page, 1).click();
    const drawer = drawerOf(page, 'Tue, Nov 3, 2026');
    await expect(
      drawer.getByText('Merged PRs are still being collected, so this list may be incomplete.'),
    ).toBeVisible();
    await expect(prList(drawer).getByRole('listitem').first()).toBeVisible();
    // The count is real so far, not a dash.
    await expect(tab(drawer, /^Merged PRs 5$/)).toBeVisible();

    await drawer.getByRole('button', { name: 'Close' }).click();
    await expect(dialogElement(page)).toBeHidden();
    await page.unroute(new RegExp(`${ORIGIN}/api/records(\\?|$)`));
    await patchRecords(page, world, (body) => ({
      ...body,
      prs: [],
      prTotal: 0,
      coverage: { ...(body['coverage'] as object), delivery: 'syncing' },
    }));
    await bucket(page, 0).click();
    const again = drawerOf(page, 'Mon, Nov 2, 2026');
    await tab(again, /^Merged PRs/).click();
    await expect(
      again.getByText('Merged PRs are still being collected, so none are listed yet.'),
    ).toBeVisible();
  });
});

// ============================================================================================================================
// Show more
// ============================================================================================================================

test.describe('Show more', () => {
  test('30 at first, then the rest up to 100: the list is kept, focus goes to it, and the button goes', async ({
    page,
  }) => {
    const requests = recordRequests(page);
    const world = await openApp(page, TRENDS_YEAR_BY_MONTH);
    const july = await readRecords(world, 'start=2026-07-01&end=2026-07-31&author=all&limit=100');
    expect(july.prTotal).toBe(46);
    await pressRow(page, /^Jul 2026/);
    const drawer = drawerOf(page, 'Jul 2026');

    const rows = prList(drawer).getByRole('listitem');
    await expect(rows).toHaveCount(30);
    await expect(drawer).toContainText('Showing 30 of 46');
    // Mark the rows that are there: they must still be the same rows when the longer list lands.
    await rows.first().evaluate((el) => el.setAttribute('data-kept', 'yes'));
    const more = drawer.getByRole('button', { name: 'Show more' });
    await more.click();

    await expect(rows).toHaveCount(46);
    await expect(rows.first()).toHaveAttribute('data-kept', 'yes');
    await expect(more).toHaveCount(0);
    await expect(drawer).not.toContainText('Showing 30 of 46');
    await expect(prList(drawer)).toBeFocused();
    expect(requests.map((url) => url.searchParams.get('limit'))).toEqual(['30', '100']);
    // Rows are the API's own, in its order.
    for (const [index, pr] of july.prs!.entries()) {
      await expect(rows.nth(index)).toContainText(`${pr.repo} #${pr.number}`);
    }
  });

  test('sessions stop at 100 and say how many there are, and where to see them all', async ({
    page,
  }) => {
    const requests = recordRequests(page);
    await openApp(page, TRENDS_YEAR_BY_MONTH);
    await pressRow(page, /^Jul 2026/);
    const drawer = drawerOf(page, 'Jul 2026');
    await tab(drawer, /^Sessions/).click();
    const rows = sessionList(drawer).getByRole('listitem');
    await expect(rows).toHaveCount(30);
    await expect(drawer).toContainText('Showing 30 of 233');
    await drawer.getByRole('button', { name: 'Show more' }).click();
    await expect(rows).toHaveCount(100);
    await expect(drawer.getByRole('button', { name: 'Show more' })).toHaveCount(0);
    await expect(
      drawer.getByText('Showing the 100 largest of 233 sessions. Open in Usage for all.'),
    ).toBeVisible();
    expect(requests).toHaveLength(2);

    // One request serves both lists: the PRs are already the longer list, with nothing more to ask.
    await tab(drawer, /^Merged PRs/).click();
    await expect(prList(drawer).getByRole('listitem')).toHaveCount(46);
    await expect(drawer.getByRole('button', { name: 'Show more' })).toHaveCount(0);
    expect(requests).toHaveLength(2);
  });

  test('while the longer list loads, the shorter one stays and the button says it is busy', async ({
    page,
  }) => {
    await openApp(page, TRENDS_YEAR_BY_MONTH);
    await pressRow(page, /^Jul 2026/);
    const drawer = drawerOf(page, 'Jul 2026');
    await expect(prList(drawer).getByRole('listitem')).toHaveCount(30);
    await slowRecords(page, 800);
    await drawer.getByRole('button', { name: 'Show more' }).click();
    await expect(prList(drawer).getByRole('listitem')).toHaveCount(30);
    await expect(drawer.locator('[aria-busy="true"]').first()).toBeAttached();
    await expect(prList(drawer).getByRole('listitem')).toHaveCount(46);
  });
});

// ============================================================================================================================
// Open in Delivery, Open in Usage
// ============================================================================================================================

test.describe('the ways on', () => {
  test('Open in Delivery keeps the filters, takes the bucket’s dates, and focus lands on the new page’s heading', async ({
    page,
  }) => {
    await openApp(page, '/?author=all&provider=claude&repos=kelvin%2Fatlas-api');
    await bucket(page, 1).click();
    const drawer = drawerOf(page, 'Tue, Nov 3, 2026');
    const link = drawer.getByRole('link', { name: 'Open in Delivery' });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/delivery\?/);
    const url = new URL(page.url());
    expect(url.pathname).toBe('/delivery');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      start: '2026-11-03',
      end: '2026-11-03',
      author: 'all',
      provider: 'claude',
      repos: 'kelvin/atlas-api',
    });
    await expect(dialogElement(page)).toBeHidden();
    await expect(page.getByRole('heading', { level: 1, name: 'Delivery' })).toBeFocused();
  });

  test('Open in Usage does the same for Usage', async ({ page }) => {
    await openApp(page, '/?author=all');
    await bucket(page, 0).click();
    await drawerOf(page, 'Mon, Nov 2, 2026').getByRole('link', { name: 'Open in Usage' }).click();
    await expect(page).toHaveURL(/\/usage\?/);
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({
      start: '2026-11-02',
      end: '2026-11-02',
      author: 'all',
    });
    await expect(page.getByRole('heading', { level: 1, name: 'Usage' })).toBeFocused();
  });

  // The drill carries the bucket's own dates (G7_6). It moves a date only where the API would refuse it, so a week that runs to Sunday,
  // a month that runs to its last day and a day that has not happened yet (but is still this week) arrive as they were drawn. Each
  // case follows the link to the real page and checks what that page shows, what it asked its API for and that the app answered.
  const DRILLS: {
    name: string;
    /** Where the chart is opened, and how the bucket is chosen. */
    path: string;
    open: (page: Page) => Promise<void>;
    start: string;
    end: string;
    /** The range as the destination's filter bar writes it. */
    label: string;
    /** The week of today is the default period, so its address leaves the dates out and the page still reads them. */
    inAddress: boolean;
  }[] = [
    ...(['/?author=all&gran=week', '/trends?author=all&gran=week'] as const).map((path) => ({
      name: `a week that runs to Sunday (${path.startsWith('/trends') ? 'Trends' : 'Overview'})`,
      path,
      open: async (page: Page) => {
        await bucket(page, 0).click();
      },
      start: '2026-11-02',
      end: '2026-11-08',
      label: 'Nov 2 – Nov 8, 2026',
      inAddress: false,
    })),
    ...(
      [
        '/?start=2026-11-01&end=2026-11-30&gran=month&author=all',
        '/trends?start=2026-11-01&end=2026-11-30&gran=month&author=all',
      ] as const
    ).map((path) => ({
      name: `a month that runs to its last day (${path.startsWith('/trends') ? 'Trends' : 'Overview'})`,
      path,
      open: async (page: Page) => {
        await bucket(page, 0).click();
      },
      start: '2026-11-01',
      end: '2026-11-30',
      label: 'Nov 1 – Nov 30, 2026',
      inAddress: true,
    })),
    ...(['/?author=all', '/trends?author=all'] as const).map((path) => ({
      name: `a day that has not happened yet (${path.startsWith('/trends') ? 'Trends' : 'Overview'})`,
      path,
      open: async (page: Page) => {
        await pressRow(page, /^Fri, Nov 6/);
      },
      start: '2026-11-06',
      end: '2026-11-06',
      label: 'Nov 6, 2026',
      inAddress: true,
    })),
  ];

  for (const drill of DRILLS) {
    for (const target of ['Delivery', 'Usage'] as const) {
      test(`Open in ${target} from ${drill.name} arrives on those dates, and the page and its API take them`, async ({
        page,
      }) => {
        await openApp(page, drill.path);
        const calls: { path: string; params: Record<string, string>; status: number }[] = [];
        page.on('response', (response) => {
          const url = new URL(response.url());
          if (url.pathname === '/api/prs' || url.pathname.startsWith('/api/usage/')) {
            calls.push({
              path: url.pathname,
              params: Object.fromEntries(url.searchParams),
              status: response.status(),
            });
          }
        });

        await drill.open(page);
        await expect(drawerOf(page)).toBeVisible();
        await drawerOf(page)
          .getByRole('link', { name: `Open in ${target}` })
          .click();
        await expect(page).toHaveURL(new RegExp(`/${target.toLowerCase()}(\\?|$)`));

        // the address
        const params = Object.fromEntries(new URL(page.url()).searchParams);
        expect(params['author']).toBe('all');
        if (drill.inAddress) {
          expect(params).toMatchObject({ start: drill.start, end: drill.end });
        } else {
          expect(params['start'], 'the default week is left out of the address').toBeUndefined();
        }

        // the page: the range its filter bar shows, and the way its own heading takes focus
        await expect(page.getByRole('heading', { level: 1, name: target })).toBeFocused();
        await expect(
          page.locator('section[aria-label="Filters"]').getByText(drill.label, { exact: true }),
        ).toBeVisible();

        // what the page asked its API for, and that the app answered it
        const dataPath = target === 'Delivery' ? '/api/prs' : '/api/usage/categories';
        await expect
          .poll(() => calls.filter((c) => c.path === dataPath).length, { message: dataPath })
          .toBeGreaterThan(0);
        for (const call of calls) {
          expect(call.params, call.path).toMatchObject({ start: drill.start, end: drill.end });
          expect(call.status, call.path).toBe(200);
        }
      });
    }
  }

  test('a day that has not happened says so in words on Delivery, and counts nothing', async ({
    page,
  }) => {
    await openApp(page, '/?author=all');
    await pressRow(page, /^Fri, Nov 6/);
    await drawerOf(page, 'Fri, Nov 6, 2026')
      .getByRole('link', { name: 'Open in Delivery' })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Delivery' })).toBeFocused();
    await expect(page.getByText(PERIOD_NOT_HAPPENED)).toBeVisible();
    await expect(page.getByText(/No merged PRs in this period/)).toHaveCount(0);
  });

  test('a day that has not happened says so in words on Usage, in each provider’s ledger', async ({
    page,
  }) => {
    await openApp(page, '/?author=all');
    await pressRow(page, /^Fri, Nov 6/);
    await drawerOf(page, 'Fri, Nov 6, 2026').getByRole('link', { name: 'Open in Usage' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Usage' })).toBeFocused();
    await expect(page.getByText(PERIOD_NOT_HAPPENED)).toHaveCount(2);
  });

  test('a click with a modifier key is left to the browser (a new tab), and the drawer stays', async ({
    page,
  }) => {
    await openApp(page, '/?author=all');
    await bucket(page, 1).click();
    const drawer = drawerOf(page, 'Tue, Nov 3, 2026');
    const link = drawer.getByRole('link', { name: 'Open in Delivery' });
    await expect(link).toHaveAttribute('href', /^\/delivery\?/);
    // Read what the page's handlers did with the click, then cancel it so no tab is opened.
    const prevented = await link.evaluate(
      (el) =>
        new Promise<boolean>((resolve) => {
          addEventListener(
            'click',
            (event) => {
              resolve(event.defaultPrevented);
              event.preventDefault();
            },
            { once: true },
          );
          el.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true, button: 0 }),
          );
        }),
    );
    expect(prevented).toBe(false);
    await expect(drawer).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/');
  });
});

// ============================================================================================================================
// Loading and failure
// ============================================================================================================================

test.describe('loading and failure', () => {
  test('while the records load, the heading and the ways on are there and the list is a placeholder', async ({
    page,
  }) => {
    await openApp(page, '/?author=all');
    await slowRecords(page, 1200);
    await bucket(page, 1).click();
    const drawer = drawerOf(page, 'Tue, Nov 3, 2026');
    await expect(drawer.getByRole('heading', { level: 2 })).toBeFocused();
    await expect(drawer.getByText('Loading records…')).toBeAttached();
    await expect(drawer.getByRole('radio')).toHaveCount(0);
    await expect(drawer.getByRole('link', { name: 'Open in Delivery' })).toBeVisible();
    await expect(prList(drawer)).toBeVisible();
    await expect(drawer.getByRole('radio')).toHaveCount(2);
  });

  test('Escape works while it is loading', async ({ page }) => {
    await openApp(page, '/?author=all');
    await slowRecords(page, 1500);
    await bucket(page, 1).click();
    await expect(drawerOf(page, 'Tue, Nov 3, 2026')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialogElement(page)).toBeHidden();
    await expect(bucket(page, 1)).toBeFocused();
  });

  test('a failed request says so inside the drawer, and Try again fetches the records', async ({
    page,
  }) => {
    await openApp(page, '/?author=all');
    const failing = await failRecordsOnce(page);
    await bucket(page, 1).click();
    const drawer = drawerOf(page, 'Tue, Nov 3, 2026');
    await expect(drawer.getByRole('alert')).toContainText('Couldn’t load these records.');
    expect(failing.failed()).toBe(1);
    await expect(drawer.getByRole('radio')).toHaveCount(0);
    await drawer.getByRole('button', { name: 'Try again' }).click();
    await expect(prList(drawer).getByRole('listitem').first()).toBeVisible();
    await expect(drawer.getByRole('alert')).toHaveCount(0);
  });
});

// ============================================================================================================================
// Motion
// ============================================================================================================================

test.describe('motion', () => {
  test('the panel is inset 8px with large corners, and slides and fades the scrim on the product’s tokens', async ({
    page,
  }) => {
    await openApp(page, '/?author=all');
    await bucket(page, 1).click();
    await expect(drawerOf(page)).toBeVisible();
    // Measure once the slide has finished: no transition is still running on the panel.
    await expect
      .poll(() => dialogElement(page).evaluate((el) => el.getAnimations().length))
      .toBe(0);
    const style = await dialogElement(page).evaluate((el) => {
      const panel = getComputedStyle(el);
      const scrim = getComputedStyle(el, '::backdrop');
      const rect = el.getBoundingClientRect();
      return {
        panelDuration: panel.transitionDuration,
        panelEase: panel.transitionTimingFunction,
        scrimDuration: scrim.transitionDuration,
        scrimColour: scrim.backgroundColor,
        radius: panel.borderRadius,
        border: panel.borderTopWidth,
        gaps: {
          top: rect.top,
          bottom: innerHeight - rect.bottom,
          right: innerWidth - rect.right,
        },
        width: rect.width,
      };
    });
    // design-system/DESIGN.md › Motion: --dur-drawer 320ms on --ease-drawer; the scrim is 36% warm ink.
    expect(style.panelDuration).toBe('0.32s');
    expect(style.panelEase).toBe('cubic-bezier(0.32, 0.72, 0, 1)');
    expect(style.scrimDuration).toBe('0.32s');
    expect(style.scrimColour).toBe('rgba(31, 27, 22, 0.36)');
    // "A right-hand panel inset 8px from the viewport, with lg corners."
    expect(style.gaps).toEqual({ top: 8, bottom: 8, right: 8 });
    expect(style.radius).toBe('20px');
    expect(style.border).toBe('0px');
    expect(style.width).toBe(520);
  });

  test('it slides in from the edge and settles, once', async ({ page }) => {
    await openApp(page, '/?author=all');
    // Press the bucket and watch the panel's position frame by frame, in the page, so no frame is missed.
    const lefts = await page.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const samples: number[] = [];
          const panel = document.querySelector('dialog.astryx-drawer');
          document
            .querySelector('[data-bucket-index="1"]')!
            .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          const started = performance.now();
          const tick = () => {
            samples.push(Math.round(panel!.getBoundingClientRect().left));
            if (performance.now() - started < 700) requestAnimationFrame(tick);
            else resolve(samples);
          };
          requestAnimationFrame(tick);
        }),
    );
    const rest = 1280 - 8 - 520;
    expect(lefts.at(-1)).toBe(rest);
    expect(Math.max(...lefts), 'it started off to the right').toBeGreaterThan(rest + 100);
    // Monotonic: one slide, no replay.
    for (let index = 1; index < lefts.length; index += 1) {
      expect(lefts[index]!, `frame ${index}`).toBeLessThanOrEqual(lefts[index - 1]!);
    }
    // Changing tab does not move it.
    await tab(drawerOf(page), /^Sessions/).click();
    expect(
      await dialogElement(page).evaluate((el) => Math.round(el.getBoundingClientRect().left)),
    ).toBe(rest);
  });

  test('with reduced motion it still opens, closes and hands focus back, without a slide', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(page, '/?author=all');
    await bucket(page, 1).click();
    await expect(drawerOf(page, 'Tue, Nov 3, 2026')).toBeVisible();
    const duration = await dialogElement(page).evaluate((el) =>
      parseFloat(getComputedStyle(el).transitionDuration),
    );
    expect(duration).toBeLessThan(0.001);
    await page.keyboard.press('Escape');
    await expect(dialogElement(page)).toBeHidden();
    await expect(bucket(page, 1)).toBeFocused();
  });
});

// ============================================================================================================================
// Accessibility
// ============================================================================================================================

test.describe('accessibility', () => {
  for (const width of [1280, 390, 320]) {
    test(
      `${width}px: axe finds no violation in the open drawer, on either tab`,
      { tag: '@a11y' },
      async ({ page }) => {
        await openApp(page, '/?author=all', { width });
        if (width < 720) await page.getByRole('radio', { name: 'Table' }).click();
        await (
          width < 720 ? page.getByRole('button', { name: /^Tue, Nov 3/ }) : bucket(page, 1)
        ).click();
        const drawer = drawerOf(page, 'Tue, Nov 3, 2026');
        await expect(prList(drawer)).toBeVisible();
        await expect(drawer).toBeInViewport({ ratio: 1 });
        for (const name of [/^Merged PRs/, /^Sessions/]) {
          await tab(drawer, name).click();
          const { violations } = await new AxeBuilder({ page }).include('dialog[open]').analyze();
          const summary = violations.map(
            (v) =>
              `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).join('\n    ')}`,
          );
          expect(summary, `axe found ${violations.length} violation(s) on ${String(name)}`).toEqual(
            [],
          );
        }
      },
    );
  }
});
