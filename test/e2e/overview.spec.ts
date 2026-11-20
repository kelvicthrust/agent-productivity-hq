import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { recomputeLinks } from '../../src/server/services/links.ts';
import { OverviewResponse } from '../../src/shared/contracts/overview.ts';
import { compact, int } from '../../src/client/lib/format';
import { expect, test } from './fixtures';
import { failures, findWrappedCells, measureContainment } from './helpers/containment';
import { closeFilters, openFilters } from './helpers/filtersPopover';
import { ORIGIN } from './helpers/virtualOrigin';
import { answerApi, openWorld, type World, type WorldOptions } from './helpers/world';

// The Overview (M7: A27) in a real browser, against the real API over the seeded world. Nothing is stubbed unless a test says
// so: the numbers on the page are the server's own, and the spec reads the same API to know what to expect.
//
// What is covered, from the assignment's goals (G7_4, G7_5 and the client half of G7_7):
//   - the five tiles with the API's own figures, Merged PRs first on the delivery surface, and every way a figure is missing
//     said in words (no local records, history unavailable, not yet, no tracked repos), never a 0 nobody measured
//   - the provider ledger stacked by default and side by side by the tile's own width (a container query)
//   - the account cards show setup and unavailable states and disclose their account-wide scope
//   - the repository table (and its cards on a phone), the recent merges, the quiet panel and the empty state
//   - loading skeletons and "Try again" panels for the page and for the chart
//   - the chart's selection, which is the records drawer's open bucket (the drawer itself is milestone M7's next part)
//   - containment at 1280, 390 and 320px, and axe
//
// The fixed clock is Wed 2026-11-04 in America/Los_Angeles, so the default period is Mon Nov 2 to Sun Nov 8.

// ---- helpers ------------------------------------------------------------------------------------------------------------

interface Opened {
  world: World;
}

async function openOverview(
  page: Page,
  width: number,
  options: { search?: string; world?: WorldOptions; height?: number } = {},
): Promise<Opened> {
  await page.setViewportSize({ width, height: options.height ?? 900 });
  const world = await openWorld(page, options.world);
  await page.goto(`${ORIGIN}/${options.search ?? ''}`);
  await expect(tile(page, 'Merged PRs')).toBeVisible();
  return { world };
}

/** The server's own answer for the same query, for what the page should say. */
async function readOverview(world: World, search = '') {
  const answer = await answerApi(world.app, {
    method: 'GET',
    path: `/api/overview${search}`,
    headers: {},
  });
  return OverviewResponse.parse(JSON.parse(answer.body.toString('utf8')));
}

