import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { Hono } from 'hono';
import { createRunner } from '../../src/server/collectors/runner.ts';
import type { SourceAdapter } from '../../src/server/collectors/types.ts';
import { recordDiscovery } from '../../src/server/db/queries/sources.ts';
import { correlation, errorHandler, type HttpEnv } from '../../src/server/http/errors.ts';
import { refreshRoutes } from '../../src/server/http/routes/refresh.ts';
import { sourcesRoutes } from '../../src/server/http/routes/sources.ts';
import { createLogger } from '../../src/server/lib/logger.ts';
import { FIXED_NOW, FIXED_TIMEZONE } from '../fixtures/seed.ts';
import {
  fails,
  gate,
  holds,
  scriptedAdapter,
  skips,
  succeeds,
} from '../fixtures/scripted-adapters/scripted.ts';
import { expect, test } from './fixtures';
import { ORIGIN } from './helpers/virtualOrigin';
import { answerApi, type World } from './helpers/world';

// Recovery from a failed refresh (M4: A17): the banner, Retry, and the Sources page's local section, in the real build in
// a real browser. The data is the seeded world behind the real API. The refresh runner is the real one over that
// database, with scripted adapters standing in for the log folders (test/fixtures/scripted-adapters): a test decides when
// a source finishes and what it says, and the page learns it only the way it does in use, by polling the run.
//
// The fixed clock is Wed 2026-11-04 9:42 AM in America/Los_Angeles. In the "refresh-failed" world Codex last worked on
// Nov 3 at 6:12 PM and failed at 9:40 AM today, once; the Claude account and one repo need attention too (3 issues).

const FAILED_BODY =
  'Codex refresh failed today, 9:40 AM. Last successful refresh: Nov 3, 6:12 PM. Codex usage since then isn’t collected yet. Previously collected records are kept.';
const FAILED_AGAIN_BODY =
  'Codex refresh failed again today, 9:52 AM. Last successful refresh: Nov 3, 6:12 PM. Codex usage since then isn’t collected yet. Previously collected records are kept.';
const TOAST = {
  recovered: 'Codex refreshed · 4 new sessions imported. Records already imported were skipped.',
  failedAgain: 'Codex still couldn’t be refreshed. Try again.',
  failedFirst: 'Codex couldn’t be refreshed. Try again.',
};

/**
 * Serves GET /api/sources, POST /api/refresh and GET /api/refresh/{id} from this process: the real routes over the world's
 * database, with a real runner over `adapters`. Registered after the world's own routes, so it answers first (and works
 * whether or not the app has these routes mounted yet).
 */
async function mount(page: Page, world: World, adapters: readonly SourceAdapter[]) {
  let now = FIXED_NOW;
  const logs: string[] = [];
  const logger = createLogger({ sink: (line) => logs.push(line), level: 'warn', now: () => now });
  const runner = createRunner({ db: world.db, now: () => now, logger, adapters });
  const api = new Hono<HttpEnv>();
  api.use('*', correlation());
  api.onError(errorHandler(logger));
  api.route('/', sourcesRoutes({ db: world.db, timezone: FIXED_TIMEZONE }));
  api.route('/', refreshRoutes({ db: world.db, runner }));
  await page.route(
    (url) => url.origin === ORIGIN && /^\/api\/(sources|refresh)(\/|$)/.test(url.pathname),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const answer = await answerApi(api, {
        method: request.method(),
        path: url.pathname + url.search,
        headers: request.headers(),
        body: request.postDataBuffer(),
      });
      await route.fulfill({ status: answer.status, headers: answer.headers, body: answer.body });
    },
  );
  return {
    runner,
    logs,
    /** Moves the app's clock, and so the time the next attempt is stamped with. */
    advance(ms: number) {
      now += ms;
      world.setNow(now);
    },
  };
}

