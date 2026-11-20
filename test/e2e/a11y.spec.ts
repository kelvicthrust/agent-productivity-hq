import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { Hono } from 'hono';
import { createRunner } from '../../src/server/collectors/runner.ts';
import { correlation, errorHandler, type HttpEnv } from '../../src/server/http/errors.ts';
import { csrfGuard, hostGuard, securityHeaders } from '../../src/server/http/guards.ts';
import { refreshRoutes } from '../../src/server/http/routes/refresh.ts';
import { setupRoutes } from '../../src/server/http/routes/setup.ts';
import { sourcesRoutes } from '../../src/server/http/routes/sources.ts';
import { createLogger } from '../../src/server/lib/logger.ts';
import { createChatgptAccounts } from '../../src/server/services/accounts.ts';
import { createGithubAccounts } from '../../src/server/services/accounts-github.ts';
import { loadScenario, scriptedAppServer } from '../collectors/chatgpt/scripted.ts';
import { createScriptedGithub } from '../fixtures/github/world.ts';
import { scriptedAdapter, succeeds } from '../fixtures/scripted-adapters/scripted.ts';
import { FIXED_NOW, FIXED_TIMEZONE } from '../fixtures/seed.ts';
import { expect, test } from './fixtures';
import { ORIGIN } from './helpers/virtualOrigin';
import { WORLD_PORT, answerApi, openWorld, type World } from './helpers/world';

// Accessibility, in the real build in a real browser over the real API and the seeded world (TECH › Accessibility; P-32):
//
//   1. axe on every route at 1280, 390 and 320px, with no rule disabled and no tag filter, and the page never scrolls sideways;
//   2. axe on each of Setup's three steps at the same widths (first launch, gh signed out, so step 2 is at its widest);
//   3. keyboard-only journeys J1 to J5 (TECH › Journey traces): nothing is clicked, nothing is focused by script. Each journey starts
//      at the top of a freshly loaded page and reaches every control with Tab, Shift+Tab, the arrow keys, Enter, Space, F6 and
//      Escape, the way a keyboard user does. Every stop on the way is visible, and a dialog keeps focus inside until Escape.
//
// Two gaps the journeys found are written as their own tests with `test.fail` (see "known gap"): they pass while the gap exists and
// turn red the day it is fixed, which is the cue to delete the annotation. States (loading, empty, failed, drawer, recovery pages…)
// are in states.spec.ts. Tagged @a11y; the width runs are @responsive too.

const WIDTHS = [1280, 390, 320] as const;
const ROUTES: Array<[path: string, name: string]> = [
  ['/', 'Overview'],
  ['/trends', 'Trends'],
  ['/delivery', 'Delivery'],
  ['/usage', 'Usage'],
  ['/hq', 'HQ'],
  ['/sources', 'Sources & repos'],
  ['/setup', 'Setup'],
  ['/no/such/page', 'Page not found'],
];

/** axe's own default rule set, nothing disabled; one line per finding. */
async function axeFindings(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
  );
}

/** The page does not scroll sideways: nothing ends past the window. */
async function fitsWidth(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
}

// ---- 1. every route ------------------------------------------------------------------------------------------------------

for (const width of WIDTHS) {
  for (const [path, name] of ROUTES) {
    test(
      `${name} at ${width}px: no axe violations, no sideways scroll`,
      { tag: ['@a11y', '@responsive'] },
      async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await openWorld(page);
        await page.goto(`${ORIGIN}${path}`);
        await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
        await page.waitForLoadState('networkidle');
        expect(await axeFindings(page)).toEqual([]);
        expect(await fitsWidth(page), 'the page scrolls sideways').toBe(true);
      },
    );
  }
}

// ---- Setup, mounted over a first-launch world ------------------------------------------------------------------------------
// The setup routes are the real ones, over the world's database; discovery looks at a temporary home with the invented fixture
// folders (world.homes), Paseo is absent and `codex` is on the PATH by a scripted answer. Nothing reads this computer. Registered
// after the world's own routes, so these answer first (the route registered last wins), as setup.spec.ts does.