/** Changes one API answer on its way to the page. Register before the page loads: the last route registered wins. */
async function patchApi(
  page: Page,
  world: World,
  path: string,
  patch: (body: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  await page.route(new RegExp(`${ORIGIN}${path}(\\?|$)`), async (route) => {
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

const tile = (page: Page, name: string): Locator => page.getByRole('group', { name, exact: true });
const card = (page: Page, name: string): Locator => page.getByRole('region', { name, exact: true });
const strip = (page: Page): Locator => page.getByRole('region', { name: 'Source coverage' });
const chart = (page: Page): Locator =>
  page.getByRole('group', { name: /^Delivery and usage over time/ });
const repoTable = (page: Page): Locator =>
  page.getByRole('table', { name: 'Merged PRs and recorded local tokens by repository' });
const FAIL_BODY = JSON.stringify({
  error: { code: 'internal', message: 'Something went wrong.', retryable: false },
});

test('Overview and Delivery show cached link health after reload and clear it after rebuild', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { world } = await openOverview(page, 1280);
  const stale = page.getByText(
    'Pull request links are out of date. Showing the last successful rebuild.',
  );
  await expect(stale).toHaveCount(0);

  world.db.exec(
    "UPDATE pull_request SET head_ref = 'feature/crew-stale-test' WHERE node_id = (SELECT node_id FROM pull_request LIMIT 1)",
  );
  await page.reload();
  await expect(stale).toBeVisible();
  await expect(tile(page, 'Linked PRs')).toBeVisible();
  await expect(page).toHaveURL(`${ORIGIN}/`);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('link', { name: 'Delivery', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${ORIGIN}/delivery`));
  await expect(page.getByRole('heading', { name: 'Delivery', exact: true })).toBeVisible();
  await expect(stale).toBeVisible();
  expect(failures(await measureContainment(page))).toEqual([]);

  recomputeLinks(world.db, Date.parse('2026-11-04T20:15:00Z'));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Merged pull requests' })).toBeVisible();
  await expect(stale).toHaveCount(0);
  expect(errors).toEqual([]);
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

// ============================================================================================================================
// The greeting
// ============================================================================================================================

test.describe('the greeting', () => {
  test('is the part of the day in the report timezone, with the first name when the profile has one', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const world = await openWorld(page);
    await patchApi(page, world, '/api/bootstrap', (body) => ({ ...body, greetingName: 'Kelvin' }));
    const h1 = page.getByRole('heading', { level: 1 });
    // The report zone is America/Los_Angeles (UTC-8 in November): 9:52 AM, 1:00 PM and 7:00 PM there.
    for (const [instant, words] of [
      ['2026-11-04T17:52:00Z', 'Morning, Kelvin'],
      ['2026-11-04T21:00:00Z', 'Afternoon, Kelvin'],
      ['2026-11-05T03:00:00Z', 'Evening, Kelvin'],
    ] as const) {
      await page.clock.setFixedTime(new Date(instant));
      await page.goto(`${ORIGIN}/`);
      // The page's name is read first (a screen reader lands on this heading), then the greeting the design draws.
      await expect(h1).toHaveText(`Overview: ${words}`);
      await expect(h1.getByText(words)).toBeVisible();
    }
  });

  test('says Good morning when no name is known, and names the period under it', async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date('2026-11-04T17:52:00Z'));
    await openOverview(page, 1280);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview: Good morning');
    await expect(
      page.getByText(
        'Here’s what merged and where your agents spent their tokens · this week, Nov 2 – Nov 8, 2026',
      ),
    ).toBeVisible();
    await expect(page).toHaveTitle('Overview · Agent Productivity HQ');
  });
});

// ============================================================================================================================
// The tiles
// ============================================================================================================================

test.describe('the tiles', () => {
  test('show the API’s own figures, and the providers are never added together', async ({
    page,
  }) => {
    const { world } = await openOverview(page, 1280);
    const { kpis } = await readOverview(world);

    const merged = tile(page, 'Merged PRs');
    await expect(merged).toContainText('All repos · Authored by you');
    await expect(merged).toContainText(int(kpis.mergedPrs!.value));
    await expect(merged).toContainText(
      `${kpis.mergedPrs!.previous!.label}: ${kpis.mergedPrs!.previous!.value}`,
    );

    const linked = tile(page, 'Linked PRs');
    await expect(linked).toContainText('Evidence or owner-confirmed');
    await expect(linked).toContainText(`${kpis.linkedPrs!.value} of ${kpis.linkedPrs!.of}`);
    await expect(linked).toContainText(`${kpis.linkedPrs!.suggestedOnly} with suggestions only`);
    await expect(linked).not.toContainText('aren’t built yet');

    const tokens = tile(page, 'Recorded local tokens');
    const codex = kpis.localTokens!.codex!.value!;
    const claude = kpis.localTokens!.claude!.value!;
    await expect(tokens).toContainText('This machine · All repos · All providers');
    await expect(tokens.getByRole('term').filter({ hasText: 'Codex' })).toBeVisible();
    await expect(tokens.getByRole('term').filter({ hasText: 'Claude Code' })).toBeVisible();
    await expect(tokens.getByRole('definition').filter({ hasText: compact(codex) })).toBeVisible();
    await expect(tokens.getByRole('definition').filter({ hasText: compact(claude) })).toBeVisible();
    await expect(tokens.getByText(compact(codex + claude), { exact: true })).toHaveCount(0);
    await expect(tokens).toContainText('Provider totals aren’t combined.');

    const roots = tile(page, 'Root sessions');
    await expect(roots).toContainText('Active in period');
    await expect(roots).toContainText(int(kpis.rootSessions!.value));
    await expect(roots).toContainText(
      `${kpis.rootSessions!.unknownRelationship} with unknown relationship`,
    );

    const children = tile(page, 'Child agents');
    await expect(children).toContainText('Known parent, active in period');
    await expect(children).toContainText(int(kpis.childAgents!.value));
    await expect(children).toContainText(
      `Paseo ${kpis.childAgents!.paseo} · native ${kpis.childAgents!.native}`,
    );
  });

  test('the provider filter leaves one provider in the tokens tile; the repo filter narrows it', async ({
    page,
  }) => {
    const { world } = await openOverview(page, 1280, {
      search: '?provider=codex&repos=kelvin/atlas-api',
    });
    const { kpis } = await readOverview(world, '?provider=codex&repos=kelvin/atlas-api');
    const tokens = tile(page, 'Recorded local tokens');
    await expect(tokens).toContainText('This machine · kelvin/atlas-api · Codex');
    await expect(tokens.getByRole('term')).toHaveText(['Codex']);
    await expect(tokens.getByRole('definition')).toHaveText([
      compact(kpis.localTokens!.codex!.value!),
    ]);
    await expect(tile(page, 'Merged PRs')).toContainText('kelvin/atlas-api · Authored by you');
  });

  test('Merged PRs and each provider carry their own 12-week trend, never a combined one', async ({
    page,
  }) => {
    await openOverview(page, 1280);
    const trend = /^(Codex |Claude Code )?12-week trend, oldest to newest: .+; this week /;
    await expect(tile(page, 'Merged PRs').getByRole('img', { name: trend })).toHaveCount(1);
    // One line per provider, inside that provider's own cell of the ledger, and the tile has no third, summed one.
    const tokens = tile(page, 'Recorded local tokens');
    await expect(tokens.getByRole('img', { name: trend })).toHaveCount(2);
    await expect(tokens.getByRole('definition').nth(0).getByRole('img')).toHaveCount(1);
    await expect(tokens.getByRole('definition').nth(1).getByRole('img')).toHaveCount(1);
    for (const name of ['Linked PRs', 'Root sessions', 'Child agents']) {
      await expect(tile(page, name).getByRole('img', { name: trend })).toHaveCount(0);
    }
  });

  test('the trend follows the provider filter but not the period', async ({ page }) => {
    await openOverview(page, 1280, { search: '?provider=codex' });
    const trend = /^Codex 12-week trend, oldest to newest: /;
    await expect(tile(page, 'Recorded local tokens').getByRole('img', { name: trend })).toHaveCount(
      1,
    );
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await page.goto(`${ORIGIN}/?provider=codex&start=2026-10-01&end=2026-10-10`);
    await expect(tile(page, 'Merged PRs')).toBeVisible();
    // The trend asks for twelve weeks ending with this one, not for the selected dates.
    expect(
      requests.some(
        (url) =>
          url.includes('/api/series') &&
          url.includes('start=2026-08-17') &&
          url.includes('end=2026-11-08'),
      ),
    ).toBe(true);
  });

  test('waits for the selected author’s KPI before drawing the matching trend', async ({
    page,
  }) => {
    await openOverview(page, 1280);
    const merged = tile(page, 'Merged PRs');
    const trend = merged.getByRole('img', { name: /^12-week trend/ });
    await expect(trend).toBeVisible();

    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`${ORIGIN}/api/overview?**`, async (route) => {
      if (new URL(route.request().url()).searchParams.get('author') === 'all') {
        await held;
      }
      await route.fallback();
    });

    try {
      const panel = await openFilters(page);
      const trendResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === '/api/series' &&
          url.searchParams.get('start') === '2026-08-17' &&
          url.searchParams.get('author') === 'all'
        );
      });
      await panel.getByRole('radio', { name: 'All in tracked repos' }).click();
      await closeFilters(page);
      expect(await (await trendResponse).finished()).toBeNull();
      // Let the client paint the completed series while the new totals request is still held.
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      await expect(merged).toContainText('Authored by you');
      await expect(trend).toBeHidden();
    } finally {
      release();
    }

    await expect(merged).toContainText('All authors');
    await expect(trend).toBeVisible();
  });

  test('Merged PRs comes first, on the delivery surface', async ({ page }) => {
    await openOverview(page, 1280);
    const first = page.locator('section[aria-label="Summary metrics"] > [role="group"]').first();
    await expect(first).toHaveAccessibleName('Merged PRs');
    const sameColour = await first.evaluate((el) => {
      const probe = document.createElement('div');
      probe.style.background = 'var(--color-delivery-surface)';
      document.body.append(probe);
      const token = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return getComputedStyle(el).backgroundColor === token && token !== 'rgba(0, 0, 0, 0)';
    });
    expect(sameColour).toBe(true);
  });

  test(
    'summary tiles follow the same reading order on desktop and phone',
    { tag: '@responsive' },
    async ({ page }) => {
      const names = [
        'Merged PRs',
        'Linked PRs',
        'Recorded local tokens',
        'Root sessions',
        'Child agents',
      ];
      const boxes = async () =>
        Promise.all(names.map(async (name) => (await tile(page, name).boundingBox())!));

      await openOverview(page, 1280);
      const row = await boxes();
      expect(new Set(row.map((box) => Math.round(box.y))).size).toBe(1);
      expect(row.map((box) => box.x)).toEqual([...row.map((box) => box.x)].sort((a, b) => a - b));

      await page.setViewportSize({ width: 390, height: 900 });
      const phone = await boxes();
      const [merged, linked, tokens, roots, children] = phone as [
        (typeof phone)[0],
        (typeof phone)[0],
        (typeof phone)[0],
        (typeof phone)[0],
        (typeof phone)[0],
      ];
      expect(linked.y).toBe(merged.y);
      expect(merged.x).toBeLessThan(linked.x);
      expect(tokens.y).toBeGreaterThan(linked.y);
      expect(roots.y).toBeGreaterThan(tokens.y);
      expect(children.y).toBe(roots.y);
      expect(roots.x).toBeLessThan(children.x);
      expect(tokens.width).toBeCloseTo(linked.x + linked.width - merged.x, 0);
      await expect(card(page, 'Summary metrics').getByRole('group')).toHaveText(
        names.map((name) => new RegExp(`^${name}`)),
      );
    },
  );

  test(
    'on a 320×700 phone the weekly delivery counts fit above the nav without the source checklist',
    { tag: '@responsive' },
    async ({ page }) => {
      await openOverview(page, 320, { height: 700 });
      await expect(strip(page)).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Filters' })).toBeInViewport();
      await expect(tile(page, 'Merged PRs').getByText('8', { exact: true })).toBeInViewport({
        ratio: 1,
      });
      const linked = tile(page, 'Linked PRs').getByText('5 of 8', { exact: true });
      await expect(linked).toBeInViewport({ ratio: 1 });
      const nav = await page.getByRole('navigation', { name: 'Sections' }).boundingBox();
      const value = await linked.boundingBox();
      expect(value!.y + value!.height).toBeLessThan(nav!.y);
    },
  );

  test(
    'on a phone refresh retry follows the metrics and on desktop it precedes them',
    { tag: '@responsive' },
    async ({ page }) => {
      await openOverview(page, 390, { height: 844, world: { scenario: 'refresh-failed' } });
      const retry = page.getByRole('button', { name: 'Retry', exact: true });
      await expect(retry).toHaveCount(1);
      const metrics = tile(page, 'Merged PRs');
      expect((await retry.boundingBox())!.y).toBeGreaterThan((await metrics.boundingBox())!.y);
      await page.setViewportSize({ width: 1280, height: 900 });
      await expect(retry).toHaveCount(1);
      // The banner changes owner at the breakpoint (the page's below 720px, the shell's from it), so wait for the new one to be drawn.
      await expect
        .poll(async () => {
          const [at, below] = [await retry.boundingBox(), await metrics.boundingBox()];
          return at !== null && below !== null && at.y < below.y;
        })
        .toBe(true);
    },
  );

  test(
    'the provider ledger is stacked by default and goes side by side when its tile is 200px wide inside',
    { tag: '@responsive' },
    async ({ page }) => {
      await openOverview(page, 1280);
      const measure = () =>
        tile(page, 'Recorded local tokens').evaluate((el) => {
          const style = getComputedStyle(el);
          // A container query measures the container's content box.
          const inner =
            el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
          const tops = Array.from(el.querySelectorAll('dl > div')).map((item) =>
            Math.round(item.getBoundingClientRect().top),
          );
          return { inner, sideBySide: tops[0] === tops[1] };
        });

      const seen = new Map<boolean, number>();
      for (const width of [320, 390, 768, 900, 1024, 1280, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const { inner, sideBySide } = await measure();
        // The rule itself, at every width: side by side exactly when the tile's inner width reaches 200px.
        expect(sideBySide, `${width}px: inner ${inner}px`).toBe(inner >= 200);
        seen.set(sideBySide, width);
      }
      // Both layouts were on screen at some width, so neither branch went unchecked.
      expect([...seen.keys()].sort()).toEqual([false, true]);
    },
  );

  test('a figure that does not exist says why in words, never 0', async ({ page }) => {
    // No local source found: tokens, roots and children have no figure; PRs still do.
    await openOverview(page, 1280, { world: { scenario: 'account-only' } });
    const tokens = tile(page, 'Recorded local tokens');
    await expect(tokens.getByText('No local records')).toHaveCount(2);
    await expect(tile(page, 'Root sessions')).toContainText('No local records');
    await expect(tile(page, 'Child agents')).toContainText('No local records');
    await expect(tile(page, 'Merged PRs')).toContainText('8');
    // No local source was found, so no session can link: a true 0 of 8, with nothing suggested, and no excuse is offered for it.
    await expect(tile(page, 'Linked PRs')).toContainText('0 of 8');
    await expect(tile(page, 'Linked PRs')).toContainText('0 with suggestions only');
    await expect(tile(page, 'Linked PRs')).not.toContainText('aren’t built yet');
    await expect(tile(page, 'Linked PRs')).not.toContainText('milestone');
    await expect(
      page.getByText('No local agent records were found on this machine.'),
    ).toBeVisible();
  });

  test('no tracked repo: Merged PRs says so and offers Add repositories; Linked PRs has no figure', async ({
    page,
  }) => {
    await openOverview(page, 1280, { world: { scenario: 'no-repos' } });
    const merged = tile(page, 'Merged PRs');
    await expect(merged).toContainText('No tracked repos');
    await expect(merged.getByRole('link', { name: 'Add repositories' })).toHaveAttribute(
      'href',
      '/sources',
    );
    await expect(tile(page, 'Linked PRs')).toContainText('—');
    // Local usage is still real without repositories.
    await expect(tile(page, 'Root sessions')).toContainText('14');
  });

  test('a period that has not happened yet says so', async ({ page }) => {
    await openOverview(page, 1280, { search: '?start=2026-11-06&end=2026-11-08' });
    await expect(tile(page, 'Merged PRs')).toContainText('This period hasn’t happened yet.');
    await expect(
      tile(page, 'Recorded local tokens').getByText('This period hasn’t happened yet.'),
    ).toHaveCount(2);
    await expect(tile(page, 'Root sessions')).toContainText('This period hasn’t happened yet.');
  });

  test('history that starts partway through the period is a marker built from the date, and a comparison before the lookback says so', async ({
    page,
  }) => {
    const { world } = await openOverview(page, 1280, {
      search: '?start=2025-11-04&end=2026-11-04',
    });
    const { kpis } = await readOverview(world, '?start=2025-11-04&end=2026-11-04');
    // The API's note is a marker ("From <date> only"); the page writes the words from `coveredFrom`.
    expect(kpis.localTokens!.codex!.note).toBe('From <date> only');
    const tokens = tile(page, 'Recorded local tokens');
    await expect(tokens).toContainText('From Feb 2, 2026 only');
    await expect(tokens).toContainText('From Mar 15, 2026 only');
    await expect(tokens).not.toContainText('<date>');
    await expect(tile(page, 'Merged PRs')).toContainText(
      `${kpis.mergedPrs!.previous!.label}: outside the 12-month lookback`,
    );
    await expect(
      page.getByText(
        'Local usage history on this machine starts: Codex from Feb 2, 2026; Claude Code from Mar 15, 2026. Earlier dates show as unavailable, not zero.',
      ),
    ).toBeVisible();
  });

  test('a provider whose refresh failed shows its cached figure with the short marker', async ({
    page,
  }) => {
    const { world } = await openOverview(page, 1280, { world: { scenario: 'refresh-failed' } });
    const { kpis } = await readOverview(world);
    expect(kpis.localTokens!.codex!.coverage).toBe('stale');
    const tokens = tile(page, 'Recorded local tokens');
    await expect(tokens).toContainText('Cached; recent days missing');
    // The stale Codex figure is still the figure that was imported, and Claude Code is untouched.
    await expect(
      tokens.getByRole('definition').filter({ hasText: compact(kpis.localTokens!.codex!.value!) }),
    ).toBeVisible();
    await expect(
      tokens.getByRole('definition').filter({ hasText: compact(kpis.localTokens!.claude!.value!) }),
    ).toBeVisible();
  });
});

// ============================================================================================================================
// The account cards
// ============================================================================================================================

test.describe('the account cards', () => {
  test('show the account scope beside the heading and the providers’ initial status', async ({
    page,
  }) => {
    await openOverview(page, 1280);
    const accounts = card(page, 'Account-reported usage');
    const heading = accounts.getByRole('heading', { name: 'Account-reported usage' });
    const scopeBadge = accounts.getByText('Not filtered by repo', { exact: true });
    await expect(scopeBadge).toHaveCount(1);
    await expect(
      heading.locator('..').getByText('Not filtered by repo', { exact: true }),
    ).toBeVisible();
    const items = accounts.getByRole('listitem');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText('ChatGPT');
    await expect(items.nth(0)).toContainText('Codex plan');
    await expect(items.nth(0)).toContainText('Not connected');
    await expect(items.nth(1)).toContainText('Claude');
    await expect(items.nth(1)).toContainText('Claude Code plan');
    await expect(items.nth(1)).toContainText('Not checked');
  });

  test('say Unavailable for an account that cannot report', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const world = await openWorld(page);
    await patchApi(page, world, '/api/overview', (body) => {
      const coverage = body['coverage'] as { accounts: Array<Record<string, unknown>> };
      return {
        ...body,
        coverage: {
          ...coverage,
          accounts: coverage.accounts.map((account) =>
            account['id'] === 'claude'
              ? {
                  ...account,
                  status: 'unavailable',
                  planLimits: {
                    state: 'unsupported',
                    lastCheckedAt: null,
                    retryAt: null,
                    report: null,
                  },
                }
              : account,
          ),
        },
      };
    });
    await page.goto(`${ORIGIN}/`);
    const items = card(page, 'Account-reported usage').getByRole('listitem');
    await expect(items.nth(1)).toContainText('Unsupported sign-in');
    await expect(items.nth(0)).toContainText('Not connected');
  });

  test('the provider filter chooses which cards show; the repo filter changes nothing about them', async ({
    page,
  }) => {
    await openOverview(page, 1280, { search: '?provider=claude&repos=kelvin/atlas-api' });
    const items = card(page, 'Account-reported usage').getByRole('listitem');
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText('Claude Code plan');
    // The notice says why the repo filter leaves the cards alone.
    await expect(
      page.getByText(
        'Repo filter is on: sessions with an unknown or untracked repo are excluded. Account-reported usage is not filtered by repo.',
      ),
    ).toBeVisible();
  });

  test('Source coverage is on Sources and loads without requesting Overview', async ({ page }) => {
    await openWorld(page);
    const reports: string[] = [];
    page.on('request', (request) => reports.push(new URL(request.url()).pathname));
    await page.goto(`${ORIGIN}/sources`);
    const coverage = strip(page);
    await expect(coverage.getByRole('group', { name: 'On this machine' })).toContainText('Codex');
    await expect(coverage.getByRole('group', { name: 'Delivery' })).toContainText(
      '5 repos tracked',
    );
    await expect(coverage.getByRole('group', { name: 'Account reports' })).toContainText(
      'Not checked yet',
    );
    expect(reports).not.toContain('/api/overview');
    expect(reports).not.toContain('/api/series');
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const toggle = coverage.getByRole('button', { name: /^Source coverage/ });
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(toggle).toContainText('Needs attention');
      await toggle.click();
      await expect(coverage.getByRole('group', { name: 'Delivery' })).toBeVisible();
      await toggle.click();
    }
  });
});

// ============================================================================================================================
// By repository and recently merged
// ============================================================================================================================

test.describe('by repository', () => {
  test('one row per tracked repo with the API’s figures, then the usage-only groups', async ({
    page,
  }) => {
    const { world } = await openOverview(page, 1280);
    const { repoRows } = await readOverview(world);
    const table = repoTable(page);
    await expect(
      table
        .getByRole('columnheader')
        .allTextContents()
        .then((names) => names.map((n) => n.trim())),
    ).resolves.toEqual([
      'Repository',
      'Merged PRs',
      'Linked',
      'Codex tokens',
      'Claude Code tokens',
      'Root sessions',
    ]);

    for (const row of repoRows.filter(
      (r) => r.group === 'tracked' && r.accessState !== 'inaccessible',
    )) {
      const cells = table
        .getByRole('row')
        .filter({ has: page.getByRole('rowheader', { name: row.repo!, exact: true }) });
      await expect(cells.getByRole('cell')).toHaveText([
        int(row.mergedPrs),
        int(row.linkedPrs),
        compact(row.tokens!.codex),
        compact(row.tokens!.claude),
        int(row.rootSessions),
      ]);
    }

    // The order D7 draws: the repos that can be read by merged PRs (a tie by name), then a repo GitHub no longer grants, then the
    // usage-only groups.
    const names = await table.getByRole('rowheader').allTextContents();
    const order = names.map((name) => name.trim().replace(/\s+Inaccessible.*$/s, ''));
    const readable = repoRows
      .filter((r) => r.group === 'tracked' && r.accessState !== 'inaccessible')
      .sort((a, b) => (b.mergedPrs ?? 0) - (a.mergedPrs ?? 0) || a.repo!.localeCompare(b.repo!))
      .map((r) => r.repo!);
    expect(order).toEqual([
      ...readable,
      'kelvin/archive-private',
      'Untracked repos (usage only)',
      'Unknown repo (usage only)',
    ]);

    // A repo GitHub no longer grants: its PR figures were not collected ("—", not 0), and the way to fix it is one link away.
    const lost = table.getByRole('row').filter({ hasText: 'kelvin/archive-private' });
    await expect(lost).toContainText('Inaccessible');
    await expect(lost.getByRole('link', { name: 'Fix' })).toHaveAttribute('href', '/sources');
    await expect(lost.getByRole('cell').nth(0)).toHaveText('—');
    await expect(lost.getByRole('cell').nth(1)).toHaveText('—');

    // Sessions with no tracked repo are usage only: there are no PR figures for them.
    for (const name of ['Untracked repos (usage only)', 'Unknown repo (usage only)']) {
      const group = table.getByRole('row').filter({ hasText: name });
      await expect(group.getByRole('cell').nth(0)).toHaveText('n/a');
      await expect(group.getByRole('cell').nth(1)).toHaveText('n/a');
    }
  });

  test('providers are columns of their own: the provider filter leaves one', async ({ page }) => {
    await openOverview(page, 1280, { search: '?provider=codex' });
    await expect(repoTable(page).getByRole('columnheader', { name: 'Codex tokens' })).toBeVisible();
    await expect(
      repoTable(page).getByRole('columnheader', { name: 'Claude Code tokens' }),
    ).toHaveCount(0);
  });

  test('a provider with no local source has no figure in any row: the cells say so in words', async ({
    page,
  }) => {
    await openOverview(page, 1280, { world: { scenario: 'account-only' } });
    // Five tracked repos, two providers: every token cell is words, none is a 0.
    await expect(repoTable(page).getByRole('cell', { name: 'No records' })).toHaveCount(10);
  });

  test('no tracked repo: it says merged PRs are unavailable and groups the usage by recorded repo', async ({
    page,
  }) => {
    await openOverview(page, 1280, { world: { scenario: 'no-repos' } });
    await expect(
      page.getByText(
        'No tracked repositories yet, so merged PRs aren’t available. Recorded usage is grouped by the repo each session recorded.',
      ),
    ).toBeVisible();
    await expect(repoTable(page).getByRole('row')).toHaveCount(3); // header, untracked, unknown
    // And Recently merged is the empty state with its one way forward.
    const recent = card(page, 'Recently merged');
    await expect(recent.getByRole('heading', { name: 'No tracked repositories' })).toBeVisible();
    await expect(recent.getByRole('link', { name: 'Add repositories' })).toHaveAttribute(
      'href',
      '/sources',
    );
  });

  test('nothing recorded at all says so in one line', async ({ page }) => {
    await openOverview(page, 1280, { world: { scenario: 'empty' } });
    await expect(page.getByText('No recorded activity in this period.')).toBeVisible();
    await expect(repoTable(page)).toHaveCount(0);
  });

  test(
    'the table fits at 1280 with no value wrapped; below 640px each repo is a card of labelled values, not a table',
    { tag: '@responsive' },
    async ({ page }) => {
      await openOverview(page, 1280);
      const wrapped = await findWrappedCells(repoTable(page), [
        'Merged PRs',
        'Linked',
        'Codex tokens',
        'Claude Code tokens',
        'Root sessions',
      ]);
      expect(wrapped.checked).toBeGreaterThan(0);
      expect(wrapped.wrapped).toEqual([]);
      // Wide enough here, so the table does not need to scroll sideways.
      const scrolls = await page
        .getByRole('region', { name: 'Repository table, scrolls sideways' })
        .evaluate((el) => el.scrollWidth > el.clientWidth + 1);
      expect(scrolls).toBe(false);

      await page.setViewportSize({ width: 390, height: 900 });
      await expect(repoTable(page)).toHaveCount(0);
      const cards = page.getByRole('list', {
        name: 'Merged PRs and recorded local tokens by repository, one card each',
      });
      await expect(cards.getByRole('listitem')).toHaveCount(7);
      const atlas = cards.getByRole('listitem').filter({ hasText: 'kelvin/atlas-api' });
      await expect(atlas.getByRole('term')).toHaveText([
        'Merged PRs',
        'Linked',
        'Codex tokens',
        'Claude Code tokens',
        'Root sessions',
      ]);
      await expect(atlas.getByRole('definition')).toHaveText(['4', '2', '1.86M', '7.84M', '2']);
    },
  );
});

test.describe('recently merged', () => {
  test('lists the newest merges with their link basis and how many merged in all', async ({
    page,
  }) => {
    const { world } = await openOverview(page, 1280);
    const data = await readOverview(world);
    const recent = card(page, 'Recently merged');
    await expect(recent).toContainText('All repos · Authored by you');
    const items = recent.getByRole('listitem');
    await expect(items).toHaveCount(data.recentPrs.length);
    expect(data.recentPrs.length).toBeLessThanOrEqual(6);

    const first = data.recentPrs[0]!;
    await expect(
      items.first().getByRole('link', { name: new RegExp(first.title) }),
    ).toHaveAttribute('href', first.url);
    await expect(items.first()).toContainText(`${first.repo} #${first.number}`);
    await expect(items.first()).toContainText('Evidence link');
    // Newest first, and a PR that is not linked says Unlinked rather than nothing.
    const titles = await items
      .getByRole('link')
      .evaluateAll((links) =>
        links.map((link) => (link.textContent ?? '').replace(/\s+/g, ' ').trim()),
      );
    expect(titles.map((t) => t.replace(/\s*\(opens GitHub\)$/, '').trim())).toEqual(
      data.recentPrs.map((pr) => pr.title),
    );
    await expect(recent.getByText('Unlinked').first()).toBeVisible();
    await expect(recent).toContainText(`${data.periodMergedCount} merged in this period`);
  });

  test('"View all in Delivery" keeps the period and scope, and lands on Delivery', async ({
    page,
  }) => {
    await openOverview(page, 1280, { search: '?provider=codex&repos=kelvin/atlas-web' });
    const link = card(page, 'Recently merged').getByRole('link', { name: 'View all in Delivery' });
    await expect(link).toHaveAttribute('href', '/delivery?provider=codex&repos=kelvin/atlas-web');
    await link.click();
    await expect(page).toHaveURL(`${ORIGIN}/delivery?provider=codex&repos=kelvin/atlas-web`);
    await expect(page.getByRole('heading', { level: 1, name: 'Delivery' })).toBeVisible();
  });

  test('a period with no merges says so and points at Usage', async ({ page }) => {
    await openOverview(page, 1280, { search: '?start=2026-11-01&end=2026-11-01' });
    await expect(
      page.getByText(
        'No merged PRs in this period authored by you. Agent work that didn’t merge still appears in Usage.',
      ),
    ).toBeVisible();
  });
});

// ============================================================================================================================
// A quiet one
// ============================================================================================================================

test.describe('a quiet one', () => {
  test('a covered period with no activity and no merges is a true zero, said warmly and plainly', async ({
    page,
  }) => {
    await openOverview(page, 1280, { search: '?start=2026-11-01&end=2026-11-01' });
    const quiet = page.getByRole('status').filter({ hasText: 'A quiet one.' });
    await expect(quiet).toContainText(
      'No recorded agent activity and no merges in this period. Every source was collecting, so this is a true zero, not missing data.',
    );
    // The tiles agree: a covered zero is 0.
    await expect(tile(page, 'Merged PRs')).toContainText('0');
    await expect(tile(page, 'Root sessions')).toContainText('0');
    // No PRs, so nothing to link and nothing to say about suggestions.
    await expect(tile(page, 'Linked PRs')).toContainText('0 of 0');
    await expect(tile(page, 'Linked PRs')).not.toContainText('aren’t built yet');
  });

  test('a busy week is not a quiet one', async ({ page }) => {
    await openOverview(page, 1280);
    await expect(page.getByText('A quiet one.')).toHaveCount(0);
  });
});

// ============================================================================================================================
// Loading and failing
// ============================================================================================================================

test(
  'activity has one reading order and the account reports sit beside the chart from the desktop breakpoint',
  { tag: '@responsive' },
  async ({ page }) => {
    await openOverview(page, 1280);
    // The chart's own card (the chart is the svg inside it), so the first row is measured from the card's top.
    const chartCard = chart(page).locator(
      'xpath=ancestor::div[contains(@class, "shadow-card")][1]',
    );
    const activity = [chartCard, card(page, 'Recently merged'), card(page, 'By repository')];
    const accounts = card(page, 'Account-reported usage');
    await expect(accounts).toHaveCount(1);
    await expect(chart(page)).toBeVisible();
    // The reading order is the same at every width: the account card is last, and the grid places it beside the chart.
    await expect(
      page.getByRole('heading', {
        level: 2,
        name: /^(Delivery and usage over time|Recently merged|By repository|Account-reported usage)$/,
      }),
    ).toHaveText([
      'Delivery and usage over time',
      'Recently merged',
      'By repository',
      'Account-reported usage',
    ]);

    const boxes = () =>
      Promise.all([...activity, accounts].map((locator) => locator.boundingBox()));
    const [desktopChart, recent, repo, sidebar] = await boxes();
    // First row: the chart and the account card, top to top, the card to the right.
    expect(sidebar!.y).toBeCloseTo(desktopChart!.y, 0);
    expect(sidebar!.x).toBeGreaterThan(desktopChart!.x + desktopChart!.width - 1);
    // Next rows: Recently merged and By repository, full width, below both cards of the first row.
    const firstRowBottom = Math.max(
      desktopChart!.y + desktopChart!.height,
      sidebar!.y + sidebar!.height,
    );
    expect(recent!.y).toBeGreaterThan(firstRowBottom - 1);
    expect(recent!.x).toBeCloseTo(desktopChart!.x, 0);
    expect(recent!.x).toBeCloseTo(repo!.x, 0);
    expect(recent!.width).toBeCloseTo(repo!.width, 0);
    expect(recent!.x + recent!.width).toBeCloseTo(sidebar!.x + sidebar!.width, 0);
    expect(recent!.y).toBeLessThan(repo!.y);
    // Compact account rows can end well above the chart. Guard against pushing the next section down.
    expect(sidebar!.height).toBeLessThan(desktopChart!.height + 250);

    await page.setViewportSize({ width: 1279, height: 900 });
    const [stackedChart, stackedRecent, stackedRepo, stackedAccounts] = await boxes();
    expect(stackedRecent!.y).toBeGreaterThan(stackedChart!.y + stackedChart!.height);
    expect(stackedAccounts!.y).toBeGreaterThan(stackedRepo!.y + stackedRepo!.height);
    expect(stackedAccounts!.x).toBeCloseTo(stackedRepo!.x, 0);
  },
);

test.describe('loading and failing', () => {
  test('quiet bars stand where the answer will be, then the real tiles and cards replace them', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorld(page);
    await slow(page, '/api/overview', 1500);
    await page.goto(`${ORIGIN}/`);
    await expect(page.getByText('Loading summary metrics')).toBeAttached();
    await expect(page.locator('section[aria-label="Summary metrics"]')).toHaveAttribute(
      'aria-busy',
      'true',
    );
    // The cards that read the overview keep their titles and show bars until it lands.
    for (const name of ['Account-reported usage', 'By repository', 'Recently merged']) {
      await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
    }
    await expect(page.getByText('Not connected')).toHaveCount(0);
    await expect(tile(page, 'Merged PRs')).toHaveCount(0);

    await expect(tile(page, 'Merged PRs')).toBeVisible();
    await expect(page.getByText('Loading summary metrics')).toHaveCount(0);
    await expect(repoTable(page)).toBeVisible();
  });

  test('the chart has its own placeholder while its series loads', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorld(page);
    await slow(page, '/api/series', 1500);
    await page.goto(`${ORIGIN}/`);
    await expect(tile(page, 'Merged PRs')).toBeVisible();
    await expect(page.getByText('Loading chart')).toBeAttached();
    await expect(chart(page)).toHaveCount(0);
    await expect(chart(page)).toBeVisible();
    await expect(page.getByText('Loading chart')).toHaveCount(0);
  });

  test('when the overview cannot be read, a panel says so and Try again brings it back', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorld(page);
    const failing = await failOnce(page, '/api/overview');
    await page.goto(`${ORIGIN}/`);
    const alert = page.getByRole('alert').filter({ hasText: 'Couldn’t load the overview' });
    await expect(alert).toContainText('Your records are still on this machine.');
    expect(failing.failed()).toBe(1);
    // The chart reads its own request, so it is not taken down with the rest.
    await expect(chart(page)).toBeVisible();
    await alert.getByRole('button', { name: 'Try again' }).click();
    await expect(tile(page, 'Merged PRs')).toBeVisible();
    await expect(alert).toHaveCount(0);
    await expect(repoTable(page)).toBeVisible();
  });

  test('when the chart cannot be built, its panel offers Try again, and the rest of the page is untouched', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorld(page);
    const failing = await failOnce(page, '/api/series');
    await page.goto(`${ORIGIN}/`);
    await expect(page.getByText('Couldn’t build this chart')).toBeVisible();
    expect(failing.failed()).toBe(1);
    await expect(tile(page, 'Merged PRs')).toBeVisible();
    await expect(chart(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(chart(page)).toBeVisible();
    await expect(page.getByText('Couldn’t build this chart')).toHaveCount(0);
  });
});

// ============================================================================================================================
// The chart
// ============================================================================================================================

test.describe('the chart', () => {
  // A selection opens the records drawer, and the drawer's open bucket is what the chart marks as selected. What the drawer shows
  // and how it hands focus back is test/e2e/drawer.spec.ts; here the drawer is only closed again so the chart can be used.
  test('a click on a bucket selects it, and so does Enter on the keyboard cursor', async ({
    page,
  }) => {
    await openOverview(page, 1280);
    const bucket = (index: number) => page.locator(`svg [data-bucket-index="${index}"]`);
    await expect(page.locator('svg [data-selected="true"]')).toHaveCount(0);

    await bucket(1).click();
    await expect(bucket(1)).toHaveAttribute('data-selected', 'true');
    await expect(page.locator('svg [data-selected="true"]')).toHaveCount(1);

    // The drawer the click opened is modal: Escape closes it and focus goes back to the bucket, so the chart can be used again.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // The drawer is still closing for a moment after the dialog is gone, and the chart starts its keyboard cursor at the selected
    // bucket while there is one and at the newest otherwise. Wait for the selection to clear and start the cursor at a known bucket
    // (Home), so the keys below do not depend on which side of that moment they land.
    await expect(page.locator('svg [data-selected="true"]')).toHaveCount(0);

    await chart(page).focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    await expect(bucket(0)).toHaveAttribute('data-selected', 'true');
    await expect(page.locator('svg [data-selected="true"]')).toHaveCount(1);
  });

  test('the Table view says the same in words, and a row selects its bucket', async ({ page }) => {
    await openOverview(page, 1280);
    await page.getByRole('radio', { name: 'Table' }).click();
    const rows = page.getByRole('button', { name: /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), / });
    await expect(rows).toHaveCount(7);
    await rows.nth(2).click();
    await expect(rows.nth(2)).toHaveAttribute('aria-current', 'true');
  });

  test('the chart names both scopes and has its own heading', async ({ page }) => {
    await openOverview(page, 1280);
    await expect(
      page.getByRole('heading', { level: 2, name: 'Delivery and usage over time' }),
    ).toBeVisible();
    await expect(
      page
        .getByText(
          'PRs: All repos · Authored by you · Tokens: This machine · All repos · All providers',
        )
        .first(),
    ).toBeVisible();
  });
});