/** The visible toast with this text (Astryx also mirrors it into a hidden live region, which getByText would find too). */
const toastOf = (page: Page, text: string): Locator =>
  page.getByRole('region', { name: 'Notifications' }).getByText(text);
const bannerOf = (page: Page): Locator =>
  page.getByRole('status').filter({ hasText: 'Refresh failed.' });
const localSection = (page: Page): Locator =>
  page.getByRole('region', { name: 'On this machine', exact: true });
const rowOf = (page: Page, name: string): Locator =>
  localSection(page).getByRole('listitem').filter({ hasText: name });
const issues = (page: Page, n: number): Locator =>
  page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('link', { name: new RegExp(`^Sources & repos\\s*, ${n} issues?$`) });

const row = (world: World, id: string) =>
  world.db.prepare('SELECT * FROM source_state WHERE source_id = ?').get(id) as
    { consecutive_failures: number; last_attempt_result: string; status: string } | undefined;
const sessionCount = (world: World) =>
  (world.db.prepare('SELECT COUNT(*) AS n FROM session').get() as { n: number }).n;

test.describe('discovery and first failures without retained records', () => {
  test.use({ worldOptions: { scenario: 'account-only' } });

  test('reports availability before a refresh, then a real failure and successful retry', async ({
    page,
    world,
  }) => {
    world.db.exec("DELETE FROM source_state WHERE source_id IN ('codex', 'paseo')");
    recordDiscovery(world.db, { sourceId: 'codex', status: 'denied' });
    recordDiscovery(world.db, { sourceId: 'paseo', status: 'needspassword' });
    await mount(page, world, [scriptedAdapter('codex', [fails(), succeeds()])]);
    await page.goto(`${ORIGIN}/sources`);

    const codex = rowOf(page, 'Codex');
    const paseo = rowOf(page, 'Paseo');
    const failure = page.getByRole('status').filter({ hasText: 'Codex refresh failed' });
    await expect(codex.getByText('Access denied', { exact: true })).toBeVisible();
    await expect(paseo.getByText('Needs a password', { exact: true })).toBeVisible();
    await expect(paseo).not.toContainText('last snapshot');
    await expect(failure).toHaveCount(0);
    await expect(bannerOf(page)).toHaveCount(0);

    await codex.getByRole('button', { name: 'Retry' }).click();
    await expect(failure).toBeVisible();
    await expect(failure).not.toContainText('Previously collected');
    await expect(toastOf(page, 'Codex couldn’t be refreshed. Try again.')).toBeVisible();

    await failure.getByRole('button', { name: 'Retry' }).click();
    await expect(failure).toHaveCount(0);
    await expect(codex).toContainText('Latest attempt: Succeeded');

    recordDiscovery(world.db, { sourceId: 'paseo', status: 'notrunning' });
    await page.reload();
    await expect(paseo.getByText('Not running', { exact: true })).toBeVisible();
    await expect(paseo).not.toContainText('last snapshot');
  });
});

