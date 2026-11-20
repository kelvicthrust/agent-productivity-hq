import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { YearResponse } from '../../src/shared/contracts/series.ts';
import { ModelsResponse } from '../../src/shared/contracts/usage.ts';
import { compact, int } from '../../src/client/lib/format';
import { expect, test } from './fixtures';
import { closeFilters, openFilters } from './helpers/filtersPopover';
import { failures, measureContainment } from './helpers/containment';
import { ORIGIN } from './helpers/virtualOrigin';
import { answerApi, openWorld, type World, type WorldOptions } from './helpers/world';

// Trends (M7: A27) in a real browser, against the real API over the seeded world: A year of merges, the larger aligned chart with
// its selection, and the recorded tokens by model. Nothing is stubbed unless a test says so; the spec reads the same API to know
// what the page should say.
//
// What is covered, from the assignment's goals (G7_5 and the client half of G7_7):
//   - YearGrid on Trends, fed by /api/year (repos and author only), hidden without a tracked repo, with its own loading and error
//   - the chart's selection as URL state (`sel`): marked, restored by a link, undone by Back, dropped when the range moves, and
//     cleared with focus handed back to its bucket; records are never listed inline (they open in the records drawer)
//   - tokens by model, within each provider and never across, with every way a provider has no figure said in words
//   - chart loading and error: a placeholder, and a panel with Try again
//   - containment at 1280, 390 and 320px, and axe
//
// What is checked here is what Trends hands the records drawer: the selection it marks and writes to the URL. The drawer opens on
// every selection and is modal, so these specs close it with Escape before using the page again. What it shows, and focus coming
// back from it, are checked where the drawer is (test/e2e/drawer.spec.ts).
//
// The fixed clock is Wed 2026-11-04 in America/Los_Angeles, so the default period is Mon Nov 2 to Sun Nov 8.

// ---- helpers ------------------------------------------------------------------------------------------------------------