async function mountSetup(page: Page, world: World): Promise<void> {
  const home = world.homes.make();
  const logger = createLogger({ sink: () => undefined, level: 'warn', now: () => FIXED_NOW });
  const runner = createRunner({
    db: world.db,
    now: () => FIXED_NOW,
    logger,
    adapters: [scriptedAdapter('codex', [succeeds()]), scriptedAdapter('claude', [succeeds()])],
  });
  const scripted = createScriptedGithub(world.db, { now: () => FIXED_NOW, signedIn: false });
  const github = createGithubAccounts({
    db: world.db,
    ...scripted.boot,
    now: () => FIXED_NOW,
    sleep: () => Promise.resolve(),
  });
  const chatgpt = createChatgptAccounts({
    db: world.db,
    launch: scriptedAppServer(loadScenario('chatgpt-with-threads')).launch,
    now: () => FIXED_NOW,
    timezone: FIXED_TIMEZONE,
  });
  const api = new Hono<HttpEnv>();
  api.use('*', correlation());
  api.use('*', securityHeaders());
  api.use('*', hostGuard(WORLD_PORT, logger));
  api.use('*', csrfGuard(logger));
  api.onError(errorHandler(logger));
  api.route(
    '/',
    setupRoutes({
      db: world.db,
      runner,
      now: () => FIXED_NOW,
      timezone: FIXED_TIMEZONE,
      local: { env: home.env, home: home.home },
      codexOnPath: () => true,
      github,
      chatgpt,
      logger,
    }),
  );
  await routeTo(page, api, /^\/api\/setup\//);
}

/** Answers the page's requests for these API paths from `api` (registered after the world's routes, so it answers first). */
async function routeTo(page: Page, api: Hono<HttpEnv>, paths: RegExp): Promise<void> {
  await page.route(
    (url) => url.origin === ORIGIN && paths.test(url.pathname),
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
}

const button = (page: Page, name: string): Locator =>
  page.getByRole('button', { name, exact: true });

/** First launch: the shell sends the first load to /setup, and step 1 has finished looking. */
async function openSetup(page: Page, world: World): Promise<void> {
  await mountSetup(page, world);
  await page.clock.setFixedTime(new Date(FIXED_NOW));
  await page.goto(`${ORIGIN}/`);
  await expect(page).toHaveURL(`${ORIGIN}/setup`);
  await expect(page.getByRole('heading', { level: 1, name: /^Setup/ })).toBeVisible();
  await expect(page.getByText('Looking…')).toHaveCount(0);
  await expect(button(page, 'Continue')).not.toHaveAttribute('aria-disabled', 'true');
}

// ---- 2. Setup's three steps ------------------------------------------------------------------------------------------------

test.describe('Setup’s three steps', () => {
  test.use({ worldOptions: { firstLaunch: true, ghSignedIn: false } });

  for (const width of WIDTHS) {
    for (const step of [1, 2, 3] as const) {
      test(
        `step ${step} at ${width}px: no axe violations, no sideways scroll`,
        { tag: ['@a11y', '@responsive'] },
        async ({ page, world }) => {
          await page.setViewportSize({ width, height: 900 });
          await openSetup(page, world);
          if (step > 1) await button(page, 'Continue').click();
          if (step > 2) await button(page, 'Continue without GitHub').click();
          await page.evaluate(async () => {
            await Promise.all(
              document.getAnimations().map((a) => a.finished.catch(() => undefined)),
            );
          });
          expect(await axeFindings(page)).toEqual([]);
          expect(await fitsWidth(page), 'the page scrolls sideways').toBe(true);
        },
      );
    }
  }
});

// ---- the keyboard ------------------------------------------------------------------------------------------------------------

/** What a screen reader would call the focused element: its aria-label, else its labelled-by text, else its text or value. */
async function focusName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return '';
    const by = el.getAttribute('aria-labelledby');
    const labelled = by
      ? by
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ')
      : '';
    const text = (
      el.getAttribute('aria-label') ||
      labelled ||
      (el as HTMLElement).innerText ||
      el.textContent ||
      (el as HTMLInputElement).value ||
      el.getAttribute('title') ||
      ''
    ).replace(/\s+/g, ' ');
    return text.trim();
  });
}