test.describe('the failed-refresh banner', () => {
  test.use({ worldOptions: { scenario: 'refresh-failed' } });

  test('says once what is stale, with View source and Retry, on every screen but Setup', async ({
    page,
    world,
  }) => {
    await mount(page, world, []);
    for (const path of ['/', '/sources', '/delivery']) {
      await page.goto(`${ORIGIN}${path}`);
      const banner = bannerOf(page);
      await expect(banner.getByText('Refresh failed.')).toBeVisible();
      await expect(banner.locator('p')).toHaveText(FAILED_BODY);
      await expect(banner.getByRole('link', { name: 'View source' })).toHaveAttribute(
        'href',
        '/sources',
      );
      await expect(banner.getByRole('button', { name: 'Retry' })).toBeEnabled();
      // The secondary action sits to the left of the primary one.
      const link = await banner.getByRole('link', { name: 'View source' }).boundingBox();
      const retry = await banner.getByRole('button', { name: 'Retry' }).boundingBox();
      expect(link!.x).toBeLessThan(retry!.x);
    }
    await page.goto(`${ORIGIN}/setup`);
    await expect(page.getByRole('heading', { level: 1, name: /^Setup/ })).toBeVisible();
    await expect(page.getByText('Refresh failed.')).toHaveCount(0);
  });

  test('its buttons are rounded rectangles, as designed (Astryx draws a pill unless told otherwise)', async ({
    page,
    world,
  }) => {
    await mount(page, world, []);
    await page.goto(`${ORIGIN}/sources`);
    const radius = (locator: Locator) =>
      locator.evaluate((element) => getComputedStyle(element).borderRadius);
    await expect(bannerOf(page)).toBeVisible();
    // DESIGN.md › Shape: `sm` is 8px, for buttons. The banner's Retry, its View source link and the page's Refresh all.
    expect(await radius(bannerOf(page).getByRole('button', { name: 'Retry' }))).toBe('8px');
    expect(await radius(bannerOf(page).getByRole('link', { name: 'View source' }))).toBe('8px');
    expect(await radius(page.getByRole('button', { name: 'Refresh all' }))).toBe('8px');
  });

  test('View source goes to Sources & repos', async ({ page, world }) => {
    await mount(page, world, []);
    await page.goto(`${ORIGIN}/`);
    await bannerOf(page).getByRole('link', { name: 'View source' }).click();
    await expect(page).toHaveURL(`${ORIGIN}/sources`);
    await expect(page.getByRole('heading', { level: 1, name: 'Sources & repos' })).toBeFocused();
  });

  test('Retry shows "Retrying…" for as long as the run lasts, then the banner and the issue count clear', async ({
    page,
    world,
  }) => {
    const held = gate();
    const codex = scriptedAdapter('codex', [holds(held, succeeds({ imported: 4 }))]);
    await mount(page, world, [codex]);
    await page.goto(`${ORIGIN}/`);
    await expect(issues(page, 3)).toBeVisible();

    const banner = bannerOf(page);
    await banner.getByRole('button', { name: 'Retry' }).click();
    await codex.called();

    const retrying = banner.getByRole('button', { name: 'Retrying…' });
    await expect(retrying).toBeDisabled();
    await expect(retrying).toHaveAttribute('aria-busy', 'true');
    await expect(retrying).toBeFocused();
    // Longer than a poll, longer than any stand-in delay: "Retrying…" is the run's state, not a timer's.
    await page.waitForTimeout(1500);
    await expect(retrying).toBeVisible();
    await expect(banner.locator('p')).toHaveText(FAILED_BODY);

    held.release();
    await expect(page.getByText('Refresh failed.')).toHaveCount(0);
    await expect(toastOf(page, TOAST.recovered)).toBeVisible();
    await expect(issues(page, 2)).toBeVisible();
    expect(row(world, 'codex')).toMatchObject({
      consecutive_failures: 0,
      last_attempt_result: 'succeeded',
      status: 'ok',
    });
  });

  test('a Retry that fails again keeps the banner and the cached data, and says "failed again"', async ({
    page,
    world,
  }) => {
    const codex = scriptedAdapter('codex', [fails()]);
    const t = await mount(page, world, [codex]);
    await page.goto(`${ORIGIN}/`);
    const before = sessionCount(world);
    t.advance(10 * 60_000);

    const banner = bannerOf(page);
    await expect(banner.locator('p')).toHaveText(FAILED_BODY);
    await banner.getByRole('button', { name: 'Retry' }).click();

    await expect(toastOf(page, TOAST.failedAgain)).toBeVisible();
    await expect(banner.locator('p')).toHaveText(FAILED_AGAIN_BODY);
    // Retry is offered again, not stuck busy; the three issues are all still there.
    const retry = banner.getByRole('button', { name: 'Retry' });
    await expect(retry).toBeEnabled();
    await expect(retry).not.toHaveAttribute('aria-busy', 'true');
    await expect(issues(page, 3)).toBeVisible();
    expect(row(world, 'codex')).toMatchObject({
      consecutive_failures: 2,
      last_attempt_result: 'failed',
    });
    expect(sessionCount(world)).toBe(before);
    expect(t.logs).toEqual([]);
  });

  test('Retry attaches to a run that is already going instead of starting a second one', async ({
    page,
    world,
  }) => {
    const held = gate();
    const codex = scriptedAdapter('codex', [holds(held, succeeds({ imported: 4 }))]);
    const t = await mount(page, world, [codex]);
    // The 15-minute timer (or another tab) started a run before Retry was pressed.
    expect(t.runner.start({ trigger: 'scheduler', sources: ['codex'] }).started).toBe(true);
    await codex.called();

    await page.goto(`${ORIGIN}/`);
    await bannerOf(page).getByRole('button', { name: 'Retry' }).click();
    await expect(bannerOf(page).getByRole('button', { name: 'Retrying…' })).toBeDisabled();

    held.release();
    await expect(page.getByText('Refresh failed.')).toHaveCount(0);
    await expect(toastOf(page, TOAST.recovered)).toBeVisible();
    expect(codex.calls).toBe(1);
  });

  test('leaving the page mid-Retry changes nothing: the banner keeps following, and the run still ends with its toast', async ({
    page,
    world,
  }) => {
    const held = gate();
    const codex = scriptedAdapter('codex', [holds(held, succeeds({ imported: 4 }))]);
    await mount(page, world, [codex]);
    await page.goto(`${ORIGIN}/sources`);
    await rowOf(page, 'Codex').getByRole('button', { name: 'Retry' }).click();
    await codex.called();

    // The row that pressed Retry goes away with its page; the run does not.
    await page
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('link', { name: 'Delivery' })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Delivery' })).toBeVisible();
    await expect(bannerOf(page).getByRole('button', { name: 'Retrying…' })).toBeDisabled();

    held.release();
    await expect(page.getByText('Refresh failed.')).toHaveCount(0);
    await expect(toastOf(page, TOAST.recovered)).toBeVisible();
    expect(codex.calls).toBe(1);
  });

  test('a request that never gets through says so, and Retry is offered again', async ({
    page,
    world,
  }) => {
    await mount(page, world, []);
    await page.route(
      (url) => url.origin === ORIGIN && url.pathname === '/api/refresh',
      (route) =>
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'internal',
              message: 'Something went wrong on this computer. Try again.',
              retryable: true,
            },
          }),
        }),
    );
    await page.goto(`${ORIGIN}/`);
    await bannerOf(page).getByRole('button', { name: 'Retry' }).click();
    await expect(
      toastOf(page, 'Couldn’t refresh. Something went wrong on this computer. Try again.'),
    ).toBeVisible();
    await expect(bannerOf(page).getByRole('button', { name: 'Retry' })).toBeEnabled();
    await expect(bannerOf(page).locator('p')).toHaveText(FAILED_BODY);
  });

  test('the Sources row says how Codex failed, with the same attempt line as the banner', async ({
    page,
    world,
  }) => {
    await mount(page, world, []);
    await page.goto(`${ORIGIN}/sources`);
    const codex = rowOf(page, 'Codex');
    await expect(codex.getByText('Refresh failed')).toBeVisible();
    await expect(codex).toContainText(
      'Last successful refresh: Nov 3, 6:12 PM · Latest attempt: Failed today, 9:40 AM',
    );
    await expect(codex).toContainText(
      'Couldn’t read 2 new session files (unrecognized format). Already-imported history is unaffected.',
    );
    // The one prominent action on a failed row is Retry.
    await expect(codex.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(rowOf(page, 'Claude Code').getByText('Found', { exact: true })).toBeVisible();
  });

  test('Retry in the banner and the Retry on the Sources row are one run: both show it, both end together', async ({
    page,
    world,
  }) => {
    const held = gate();
    const codex = scriptedAdapter('codex', [holds(held, succeeds({ imported: 4 }))]);
    await mount(page, world, [codex]);
    await page.goto(`${ORIGIN}/sources`);

    const codexRow = rowOf(page, 'Codex');
    await expect(codexRow.getByText('Refresh failed')).toBeVisible();
    await codexRow.getByRole('button', { name: 'Retry' }).click();
    await codex.called();

    await expect(bannerOf(page).getByRole('button', { name: 'Retrying…' })).toBeDisabled();
    await expect(codexRow.getByText('Refreshing…')).toBeVisible();
    // The row's own button says it too (G4_8). `exact` matters: "Retry" is also a substring of "Retrying…".
    const rowRetry = codexRow.getByRole('button', { name: 'Retrying…', exact: true });
    await expect(rowRetry).toHaveAttribute('aria-busy', 'true');
    await expect(rowRetry).toBeDisabled();
    await expect(codexRow.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
    // Nothing else can start while this run goes: the other buttons say so instead of doing nothing.
    const waiting = page.getByRole('button', { name: 'Refreshing…' });
    await expect(waiting).toHaveCount(2); // the page's Refresh all and the app bar's
    for (const button of await waiting.all()) await expect(button).toBeDisabled();

    held.release();
    await expect(page.getByText('Refresh failed.')).toHaveCount(0);
    await expect(codexRow.getByText('Found', { exact: true })).toBeVisible();
    await expect(codexRow.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
    await expect(codexRow.getByRole('button', { name: 'Retrying…' })).toHaveCount(0);
    await expect(toastOf(page, TOAST.recovered)).toBeVisible();
  });

  test('a run started from the banner’s Retry puts “Retrying…” on the source row as well, and both go back when it ends', async ({
    page,
    world,
  }) => {
    const held = gate();
    const codex = scriptedAdapter('codex', [holds(held, succeeds({ imported: 4 }))]);
    await mount(page, world, [codex]);
    await page.goto(`${ORIGIN}/sources`);

    const codexRow = rowOf(page, 'Codex');
    await expect(codexRow.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await bannerOf(page).getByRole('button', { name: 'Retry', exact: true }).click();
    await codex.called();

    for (const scope of [bannerOf(page), codexRow]) {
      const button = scope.getByRole('button', { name: 'Retrying…', exact: true });
      await expect(button).toHaveAttribute('aria-busy', 'true');
      await expect(button).toHaveAttribute('aria-disabled', 'true');
    }
    // The row's button stays a real, focusable button while the run goes (aria-disabled, not the disabled attribute).
    await expect(
      codexRow.getByRole('button', { name: 'Retrying…', exact: true }),
    ).not.toHaveAttribute('disabled', /.*/);

    held.release();
    await expect(toastOf(page, TOAST.recovered)).toBeVisible();
    await expect(page.getByText('Refresh failed.')).toHaveCount(0);
    await expect(codexRow.getByRole('button', { name: 'Retrying…' })).toHaveCount(0);
    await expect(codexRow.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  });

  test('Refresh all puts “Retrying…” on a failed source’s row too, and a second failure goes back to “Retry”', async ({
    page,
    world,
  }) => {
    const held = gate();
    const codex = scriptedAdapter('codex', [holds(held, fails())]);
    await mount(page, world, [codex, scriptedAdapter('claude', [succeeds()])]);
    await page.goto(`${ORIGIN}/sources`);

    const codexRow = rowOf(page, 'Codex');
    await page.getByRole('main').getByRole('button', { name: 'Refresh all', exact: true }).click();
    await codex.called();
    await expect(codexRow.getByRole('button', { name: 'Retrying…', exact: true })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    // Rows whose action is Refresh keep their label: their status tag says "Refreshing…" instead.
    await expect(
      rowOf(page, 'Claude Code').getByRole('button', { name: 'Refresh', exact: true }),
    ).toBeVisible();

    held.release();
    await expect(codexRow.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
    await expect(codexRow.getByRole('button', { name: 'Retrying…' })).toHaveCount(0);
  });
});

test.describe('Sources & repos: on this machine', () => {
  test('lists each local source with what it found and when it last worked', async ({
    page,
    world,
  }) => {
    await mount(page, world, []);
    await page.goto(`${ORIGIN}/sources`);
    await expect(page.getByRole('heading', { level: 1, name: 'Sources & repos' })).toBeVisible();
    await expect(
      page.getByText('Setup and upkeep. Everyday review lives in Overview.'),
    ).toBeVisible();
    await expect(
      localSection(page).getByRole('heading', { level: 2, name: 'On this machine', exact: true }),
    ).toBeVisible();
    await expect(localSection(page).getByRole('listitem')).toHaveCount(3);

    const sessions = (provider: string) =>
      (
        world.db
          .prepare(
            'SELECT COUNT(DISTINCT s.id) AS n FROM session s JOIN usage_event ue ON ue.session_id = s.id WHERE s.provider = ?',
          )
          .get(provider) as { n: number }
      ).n;

    const codex = rowOf(page, 'Codex');
    await expect(codex.getByText('Found', { exact: true })).toBeVisible();
    await expect(codex).toContainText('Location ~/.codex/sessions · found automatically');
    await expect(codex).toContainText(
      new RegExp(`History from [A-Z][a-z]{2} \\d{1,2}, \\d{4} · ${sessions('codex')} sessions`),
    );
    await expect(codex).toContainText(
      'Last successful refresh: Today, 9:42 AM · Latest attempt: Succeeded',
    );
    await expect(codex.getByRole('button', { name: 'Refresh' })).toBeEnabled();

    const claude = rowOf(page, 'Claude Code');
    await expect(claude).toContainText('Location ~/.claude/projects · found automatically');
    await expect(claude).toContainText(`${sessions('claude')} sessions`);
    // The 30-day retention note (G4_9) is the server's, shown on Claude Code's row only.
    await expect(claude).toContainText(
      'Claude Code keeps transcripts for 30 days unless you change cleanupPeriodDays.',
    );
    await expect(codex).not.toContainText('keeps transcripts');

    const paseo = rowOf(page, 'Paseo');
    await expect(paseo.getByText('Partial')).toBeVisible();
    await expect(paseo).toContainText('Latest attempt: Succeeded with problems');
    await expect(paseo).toContainText('3 agent records couldn’t be read');
  });

  test('the first failure says "failed", the next says "failed again", on the banner and on the row', async ({
    page,
    world,
  }) => {
    const codex = scriptedAdapter('codex', [fails(), fails()]);
    const t = await mount(page, world, [codex]);
    await page.goto(`${ORIGIN}/sources`);
    await expect(page.getByText('Refresh failed.')).toHaveCount(0);

    // A healthy source is refreshed and breaks for the first time.
    await rowOf(page, 'Codex').getByRole('button', { name: 'Refresh' }).click();
    await expect(toastOf(page, TOAST.failedFirst)).toBeVisible();
    await expect(bannerOf(page).locator('p')).toHaveText(
      'Codex refresh failed today, 9:42 AM. Last successful refresh: Today, 9:42 AM. Codex usage since then isn’t collected yet. Previously collected records are kept.',
    );
    await expect(rowOf(page, 'Codex')).toContainText('Latest attempt: Failed today, 9:42 AM');
    await expect(bannerOf(page).locator('p')).not.toContainText('again');

    // Retry, and it fails again at 9:52.
    t.advance(10 * 60_000);
    await bannerOf(page).getByRole('button', { name: 'Retry' }).click();
    await expect(toastOf(page, TOAST.failedAgain)).toBeVisible();
    await expect(bannerOf(page).locator('p')).toContainText(
      'Codex refresh failed again today, 9:52 AM. Last successful refresh: Today, 9:42 AM.',
    );
    await expect(rowOf(page, 'Codex')).toContainText('Latest attempt: Failed again today, 9:52 AM');
  });

  test('Refresh all follows the whole run, then says nothing was duplicated', async ({
    page,
    world,
  }) => {
    const held = gate();
    const codex = scriptedAdapter('codex', [holds(held, succeeds())]);
    await mount(page, world, [codex, scriptedAdapter('claude', [succeeds()])]);
    await page.goto(`${ORIGIN}/sources`);

    await page.getByRole('button', { name: 'Refresh all' }).click();
    await codex.called();
    // Every refresh button says so while a run goes: the page's own and the app bar's.
    const busy = page.getByRole('main').getByRole('button', { name: 'Refreshing…' });
    await expect(busy).toBeDisabled();
    await expect(busy).toHaveAttribute('aria-busy', 'true');
    await expect(
      page.getByRole('banner').getByRole('button', { name: 'Refreshing…' }),
    ).toBeDisabled();
    await expect(rowOf(page, 'Codex').getByText('Refreshing…')).toBeVisible();
    await expect(rowOf(page, 'Claude Code').getByText('Refreshing…')).toBeVisible();

    held.release();
    await expect(toastOf(page, 'Refreshed all sources · no duplicates.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh all' })).toBeEnabled();
    await expect(rowOf(page, 'Codex').getByText('Refreshing…')).toHaveCount(0);
  });

  test('the app bar’s Refresh starts a run from any page, and says so while it goes', async ({
    page,
    world,
  }) => {
    const held = gate();
    const codex = scriptedAdapter('codex', [holds(held, succeeds())]);
    await mount(page, world, [codex, scriptedAdapter('claude', [succeeds()])]);
    await page.goto(`${ORIGIN}/usage`);
    await expect(page.getByRole('heading', { level: 1, name: 'Usage' })).toBeVisible();

    const bar = page.getByRole('banner');
    await bar.getByRole('button', { name: 'Refresh', exact: true }).click();
    await codex.called();
    const busy = bar.getByRole('button', { name: 'Refreshing…' });
    await expect(busy).toHaveAttribute('aria-busy', 'true');
    await expect(busy).toBeDisabled();

    held.release();
    await expect(toastOf(page, 'Refreshed all sources · no duplicates.')).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  });

  test('says in words when Paseo is not running or asks for a password, and that its last snapshot still names the tree', async ({
    page,
    world,
  }) => {
    const setPaseo = (status: 'notrunning' | 'needspassword') =>
      world.db
        .prepare(
          "UPDATE source_state SET status = ?, error_detail = NULL, unreadable_count = 0 WHERE source_id = 'paseo'",
        )
        .run(status);
    await mount(page, world, []);

    setPaseo('notrunning');
    await page.goto(`${ORIGIN}/sources`);
    const paseo = rowOf(page, 'Paseo');
    await expect(paseo.getByText('Not running', { exact: true })).toBeVisible();
    await expect(paseo).toContainText('Names and parents come from its last snapshot.');
    // not an error: no failure is counted, and the button is the quiet "Check again"
    await expect(paseo.getByRole('button', { name: 'Check again' })).toBeVisible();

    setPaseo('needspassword');
    await page.reload();
    const asking = rowOf(page, 'Paseo');
    await expect(asking.getByText('Needs a password', { exact: true })).toBeVisible();
    await expect(asking).toContainText(
      'Paseo is asking for a password, which this dashboard doesn’t support. Names and parents come from its last snapshot.',
    );
    // the dashboard never offers a place to type one
    await expect(page.getByLabel(/password/i)).toHaveCount(0);
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
  });

  test.describe('on a machine with no agent records', () => {
    test.use({ worldOptions: { scenario: 'account-only' } });

    test('says nothing was found, and Check again changes nothing when there is still nothing', async ({
      page,
      world,
    }) => {
      await mount(page, world, [
        scriptedAdapter('codex', [skips('Nothing in its usual locations.')]),
      ]);
      await page.goto(`${ORIGIN}/sources`);
      const codex = rowOf(page, 'Codex');
      await expect(codex.getByText('Not found')).toBeVisible();
      await expect(codex).toContainText(
        'Nothing in its usual locations on this machine. If you use it here, run it once, then check again.',
      );
      const before = row(world, 'codex');

      await codex.getByRole('button', { name: 'Check again' }).click();
      await expect(toastOf(page, 'Codex: Nothing in its usual locations.')).toBeVisible();
      // A skipped source records nothing: the counter and the last attempt stay as they were.
      expect(row(world, 'codex')).toEqual(before);
      await expect(codex.getByRole('button', { name: 'Check again' })).toBeEnabled();
    });
  });

  test.describe('before anything has been checked', () => {
    test.use({ worldOptions: { scenario: 'empty' } });

    test('says so instead of showing a state nobody observed', async ({ page, world }) => {
      await mount(page, world, []);
      await page.goto(`${ORIGIN}/sources`);
      await expect(
        page.getByText(
          'Nothing has been checked yet. Use Refresh all to look for records on this machine.',
        ),
      ).toBeVisible();
      await expect(localSection(page).getByRole('listitem')).toHaveCount(0);
    });
  });
});

test.describe('recovery on a phone', () => {
  test.use({ worldOptions: { scenario: 'refresh-failed' } });

  test('the banner puts its actions on their own row, at touch size, without side scrolling', async ({
    page,
    world,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await mount(page, world, []);
    await page.goto(`${ORIGIN}/`);
    const banner = bannerOf(page);
    await expect(banner.locator('p')).toHaveText(FAILED_BODY);
    const text = await banner.locator('p').boundingBox();
    const view = await banner.getByRole('link', { name: 'View source' }).boundingBox();
    const retry = await banner.getByRole('button', { name: 'Retry' }).boundingBox();
    expect(view!.y).toBeGreaterThanOrEqual(text!.y + text!.height);
    expect(retry!.y).toBeGreaterThanOrEqual(text!.y + text!.height);
    expect(retry!.height).toBeGreaterThanOrEqual(44);
    expect(view!.height).toBeGreaterThanOrEqual(44);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('axe', () => {
  test.use({ worldOptions: { scenario: 'refresh-failed' } });

  for (const width of [1280, 390]) {
    test(
      `the failed banner and the Sources page, idle and while retrying, have no violations at ${width}px`,
      { tag: '@a11y' },
      async ({ page, world }) => {
        const held = gate();
        const codex = scriptedAdapter('codex', [holds(held, succeeds({ imported: 4 }))]);
        await page.setViewportSize({ width, height: 800 });
        await mount(page, world, [codex]);
        await page.goto(`${ORIGIN}/sources`);
        await expect(bannerOf(page).getByRole('button', { name: 'Retry' })).toBeVisible();
        await expect(rowOf(page, 'Codex')).toBeVisible();

        const scan = async (when: string) => {
          const { violations } = await new AxeBuilder({ page }).analyze();
          const summary = violations.map(
            (v) =>
              `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).join('\n    ')}`,
          );
          expect(summary, `axe found ${violations.length} violation(s) ${when}`).toEqual([]);
        };
        await scan('while idle');

        await bannerOf(page).getByRole('button', { name: 'Retry' }).click();
        await codex.called();
        await expect(bannerOf(page).getByRole('button', { name: 'Retrying…' })).toBeVisible();
        await scan('while retrying');
        held.release();
        await expect(page.getByText('Refresh failed.')).toHaveCount(0);
      },
    );
  }
});