async function openTrends(
  page: Page,
  width: number,
  options: { search?: string; world?: WorldOptions; height?: number } = {},
): Promise<{ world: World }> {
  await page.setViewportSize({ width, height: options.height ?? 900 });
  const world = await openWorld(page, options.world);
  await page.goto(`${ORIGIN}/trends${options.search ?? ''}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Trends' })).toBeVisible();
  await expect(modelsCard(page)).toBeVisible();
  return { world };
}

async function readApi(world: World, path: string): Promise<unknown> {
  const answer = await answerApi(world.app, { method: 'GET', path, headers: {} });
  return JSON.parse(answer.body.toString('utf8')) as unknown;
}
const readYear = async (world: World, search = '') =>
  YearResponse.parse(await readApi(world, `/api/year${search}`));
const readModels = async (world: World, search = '') =>
  ModelsResponse.parse(await readApi(world, `/api/models${search}`));

const yearCard = (page: Page): Locator =>
  page.getByRole('region', { name: 'A year of merges', exact: true });
const modelsCard = (page: Page): Locator =>
  page.getByRole('region', { name: 'Recorded tokens by model', exact: true });
const yearGrid = (page: Page): Locator => page.getByRole('img', { name: /^Merged PRs per day/ });
const chart = (page: Page): Locator =>
  page.getByRole('group', { name: /^Merged PRs and recorded local tokens/ });
const bucket = (page: Page, index: number): Locator =>
  page.locator(`svg [data-bucket-index="${index}"]`);
const selection = (page: Page): Locator => page.getByText('Selected period:');
const radio = (page: Page, name: string): Locator => page.getByRole('radio', { name, exact: true });

const FAIL_BODY = JSON.stringify({
  error: { code: 'internal', message: 'Something went wrong.', retryable: false },
});

/** A request that fails the first time and then goes through to the real app. */
async function failOnce(page: Page, path: string): Promise<{ failed: () => number }> {
  let count = 0;
  await page.route(new RegExp(`${ORIGIN}${path}(\\?|$)`), async (route) => {
    if (count === 0) {
      count += 1;
      await route.fulfill({ status: 500, contentType: 'application/json', body: FAIL_BODY });
      return;
    }
    await route.fallback();
  });
  return { failed: () => count };
}

/** A request that waits before it goes through to the real app, so a loading state can be looked at. */
async function slow(page: Page, path: string, ms: number): Promise<void> {
  await page.route(new RegExp(`${ORIGIN}${path}(\\?|$)`), async (route) => {
    await new Promise((done) => setTimeout(done, ms));
    await route.fallback();
  });
}

const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

// ============================================================================================================================
// The page
// ============================================================================================================================

test.describe('the page', () => {
  test('names the period, the range and the grouping under its heading', async ({ page }) => {
    await openTrends(page, 1280);
    await expect(page.getByText('This week · Nov 2 – Nov 8, 2026 · by day')).toBeVisible();
    await expect(page).toHaveTitle('Trends · Agent Productivity HQ');
  });

  test('says by week for a longer range, and Custom range for a range that matches no preset', async ({
    page,
  }) => {
    await openTrends(page, 1280, { search: '?start=2026-07-01&end=2026-11-04' });
    await expect(page.getByText('Custom range · Jul 1 – Nov 4, 2026 · by week')).toBeVisible();
  });

  test('the records are not listed on the page: they open in the drawer', async ({ page }) => {
    await openTrends(page, 1280, { search: '?sel=2026-11-03' });
    await expect(selection(page)).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Records in|^Period records/ })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Merged PRs', level: 3 })).toHaveCount(0);
  });
});

// ============================================================================================================================
// A year of merges
// ============================================================================================================================

test.describe('a year of merges', () => {
  test('draws every day of the lookback with the API’s own counts and facts', async ({ page }) => {
    const { world } = await openTrends(page, 1280);
    const year = await readYear(world);
    const card = yearCard(page);
    await expect(card).toContainText(
      'All repos · Authored by you · last 12 months · selected period outlined',
    );

    // The picture is named by its own summary, and every day from the start to today has a cell.
    const grid = yearGrid(page);
    await expect(grid).toHaveAccessibleName(
      new RegExp(
        `^Merged PRs per day for the last 12 months: ${int(year.total)} in total across ${int(year.daysWithMerge)} days\\.`,
      ),
    );
    await expect(grid.locator('[data-day]')).toHaveCount(daysBetween(year.start, year.today) + 1);

    // The facts under it, from the same answer.
    await expect(card).toContainText(`${int(year.total)} merged PRs`);
    await expect(card).toContainText(`${int(year.daysWithMerge)} days with a merge`);
    const busiest = year.busiestDay!;
    await expect(card).toContainText(`(${busiest.count})`);
    await expect(card.getByText('Fewer')).toBeVisible();

    // A day with merges says how many in its title; the period's days (Mon to Wed, the rest is the future) are outlined.
    const day = Object.entries(year.counts)[0]!;
    await expect(grid.locator(`[data-day="${day[0]}"] title`)).toContainText(
      `${day[1]} merged ${day[1] === 1 ? 'PR' : 'PRs'}`,
    );
    await expect(grid.locator('rect.stroke-ink')).toHaveCount(3);
  });

  test('the repo and author filters change it; the period does not ask for it again', async ({
    page,
  }) => {
    const years: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/year') years.push(request.url());
    });
    const { world } = await openTrends(page, 1280);
    await expect(yearGrid(page)).toBeVisible();
    expect(years).toHaveLength(1);

    // A different period: the grid is the last 12 months whatever the period, so nothing is read again, and only the outline moves.
    await radio(page, 'This month').click();
    await expect(page.getByText(/^This month · Nov 1 – Nov 30, 2026/)).toBeVisible();
    await expect(yearGrid(page).locator('rect.stroke-ink')).toHaveCount(4);
    expect(years).toHaveLength(1);

    // Author is one of the two filters it takes: all authors is a different year.
    await openFilters(page);
    await radio(page, 'All in tracked repos').click();
    await closeFilters(page);
    await expect(yearCard(page)).toContainText('All repos · All authors');
    await expect.poll(() => years.length).toBe(2);
    const everyone = await readYear(world, '?author=all');
    const mine = await readYear(world);
    expect(everyone.total).toBeGreaterThanOrEqual(mine.total);
    await expect(yearCard(page)).toContainText(`${int(everyone.total)} merged PRs`);
  });

  test('is not drawn at all when no repository is tracked, and the rest of the page still is', async ({
    page,
  }) => {
    await openTrends(page, 1280, { world: { scenario: 'no-repos' } });
    await expect(page.getByRole('heading', { name: 'A year of merges' })).toHaveCount(0);
    await expect(yearGrid(page)).toHaveCount(0);
    await expect(chart(page)).toBeVisible();
    await expect(modelsCard(page)).toBeVisible();
  });

  test('keeps its title and shows quiet bars while it loads, then draws', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorld(page);
    await slow(page, '/api/year', 1500);
    await page.goto(`${ORIGIN}/trends`);
    await expect(page.getByRole('heading', { level: 2, name: 'A year of merges' })).toBeVisible();
    await expect(page.getByText('Loading the year of merges')).toBeAttached();
    await expect(yearGrid(page)).toHaveCount(0);
    await expect(yearGrid(page)).toBeVisible();
    await expect(page.getByText('Loading the year of merges')).toHaveCount(0);
  });

  test('says it could not be read and Try again draws it, without taking the other cards down', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorld(page);
    const failing = await failOnce(page, '/api/year');
    await page.goto(`${ORIGIN}/trends`);
    const alert = page.getByRole('alert').filter({ hasText: 'Couldn’t load this' });
    await expect(alert).toBeVisible();
    expect(failing.failed()).toBe(1);
    await expect(chart(page)).toBeVisible();
    await expect(modelsCard(page)).toBeVisible();
    await alert.getByRole('button', { name: 'Try again' }).click();
    await expect(yearGrid(page)).toBeVisible();
    await expect(alert).toHaveCount(0);
  });

  test(
    'fills the width of its card on a wide screen, with no sideways scroll',
    { tag: '@responsive' },
    async ({ page }) => {
      await openTrends(page, 1440);
      const region = page.getByRole('region', { name: 'A year of merges, scrolls sideways' });
      await region.scrollIntoViewIfNeeded();
      const widths = await region.evaluate((el) => ({
        region: el.clientWidth,
        grid: Number(el.querySelector('svg')?.getAttribute('width')),
        scrollable: el.scrollWidth - el.clientWidth,
      }));
      // The step is a whole number of pixels, so the grid is within one column's step of the region's width, not narrower than that.
      expect(widths.grid).toBeLessThanOrEqual(widths.region);
      expect(widths.region - widths.grid).toBeLessThan(53);
      expect(widths.scrollable).toBe(0);
    },
  );

  test(
    'scrolls sideways inside its own named, focusable region and opens on the newest weeks',
    { tag: '@responsive' },
    async ({ page }) => {
      await openTrends(page, 390);
      const region = page.getByRole('region', { name: 'A year of merges, scrolls sideways' });
      await expect(region).toHaveAttribute('tabindex', '0');
      const scroll = await region.evaluate((el) => ({
        left: el.scrollLeft,
        max: el.scrollWidth - el.clientWidth,
      }));
      expect(scroll.max).toBeGreaterThan(0);
      expect(scroll.left).toBeGreaterThanOrEqual(scroll.max - 1);
      await expect(
        page.getByText('Scroll sideways to see the full year; it opens on the newest weeks.'),
      ).toBeVisible();
    },
  );

  // The edge cue (DESIGN.md's capture checklist: "the year grid at 390px: edge shadow"): a faint shadow at each side that has more to
  // scroll, drawn with background layers on the scroller (ported from the prototype's .year-wrap). It cannot be told from a still
  // picture, so this reads the pixels: with the cells hidden, the strip at an edge is darker than the plain card exactly when the
  // grid can still scroll that way, and the page opens on the newest weeks, so it is the left one that shows.
  test(
    'draws a shadow at an edge only where the grid has more to scroll',
    { tag: '@responsive' },
    async ({ page }) => {
      await openTrends(page, 390);
      const region = page.getByRole('region', { name: 'A year of merges, scrolls sideways' });
      await region.scrollIntoViewIfNeeded();
      await region.evaluate((el) => {
        for (const child of Array.from(el.children))
          (child as HTMLElement).style.visibility = 'hidden';
      });
      const brightness = async (side: 'left' | 'right'): Promise<number> => {
        const box = await region.boundingBox();
        if (!box) throw new Error('the year grid has no box');
        const x = side === 'left' ? box.x + 1 : box.x + box.width - 4;
        const png = await page.screenshot({
          clip: { x, y: box.y + box.height / 2 - 2, width: 3, height: 4 },
        });
        const reader = await page.context().newPage(); // a blank page: the app's own page may not allow a data: image
        try {
          return await reader.evaluate(async (base64) => {
            const image = new Image();
            image.src = `data:image/png;base64,${base64}`;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('no canvas');
            context.drawImage(image, 0, 0);
            const data = context.getImageData(0, 0, image.width, image.height).data;
            let sum = 0;
            for (let index = 0; index < data.length; index += 4) {
              sum += ((data[index] ?? 0) + (data[index + 1] ?? 0) + (data[index + 2] ?? 0)) / 3;
            }
            return sum / (data.length / 4);
          }, png.toString('base64'));
        } finally {
          await reader.close();
        }
      };
      const scrollTo = (where: 'start' | 'end') =>
        region.evaluate((el, target) => {
          el.scrollLeft = target === 'start' ? 0 : el.scrollWidth;
        }, where);

      await scrollTo('end');
      const atEnd = { left: await brightness('left'), right: await brightness('right') };
      await scrollTo('start');
      const atStart = { left: await brightness('left'), right: await brightness('right') };
      // Opened on the newest weeks (the end): the left edge has more to scroll and is shadowed, the right has none and is plain.
      expect(atEnd.left).toBeLessThan(atEnd.right - 15);
      // At the start it is the other way round.
      expect(atStart.right).toBeLessThan(atStart.left - 15);
      // A plain edge is the card's own colour, and a shadow is the same at either edge.
      expect(Math.abs(atStart.left - atEnd.right)).toBeLessThan(3);
      expect(Math.abs(atEnd.left - atStart.right)).toBeLessThan(3);
    },
  );
});

// ============================================================================================================================
// The chart and its selection
// ============================================================================================================================

test.describe('the chart', () => {
  test('a click on a bucket selects it: marked, written to the URL, and named under the chart', async ({
    page,
  }) => {
    await openTrends(page, 1280);
    await expect(selection(page)).toHaveCount(0);
    await bucket(page, 1).click();
    await expect(page).toHaveURL(`${ORIGIN}/trends?sel=2026-11-03`);
    await expect(bucket(page, 1)).toHaveAttribute('data-selected', 'true');
    await expect(page.locator('svg [data-selected="true"]')).toHaveCount(1);
    await expect(page.getByText('Selected period:').locator('..')).toContainText(
      'Tue, Nov 3, 2026',
    );
    await expect(page.getByRole('button', { name: 'Show records' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clear selection' })).toBeVisible();
  });

  test('Enter on the keyboard cursor selects too, and so does a row of the Table view', async ({
    page,
  }) => {
    await openTrends(page, 1280);
    await chart(page).focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${ORIGIN}/trends?sel=2026-11-03`);
    await expect(bucket(page, 1)).toHaveAttribute('data-selected', 'true');

    // The drawer is modal, so each selection is closed with Escape (the selection stays in the address) before the page is used again.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await radio(page, 'Table').click();
    const row = page.getByRole('button', { name: 'Wed, Nov 4, 2026' });
    await row.click();
    await expect(page).toHaveURL(`${ORIGIN}/trends?sel=2026-11-04`);
    await expect(row).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('a link restores the selection and waits: it marks the bucket and opens nothing on its own', async ({
    page,
  }) => {
    await openTrends(page, 1280, { search: '?sel=2026-11-03' });
    await expect(bucket(page, 1)).toHaveAttribute('data-selected', 'true');
    await expect(selection(page).locator('..')).toContainText('Tue, Nov 3, 2026');
    await page.reload();
    await expect(bucket(page, 1)).toHaveAttribute('data-selected', 'true');
  });

  test('a selection that names no bucket of the series selects nothing', async ({ page }) => {
    await openTrends(page, 1280, { search: '?sel=2020-01-01' });
    await expect(chart(page)).toBeVisible();
    await expect(page.locator('svg [data-selected="true"]')).toHaveCount(0);
    await expect(selection(page)).toHaveCount(0);
  });

  test('Back undoes a selection, like a filter', async ({ page }) => {
    await openTrends(page, 1280);
    await bucket(page, 2).click();
    await expect(page).toHaveURL(`${ORIGIN}/trends?sel=2026-11-04`);
    await page.goBack();
    await expect(page).toHaveURL(`${ORIGIN}/trends`);
    await expect(page.locator('svg [data-selected="true"]')).toHaveCount(0);
    await expect(selection(page)).toHaveCount(0);
  });

  test('Clear selection removes it and puts focus back on the bucket that was selected', async ({
    page,
  }) => {
    await openTrends(page, 1280, { search: '?sel=2026-11-03' });
    await page.getByRole('button', { name: 'Clear selection' }).click();
    await expect(page).toHaveURL(`${ORIGIN}/trends`);
    await expect(selection(page)).toHaveCount(0);
    await expect(bucket(page, 1)).toBeFocused();
  });

  test('a change of period drops the selection, which pointed into the range; a change of provider keeps it', async ({
    page,
  }) => {
    await openTrends(page, 1280, { search: '?sel=2026-11-03' });
    await openFilters(page);
    await radio(page, 'Codex').click();
    await closeFilters(page);
    await expect(page).toHaveURL(`${ORIGIN}/trends?provider=codex&sel=2026-11-03`);
    await expect(bucket(page, 1)).toHaveAttribute('data-selected', 'true');

    await radio(page, 'This month').click();
    await expect(page).toHaveURL(`${ORIGIN}/trends?start=2026-11-01&end=2026-11-30&provider=codex`);
    await expect(selection(page)).toHaveCount(0);
    await expect(page.locator('svg [data-selected="true"]')).toHaveCount(0);
  });

  test('names both scopes under its heading', async ({ page }) => {
    await openTrends(page, 1280, { search: '?provider=claude&author=all' });
    await expect(
      page.getByRole('heading', { level: 2, name: 'Merged PRs and recorded local tokens' }),
    ).toBeVisible();
    await expect(
      page
        .getByText('PRs: All repos · All authors · Tokens: This machine · All repos · Claude Code')
        .first(),
    ).toBeVisible();
  });

  test('has its own placeholder while its series loads', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorld(page);
    await slow(page, '/api/series', 1500);
    await page.goto(`${ORIGIN}/trends`);
    await expect(page.getByText('Loading chart')).toBeAttached();
    await expect(chart(page)).toHaveCount(0);
    // The other cards are not held up by it.
    await expect(modelsCard(page)).toBeVisible();
    await expect(chart(page)).toBeVisible();
    await expect(page.getByText('Loading chart')).toHaveCount(0);
  });

  test('says it could not be built, offers Try again, and the Table view still opens', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorld(page);
    const failing = await failOnce(page, '/api/series');
    await page.goto(`${ORIGIN}/trends`);
    await expect(page.getByText('Couldn’t build this chart')).toBeVisible();
    expect(failing.failed()).toBe(1);
    await expect(yearGrid(page)).toBeVisible();
    await radio(page, 'Table').click();
    await expect(page.getByRole('table', { name: /as a table$/ })).toBeVisible();
    await radio(page, 'Chart').click();
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(chart(page)).toBeVisible();
    await expect(page.getByText('Couldn’t build this chart')).toHaveCount(0);
  });
});