/** The focused element is drawn: it has a size and is inside the window (a keyboard user can see where they are). */
async function focusIsSeen(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return false;
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.bottom > 0 &&
      r.right > 0 &&
      r.top < window.innerHeight &&
      r.left < window.innerWidth &&
      style.visibility !== 'hidden'
    );
  });
}

/**
 * Presses Tab until the focused element's name matches, as a keyboard user would. Every stop on the way must be visible. Fails with
 * the names it passed, so a control that cannot be reached by keyboard says so.
 */
async function tabTo(page: Page, name: RegExp, limit = 60): Promise<string> {
  const passed: string[] = [];
  for (let press = 0; press < limit; press += 1) {
    await page.keyboard.press('Tab');
    const label = await focusName(page);
    passed.push(label);
    if (label === '' && (await page.evaluate(() => document.activeElement === document.body)))
      throw new Error(
        `Tab left the page before reaching ${name}. It stopped on: ${passed.join(' › ')}`,
      );
    expect(await focusIsSeen(page), `focus is not visible on "${label}"`).toBe(true);
    if (name.test(label)) return label;
  }
  throw new Error(
    `Tab never reached ${name} in ${limit} presses. It stopped on: ${passed.join(' › ')}`,
  );
}

/** Shift+Tab version of tabTo, for a control above the focus. */
async function shiftTabTo(page: Page, name: RegExp, limit = 30): Promise<string> {
  for (let press = 0; press < limit; press += 1) {
    await page.keyboard.press('Shift+Tab');
    const label = await focusName(page);
    if (name.test(label)) return label;
  }
  throw new Error(`Shift+Tab never reached ${name} in ${limit} presses.`);
}