// ============================================================================================================================
// Containment, accessibility, and the network
// ============================================================================================================================

test.describe('containment and accessibility', () => {
  for (const width of [1280, 390, 320]) {
    test(
      `${width}px: the containment check finds no FAIL`,
      { tag: '@responsive' },
      async ({ page }) => {
        await openOverview(page, width);
        const report = await measureContainment(page);
        expect(failures(report), JSON.stringify(report, null, 2)).toEqual([]);
      },
    );

    test(`${width}px: axe finds no violations`, { tag: '@a11y' }, async ({ page }) => {
      await openOverview(page, width);
      const { violations } = await new AxeBuilder({ page }).analyze();
      const summary = violations.map(
        (v) =>
          `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).join('\n    ')}`,
      );
      expect(summary, `axe found ${violations.length} violation(s)`).toEqual([]);
    });
  }

  for (const [name, options] of [
    ['no tracked repos', { world: { scenario: 'no-repos' as const } }],
    ['a quiet one', { search: '?start=2026-11-01&end=2026-11-01' }],
    ['no local records', { world: { scenario: 'account-only' as const } }],
    ['history from partway', { search: '?start=2025-11-04&end=2026-11-04' }],
  ] as const) {
    test(
      `${name}: no containment FAIL and no axe violation at 390px`,
      { tag: '@a11y' },
      async ({ page }) => {
        await openOverview(page, 390, options);
        expect(failures(await measureContainment(page))).toEqual([]);
        const { violations } = await new AxeBuilder({ page }).analyze();
        expect(violations.map((v) => v.id)).toEqual([]);
      },
    );
  }

  test(
    'the table’s scroller, where it must scroll, is a named, focusable region',
    { tag: '@a11y' },
    async ({ page }) => {
      await openOverview(page, 640);
      const region = page.getByRole('region', { name: 'Repository table, scrolls sideways' });
      await expect(region).toHaveAttribute('tabindex', '0');
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(violations.map((v) => v.id)).toEqual([]);
    },
  );

  test('the page makes no request outside the origin, and the server logged no warning or error', async ({
    page,
  }) => {
    const outside: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith(ORIGIN)) outside.push(request.url());
    });
    const { world } = await openOverview(page, 1280);
    await expect(repoTable(page)).toBeVisible();
    await expect(chart(page)).toBeVisible();
    expect(outside).toEqual([]);
    expect(world.logs).toEqual([]);
  });
});