// ============================================================================================================================
// Tokens by model
// ============================================================================================================================

test.describe('tokens by model', () => {
  test('each provider lists its own models with its own shares, and the two are never compared', async ({
    page,
  }) => {
    const { world } = await openTrends(page, 1280);
    const models = await readModels(world);
    const card = modelsCard(page);
    await expect(card).toContainText(
      'This machine · All repos · All providers · share within each provider',
    );
    await expect(card.getByRole('heading', { level: 3 })).toHaveText(['Codex', 'Claude Code']);

    for (const [provider, name] of [
      ['codex', 'Codex'],
      ['claude', 'Claude Code'],
    ] as const) {
      const section = card
        .locator('div')
        .filter({ has: page.getByRole('heading', { level: 3, name, exact: true }) })
        .last();
      const rows = models[provider]!.rows!;
      expect(rows.length).toBeGreaterThan(0);
      const items = section.getByRole('listitem');
      await expect(items).toHaveCount(rows.length);
      for (const [index, row] of rows.entries()) {
        await expect(items.nth(index)).toContainText(row.model!);
        await expect(items.nth(index)).toContainText(`${compact(row.tokens)} ${row.sharePercent}%`);
      }
      // A share is a share of that provider's tokens: its own list adds up to its own whole.
      const total = rows.reduce((sum, row) => sum + (row.sharePercent ?? 0), 0);
      expect(total).toBeGreaterThanOrEqual(98);
      expect(total).toBeLessThanOrEqual(102);
    }
  });

  test('the bar is decoration beside written figures: solid for Codex, hatched for Claude Code', async ({
    page,
  }) => {
    await openTrends(page, 1280);
    const bars = modelsCard(page).locator('li > span[aria-hidden="true"] > span');
    const styles = await bars.evaluateAll((els) =>
      els.map((el) => ({
        width: (el as HTMLElement).style.width,
        hatch: (el as HTMLElement).style.background.includes('repeating-linear-gradient'),
      })),
    );
    expect(styles.length).toBeGreaterThan(2);
    // Codex's bars come first and are plain; Claude Code's are the hatched ones.
    expect(styles[0]!.hatch).toBe(false);
    expect(styles.at(-1)!.hatch).toBe(true);
    for (const style of styles) expect(style.width).toMatch(/^\d+%$/);
  });

  test('the provider filter leaves one provider; the repo filter narrows it and the author filter is not asked', async ({
    page,
  }) => {
    const modelRequests: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/models') modelRequests.push(url.search);
    });
    await openTrends(page, 1280, { search: '?provider=claude&repos=kelvin/atlas-api' });
    await expect(modelsCard(page).getByRole('heading', { level: 3 })).toHaveText(['Claude Code']);
    await expect(modelsCard(page)).toContainText('This machine · kelvin/atlas-api · Claude Code');
    // The models endpoint takes the period, repos and provider; never the author.
    expect(modelRequests).toHaveLength(1);
    expect(modelRequests[0]).not.toContain('author');
  });

  test('a provider with no figure says why in words, never an empty list', async ({ page }) => {
    // No local source at all.
    await openTrends(page, 1280, { world: { scenario: 'account-only' } });
    await expect(modelsCard(page).getByText('No local records on this machine.')).toHaveCount(2);
    await expect(
      page.getByText('No local agent records were found on this machine.'),
    ).toBeVisible();
  });

  test('a period before the history says it is unavailable, not empty', async ({ page }) => {
    await openTrends(page, 1280, { search: '?start=2025-11-04&end=2026-01-31' });
    await expect(modelsCard(page).getByText('History unavailable for this period.')).toHaveCount(2);
  });

  test('a period that has not happened yet says so', async ({ page }) => {
    await openTrends(page, 1280, { search: '?start=2026-11-06&end=2026-11-08' });
    await expect(modelsCard(page).getByText('This period hasn’t happened yet.')).toHaveCount(2);
  });

  test('keeps its title and shows quiet bars while it loads', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorld(page);
    await slow(page, '/api/models', 1500);
    await page.goto(`${ORIGIN}/trends`);
    await expect(
      page.getByRole('heading', { level: 2, name: 'Recorded tokens by model' }),
    ).toBeVisible();
    await expect(page.getByText('Loading tokens by model')).toBeAttached();
    await expect(modelsCard(page).getByRole('heading', { level: 3 })).toHaveCount(0);
    await expect(modelsCard(page).getByRole('heading', { level: 3 })).toHaveCount(2);
    await expect(page.getByText('Loading tokens by model')).toHaveCount(0);
  });

  test('says it could not be read and Try again lists the models', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorld(page);
    const failing = await failOnce(page, '/api/models');
    await page.goto(`${ORIGIN}/trends`);
    const alert = page.getByRole('alert').filter({ hasText: 'Couldn’t load this' });
    await expect(alert).toBeVisible();
    expect(failing.failed()).toBe(1);
    await expect(yearGrid(page)).toBeVisible();
    await alert.getByRole('button', { name: 'Try again' }).click();
    await expect(modelsCard(page).getByRole('heading', { level: 3 })).toHaveCount(2);
  });

  test(
    'on a phone a long model name is cut with an ellipsis and carries its full name',
    { tag: '@responsive' },
    async ({ page }) => {
      await openTrends(page, 390);
      const name = modelsCard(page).getByText('claude-sonnet-5-5');
      await expect(name).toHaveAttribute('title', 'claude-sonnet-5-5');
      const cut = await name.evaluate((el) => getComputedStyle(el).textOverflow === 'ellipsis');
      expect(cut).toBe(true);
    },
  );
});