/** A page loaded fresh, with nothing focused: the first Tab goes to the skip link. */
async function startOfPage(page: Page, path: string): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${ORIGIN}${path}`);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Setup from the top of the page to the end of Finish, with Tab, Shift+Tab and Enter alone. */
async function finishSetupByKeyboard(page: Page, world: World): Promise<void> {
  await openSetup(page, world);
  await tabTo(page, /^Continue$/);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Connect accounts' })).toBeVisible();
  await expect(button(page, 'Continue without GitHub')).toBeVisible();
  await tabTo(page, /^Continue without GitHub$/);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Choose repositories to track' })).toBeVisible();
  // Back is a button before Finish: Shift+Tab reaches it, Tab from it comes back to Finish.
  await tabTo(page, /^Finish setup$/);
  await shiftTabTo(page, /^Back to accounts$/);
  await tabTo(page, /^Finish setup$/);
  await page.keyboard.press('Enter');
}

/** The real refresh and sources routes over the world's database, with a Codex source that now succeeds (recovery.spec.ts does the same). */
async function mountRefresh(page: Page, world: World): Promise<void> {
  const logger = createLogger({ sink: () => undefined, level: 'warn', now: () => FIXED_NOW });
  const runner = createRunner({
    db: world.db,
    now: () => FIXED_NOW,
    logger,
    adapters: [scriptedAdapter('codex', [succeeds({ imported: 4 })])],
  });
  const api = new Hono<HttpEnv>();
  api.use('*', correlation());
  api.onError(errorHandler(logger));
  api.route('/', sourcesRoutes({ db: world.db, timezone: FIXED_TIMEZONE }));
  api.route('/', refreshRoutes({ db: world.db, runner }));
  await routeTo(page, api, /^\/api\/(sources|refresh)(\/|$)/);
}

const banner = (page: Page): Locator =>
  page.getByRole('status').filter({ hasText: 'Refresh failed.' });

/** The failed-refresh banner reached from the top of the page, and Retry pressed with Enter. */
async function retryByKeyboard(page: Page, world: World): Promise<void> {
  await mountRefresh(page, world);
  await startOfPage(page, '/');
  await expect(banner(page)).toBeVisible();
  await tabTo(page, /^View source$/);
  await tabTo(page, /^Retry$/);
  await page.keyboard.press('Enter');
}

test.describe('keyboard only', () => {
  test(
    'the skip link is the first stop and moves focus into the page',
    { tag: '@a11y' },
    async ({ page }) => {
      await openWorld(page);
      await startOfPage(page, '/delivery');
      await page.keyboard.press('Tab');
      expect(await focusName(page)).toBe('Skip to content');
      await page.keyboard.press('Enter');
      const inMain = await page.evaluate(
        () => !!document.activeElement?.closest('main, [id="main"]'),
      );
      expect(inMain, 'focus is inside the main landmark after the skip link').toBe(true);
    },
  );

  test(
    'J2 Review a period: change the period, read a bucket in the drawer, open it in Delivery',
    { tag: '@a11y' },
    async ({ page }) => {
      await openWorld(page);
      await startOfPage(page, '/?author=all');
      // The period radio group: Tab enters it at the selected radio, the arrow keys move and select.
      await tabTo(page, /^This week$/);
      const before = page.url();
      await page.keyboard.press('ArrowRight');
      await expect(page.getByRole('radio', { name: 'This week' })).not.toBeChecked();
      await expect(page.getByRole('radio', { checked: true }).first()).toBeFocused();
      await expect.poll(() => page.url()).not.toBe(before);
      // The chart is one tab stop with a keyboard cursor; Enter on a bucket opens its records.
      await tabTo(page, /^Delivery and usage over time|^Merged PRs and recorded local tokens/);
      await page.keyboard.press('Home');
      await page.keyboard.press('Enter');
      const drawer = page.getByRole('dialog');
      await expect(drawer).toBeVisible();
      await expect(drawer.getByRole('heading', { level: 2 })).toBeFocused();
      await expect(drawer.getByRole('button', { name: 'Close' })).toBeInViewport();
      // Focus stays inside the dialog however long Tab is pressed.
      for (let press = 0; press < 25; press += 1) {
        await page.keyboard.press('Tab');
        expect(
          await page.evaluate(() => !!document.activeElement?.closest('dialog')),
          `Tab ${press + 1} left the drawer`,
        ).toBe(true);
      }
      // Escape closes it with focus back on the chart, then Enter again and on to Delivery by its link.
      await page.keyboard.press('Escape');
      await expect(drawer).toBeHidden();
      await expect
        .poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-bucket-index]')))
        .toBe(true);
      await page.keyboard.press('Enter');
      await expect(drawer).toBeVisible();
      await expect(drawer.getByRole('button', { name: 'Close' })).toBeInViewport();
      await tabTo(page, /^Open in Delivery/);
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/delivery\?/);
      await expect(page.getByRole('heading', { level: 1, name: 'Delivery' })).toBeFocused();
    },
  );

  test(
    'J3 Understand multi-agent work: open a repository, then a root’s children, and close them',
    { tag: '@a11y' },
    async ({ page }) => {
      await openWorld(page);
      await startOfPage(page, '/usage');
      await tabTo(page, /^Expand kelvin\/atlas-api$/);
      await page.keyboard.press('Enter');
      const open = page.getByRole('button', { name: 'Collapse kelvin/atlas-api', exact: true });
      await expect(open).toHaveAttribute('aria-expanded', 'true');
      await expect(open).toBeFocused();
      // A root that has children: Tab to its toggle, open with Enter, close with Space; focus stays on the same button.
      await expect(
        page.getByRole('button', { name: /^Show \d+ child agents of / }).first(),
      ).toBeVisible();
      await tabTo(page, /^Show \d+ child agents of /);
      await page.keyboard.press('Enter');
      await expect(
        page.getByRole('button', { name: /^Hide \d+ child agents of / }),
      ).toHaveAttribute('aria-expanded', 'true');
      expect(await focusName(page)).toMatch(/^Hide \d+ child agents of /);
      await page.keyboard.press('Space');
      expect(await focusName(page)).toMatch(/^Show \d+ child agents of /);
      // The repository closes again from the keyboard.
      await shiftTabTo(page, /^Collapse kelvin\/atlas-api$/);
      await page.keyboard.press('Enter');
      await expect(
        page.getByRole('button', { name: 'Expand kelvin/atlas-api', exact: true }),
      ).toBeFocused();
    },
  );

  test(
    'J4 Trace a merge: open a PR, confirm a suggested link, Undo it from its toast',
    { tag: '@a11y' },
    async ({ page }) => {
      const world = await openWorld(page);
      // PR #315 has one evidence link and one suggestion (the seeded week); the page lists it by its title.
      const listed = await answerApi(world.app, { method: 'GET', path: '/api/prs', headers: {} });
      const items = (
        JSON.parse(listed.body.toString('utf8')) as { items: { number: number; title: string }[] }
      ).items;
      const pr = items.find((item) => item.number === 315)!;
      await startOfPage(page, '/delivery');
      await tabTo(page, new RegExp(`^Show link evidence for ${escapeRegExp(pr.title)}`), 120);
      const toggle = page.locator('button[aria-expanded]:focus');
      await page.keyboard.press('Enter');
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('li[data-evidence-session]').first()).toBeVisible();
      await tabTo(page, /^Confirm link/, 40);
      await page.keyboard.press('Enter');
      await expect(
        page.getByText('Link confirmed and labeled Owner-confirmed.').first(),
      ).toBeVisible();
      await expect(toggle).toBeFocused();
      // F6 moves into the toast: Enter on Undo puts it back, and focus is on the toggle again.
      await page.keyboard.press('F6');
      expect(await focusName(page)).toBe('Undo');
      await page.keyboard.press('Enter');
      await expect(page.getByText('Link confirmed and labeled Owner-confirmed.')).toHaveCount(0);
      await expect(toggle).toBeFocused();
    },
  );
});

test.describe('keyboard only: first launch', () => {
  test.use({ worldOptions: { firstLaunch: true, ghSignedIn: false } });

  test(
    'J1 Set up coverage: the three steps with Continue, Back and Finish, then Overview',
    { tag: '@a11y' },
    async ({ page, world }) => {
      await finishSetupByKeyboard(page, world);
      await expect(page.getByRole('heading', { level: 1, name: /^Overview/ })).toBeVisible();
    },
  );

  // TECH › Accessibility asks for focus on the h1 on every route change. Finish swaps the Setup layout for the review shell, and the
  // route focus lives above both layouts (RootLayout), so this is a route change like any other.
  test(
    'after Finish, focus moves to the new page’s heading',
    { tag: '@a11y' },
    async ({ page, world }) => {
      await finishSetupByKeyboard(page, world);
      await expect(page.getByRole('heading', { level: 1, name: /^Overview/ })).toBeFocused({
        timeout: 3000,
      });
    },
  );
});

test.describe('keyboard only: a failed refresh', () => {
  test.use({ worldOptions: { scenario: 'refresh-failed' } });

  test(
    'J5 Recover from collection failure: Retry from the banner, then the toast, and the banner is gone',
    { tag: '@a11y' },
    async ({ page, world }) => {
      await retryByKeyboard(page, world);
      await expect(
        page.getByRole('region', { name: 'Notifications' }).getByText(/^Codex refreshed/),
      ).toBeVisible();
      await expect(banner(page)).toHaveCount(0);
    },
  );

  // Retry succeeds and the banner, with the button that had focus, leaves the page. Focus goes to the page's heading instead of
  // falling to <body>, where the next Tab would start from the top. The toast announces the result either way.
  test(
    'after a successful Retry, focus is on the page’s heading, not lost',
    { tag: '@a11y' },
    async ({ page, world }) => {
      await retryByKeyboard(page, world);
      await expect(banner(page)).toHaveCount(0);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeFocused({ timeout: 3000 });
    },
  );
});