// ============================================================================================================================
// Notices
// ============================================================================================================================

test.describe('notices', () => {
  test('history that starts after the period does is said once, and the repo filter says what it leaves out', async ({
    page,
  }) => {
    await openTrends(page, 1280, {
      search: '?start=2025-11-04&end=2026-11-04&repos=kelvin/atlas-api',
    });
    await expect(
      page.getByText(
        'Local usage history on this machine starts: Codex from Feb 2, 2026; Claude Code from Mar 15, 2026. Earlier dates show as unavailable, not zero.',
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        'Repo filter is on: sessions with an unknown or untracked repo are excluded. Account-reported usage is not filtered by repo.',
      ),
    ).toBeVisible();
  });
});

// ============================================================================================================================
// Containment, accessibility, and the network
// ============================================================================================================================

test.describe('containment and accessibility', () => {
  for (const width of [1280, 390, 320]) {
    test(
      `${width}px, with a selection: the containment check finds no FAIL`,
      { tag: '@responsive' },
      async ({ page }) => {
        await openTrends(page, width, { search: '?sel=2026-11-03' });
        await expect(selection(page)).toBeVisible();
        const report = await measureContainment(page);
        expect(failures(report), JSON.stringify(report, null, 2)).toEqual([]);
        // The year grid is the one deliberate sideways scroller on the page.
        expect(report.scrollers.length).toBeLessThanOrEqual(1);
      },
    );

    test(
      `${width}px, with a selection: axe finds no violations`,
      { tag: '@a11y' },
      async ({ page }) => {
        await openTrends(page, width, { search: '?sel=2026-11-03' });
        await expect(selection(page)).toBeVisible();
        const { violations } = await new AxeBuilder({ page }).analyze();
        const summary = violations.map(
          (v) =>
            `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).join('\n    ')}`,
        );
        expect(summary, `axe found ${violations.length} violation(s)`).toEqual([]);
      },
    );
  }

  for (const [name, options] of [
    ['no tracked repos', { world: { scenario: 'no-repos' as const } }],
    ['no local records', { world: { scenario: 'account-only' as const } }],
    ['history from partway', { search: '?start=2025-11-04&end=2026-11-04' }],
    ['a period that has not happened', { search: '?start=2026-11-06&end=2026-11-08' }],
  ] as const) {
    test(
      `${name}: no containment FAIL and no axe violation at 390px`,
      { tag: '@a11y' },
      async ({ page }) => {
        await openTrends(page, 390, options);
        expect(failures(await measureContainment(page))).toEqual([]);
        const { violations } = await new AxeBuilder({ page }).analyze();
        expect(violations.map((v) => v.id)).toEqual([]);
      },
    );
  }

  test('the page makes no request outside the origin, and the server logged no warning or error', async ({
    page,
  }) => {
    const outside: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith(ORIGIN)) outside.push(request.url());
    });
    const { world } = await openTrends(page, 1280);
    await expect(yearGrid(page)).toBeVisible();
    await expect(chart(page)).toBeVisible();
    expect(outside).toEqual([]);
    expect(world.logs).toEqual([]);
  });
});
