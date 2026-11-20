import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { Hono } from 'hono';
import { createRunner } from '../../src/server/collectors/runner.ts';
import { correlation, errorHandler, type HttpEnv } from '../../src/server/http/errors.ts';
import { csrfGuard, hostGuard, securityHeaders } from '../../src/server/http/guards.ts';
import { refreshRoutes } from '../../src/server/http/routes/refresh.ts';
import { setupRoutes } from '../../src/server/http/routes/setup.ts';
import { sourcesRoutes } from '../../src/server/http/routes/sources.ts';
import {
  alreadyRunningPage,
  databaseRecoveryPage,
  diskFullPage,
  type DatabaseRecoveryReason,
} from '../../src/server/http/recovery/index.ts';
import { createLogger } from '../../src/server/lib/logger.ts';
import { createChatgptAccounts } from '../../src/server/services/accounts.ts';
import { createGithubAccounts } from '../../src/server/services/accounts-github.ts';
import { loadScenario, scriptedAppServer } from '../collectors/chatgpt/scripted.ts';
import { createScriptedGithub } from '../fixtures/github/world.ts';
import { gate, holds, scriptedAdapter, succeeds } from '../fixtures/scripted-adapters/scripted.ts';
import { FIXED_NOW, FIXED_TIMEZONE } from '../fixtures/seed.ts';
import { expect, test } from './fixtures';
import { CAN_DENY, type SetupHomeOptions } from './helpers/homes';
import { ORIGIN } from './helpers/virtualOrigin';
import { WORLD_PORT, answerApi, openWorld, type World, type WorldOptions } from './helpers/world';

// Every state a screen can be in, not only the one a seeded week shows (TECH › Accessibility: "axe on every route and state"), in
// the real build in a real browser over the real API. Each test brings a screen to one state and scans it with axe (default rule set,
// nothing disabled) at 1280, 390 and 320px, and checks the page does not scroll sideways at any of them. The widths are looked at
// one after another in the same test, the state brought up again each time, so a layout that swaps with the width (table to list, drawer
// to bottom sheet) is scanned in its own form. Tagged @a11y @responsive.
//
// States: empty worlds (nothing tracked, account only, nothing at all), a failed refresh and its banner, Retry in flight, loading, a
// failed request, the records drawer, an opened PR with its link form and its toast, the whole Usage tree open, the GitHub App guide,
// Setup with nothing found and with a folder denied, the three recovery pages, and a PR title that is markup. The last tests check that
// the page asks for nothing from any other origin (TECH › Security: browser requests only to the app's own address).

const WIDTHS = [1280, 390, 320] as const;
const TAGS = { tag: ['@a11y', '@responsive'] };

interface State {
  /** The test's name. */
  name: string;
  world?: WorldOptions;
  path: string;
  /** Before the page loads: routes, data changes. May return a function to run after the world is over (a released gate). */
  prepare?: (page: Page, world: World) => Promise<void | (() => void)>;
  /** After the page loads: bring it to the state, and wait until it is there. */
  reach: (page: Page, world: World, widthIndex: number) => Promise<void>;
}

async function axeFindings(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
  );
}

const fitsWidth = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

/** Motion has finished: a sheet still sliding in, or a toast still rising, is not the state being looked at. */
const still = (page: Page): Promise<void> =>
  page.evaluate(async () => {
    // A skeleton's shimmer never ends, and it is part of the state: only motion that has an end is waited for.
    const finite = document
      .getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
  });

async function scan(page: Page, world: World, state: State): Promise<void> {
  const release = await state.prepare?.(page, world);
  try {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${ORIGIN}${state.path}`);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await state.reach(page, world, WIDTHS.indexOf(width));
      await still(page);
      expect(await axeFindings(page), `${state.name} at ${width}px`).toEqual([]);
      expect(await fitsWidth(page), `${state.name} scrolls sideways at ${width}px`).toBe(true);
    }
  } finally {
    release?.();
  }
}

const settled = (page: Page): Promise<void> => page.waitForLoadState('networkidle');

/** Answers these API paths from `api` instead of the world's own routes (registered later, so it answers first). */
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

const quiet = () => createLogger({ sink: () => undefined, level: 'warn', now: () => FIXED_NOW });

/** The real refresh and sources routes with a Codex source of the spec's choosing. */
async function mountRefresh(
  page: Page,
  world: World,
  adapter: ReturnType<typeof scriptedAdapter>,
): Promise<void> {
  const logger = quiet();
  const runner = createRunner({
    db: world.db,
    now: () => FIXED_NOW,
    logger,
    adapters: [adapter],
  });
  const api = new Hono<HttpEnv>();
  api.use('*', correlation());
  api.onError(errorHandler(logger));
  api.route('/', sourcesRoutes({ db: world.db, timezone: FIXED_TIMEZONE }));
  api.route('/', refreshRoutes({ db: world.db, runner }));
  await routeTo(page, api, /^\/api\/(sources|refresh)(\/|$)/);
}

/** The real setup routes over a first-launch world, looking at a temporary home in the state asked for (setup.spec.ts does the same). */
async function mountSetup(page: Page, world: World, homes: SetupHomeOptions): Promise<void> {
  const home = world.homes.make(homes);
  const logger = quiet();
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
      codexOnPath: () => false,
      github,
      chatgpt,
      logger,
    }),
  );
  await routeTo(page, api, /^\/api\/setup\//);
}

const ENVELOPE = JSON.stringify({
  error: { code: 'internal', message: 'The server could not do that.', retryable: true },
});
/** Every request to these API paths fails with the server's own error envelope. */
const failing = (paths: RegExp) => async (page: Page) => {
  await page.route(
    (url) => url.origin === ORIGIN && paths.test(url.pathname),
    (route) => route.fulfill({ status: 500, contentType: 'application/json', body: ENVELOPE }),
  );
};
/** Every request to these API paths waits and never answers: the screen stays loading. */
const loading = (paths: RegExp) => async (page: Page) => {
  await page.route(
    (url) => url.origin === ORIGIN && paths.test(url.pathname),
    () => undefined,
  );
};

const pending = (page: Page) => page.locator('[aria-busy="true"]').first();
const alert = (page: Page) => page.getByRole('alert').first();

const nothing = async (page: Page) => settled(page);

const STATES: State[] = [
  // ---- empty worlds ----
  { name: 'Overview with nothing at all', world: { scenario: 'empty' }, path: '/', reach: nothing },
  {
    name: 'Overview with no repositories tracked',
    world: { scenario: 'no-repos' },
    path: '/',
    reach: nothing,
  },
  {
    name: 'Overview with only an account connected',
    world: { scenario: 'account-only' },
    path: '/',
    reach: nothing,
  },
  {
    name: 'Trends with nothing at all',
    world: { scenario: 'empty' },
    path: '/trends',
    reach: nothing,
  },
  {
    name: 'Delivery with no repositories tracked',
    world: { scenario: 'no-repos' },
    path: '/delivery',
    reach: nothing,
  },
  {
    name: 'Usage with nothing at all',
    world: { scenario: 'empty' },
    path: '/usage',
    reach: nothing,
  },
  {
    name: 'Sources with nothing at all',
    world: { scenario: 'empty' },
    path: '/sources',
    reach: nothing,
  },

  // ---- a failed refresh ----
  {
    name: 'Overview with the failed-refresh banner',
    world: { scenario: 'refresh-failed' },
    path: '/',
    reach: async (page) => {
      await expect(page.getByRole('status').filter({ hasText: 'Refresh failed.' })).toBeVisible();
      await settled(page);
    },
  },
  {
    name: 'Sources with a failed source and its banner',
    world: { scenario: 'refresh-failed' },
    path: '/sources',
    reach: async (page) => {
      await expect(page.getByRole('status').filter({ hasText: 'Refresh failed.' })).toBeVisible();
      await settled(page);
    },
  },
  {
    name: 'Retry in flight: the button says Retrying and is busy',
    world: { scenario: 'refresh-failed' },
    path: '/sources',
    prepare: async (page, world) => {
      const held = gate();
      await mountRefresh(page, world, scriptedAdapter('codex', [holds(held, succeeds())]));
      return () => held.release();
    },
    reach: async (page) => {
      await page
        .getByRole('status')
        .filter({ hasText: 'Refresh failed.' })
        .getByRole('button', { name: 'Retry' })
        .click();
      await expect(page.getByRole('button', { name: /^Retrying/ }).first()).toHaveAttribute(
        'aria-busy',
        'true',
      );
    },
  },

  // ---- loading and failing ----
  {
    name: 'Overview while it loads',
    path: '/',
    prepare: loading(/^\/api\/(overview|series)$/),
    reach: async (page) => expect(pending(page)).toBeVisible(),
  },
  {
    name: 'Delivery while it loads',
    path: '/delivery',
    prepare: loading(/^\/api\/prs$/),
    reach: async (page) => expect(pending(page)).toBeVisible(),
  },
  {
    name: 'Usage while it loads',
    path: '/usage',
    prepare: loading(/^\/api\/usage\//),
    reach: async (page) => expect(pending(page)).toBeVisible(),
  },
  {
    name: 'Overview when the request fails',
    path: '/',
    prepare: failing(/^\/api\/(overview|series)$/),
    reach: async (page) => expect(alert(page)).toBeVisible({ timeout: 20_000 }),
  },
  {
    name: 'Delivery when the request fails',
    path: '/delivery',
    prepare: failing(/^\/api\/prs$/),
    reach: async (page) => expect(alert(page)).toBeVisible({ timeout: 20_000 }),
  },
  {
    name: 'Usage when the request fails',
    path: '/usage',
    prepare: failing(/^\/api\/usage\//),
    reach: async (page) => expect(alert(page)).toBeVisible({ timeout: 20_000 }),
  },

  // ---- a drawer, a panel, a toast, a tree ----
  {
    name: 'the records drawer open on Overview (a sheet on a phone)',
    path: '/?author=all',
    reach: async (page) => {
      const chart = page.getByRole('group', {
        name: /^Delivery and usage over time|^Merged PRs and recorded local tokens/,
      });
      await expect(chart).toBeVisible();
      await chart.focus();
      await page.keyboard.press('Home');
      await page.keyboard.press('Enter');
      const drawer = page.getByRole('dialog');
      await expect(drawer).toBeVisible();
      await expect(drawer.getByRole('button', { name: 'Close' })).toBeInViewport();
      await expect(drawer.getByText('Loading')).toHaveCount(0);
    },
  },
  {
    name: 'a PR opened to its link evidence',
    path: '/delivery',
    reach: async (page) => {
      await page.locator('[data-pr-id] button[aria-expanded="false"]').first().click();
      await expect(page.locator('li[data-evidence-session]').first()).toBeVisible();
    },
  },
  {
    name: 'a PR with its Link a session form open',
    path: '/delivery',
    reach: async (page) => {
      await page.locator('[data-pr-id] button[aria-expanded="false"]').first().click();
      await expect(page.locator('li[data-evidence-session]').first()).toBeVisible();
      await page
        .getByRole('button', { name: /^Link a session/ })
        .first()
        .click();
      await expect(page.getByRole('combobox').first()).toBeVisible();
    },
  },
  {
    name: 'a confirmed link with its toast and Undo',
    path: '/delivery',
    reach: async (page, world, widthIndex) => {
      // Confirming is saved, so each width confirms a different PR that carries a suggestion (the seeded week: #311, #315, #106).
      const listed = await answerApi(world.app, { method: 'GET', path: '/api/prs', headers: {} });
      const items = (
        JSON.parse(listed.body.toString('utf8')) as { items: { id: string; number: number }[] }
      ).items;
      const pr = items.find((item) => item.number === [311, 315, 106][widthIndex])!;
      await page.locator(`[data-pr-id="${pr.id}"] button[aria-expanded]`).click();
      await page
        .getByRole('button', { name: /^Confirm link/ })
        .first()
        .click();
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
    },
  },
  {
    name: 'the whole Usage tree open, children and their badges included',
    path: '/usage',
    reach: async (page) => {
      const tree = page.locator('main');
      await expect(tree.locator('button[aria-expanded]').first()).toBeVisible();
      // Open every closed row in one go, wait for the sessions it asks for, and look again until nothing is left closed.
      for (let round = 0; round < 12; round += 1) {
        await expect(tree.getByText('Loading sessions…')).toHaveCount(0);
        const opened = await page.evaluate(() => {
          const closed = [
            ...document.querySelectorAll<HTMLElement>(
              'main li button[aria-expanded="false"], main tr button[aria-expanded="false"]',
            ),
          ];
          closed.forEach((button) => button.click());
          return closed.length;
        });
        if (opened === 0) return;
      }
      throw new Error('the tree kept offering rows to open');
    },
  },

  // ---- accounts and setup ----
  {
    name: 'Sources with the GitHub App guide (gh not signed in)',
    world: { ghSignedIn: false },
    path: '/sources',
    reach: async (page) => {
      await settled(page);
      await expect(page.getByText(/GitHub App/i).first()).toBeVisible();
    },
  },
  {
    name: 'Setup step 1 with nothing found',
    world: { firstLaunch: true, ghSignedIn: false },
    path: '/',
    prepare: (page, world) =>
      mountSetup(page, world, { claude: 'absent', codex: 'absent' }).then(() => undefined),
    reach: async (page) => {
      await expect(page).toHaveURL(`${ORIGIN}/setup`);
      await expect(page.getByText('Looking…')).toHaveCount(0);
      await expect(page.getByText('Not found').first()).toBeVisible();
    },
  },
  {
    name: 'Setup step 1 with a folder that cannot be read',
    world: { firstLaunch: true, ghSignedIn: false },
    path: '/',
    prepare: (page, world) =>
      mountSetup(page, world, { claude: 'denied', codex: 'found' }).then(() => undefined),
    reach: async (page) => {
      await expect(page).toHaveURL(`${ORIGIN}/setup`);
      await expect(page.getByText('Looking…')).toHaveCount(0);
      await expect(page.getByText('Access denied').first()).toBeVisible();
    },
  },
];

test.describe('every state of every screen', () => {
  for (const state of STATES) {
    const denied = state.name.includes('cannot be read');
    test(`${state.name}: no axe violations at 1280, 390 and 320px`, TAGS, async ({ page }) => {
      test.setTimeout(120_000);
      test.skip(denied && !CAN_DENY, 'this user can read a folder with no permissions');
      const world = await openWorld(page, state.world);
      await scan(page, world, state);
    });
  }
});

// ---- the recovery pages ------------------------------------------------------------------------------------------------------------
// Pages the server renders by itself when the database cannot be used. Loaded as the browser gets them (a whole document), with a long path
// so the wrapping is looked at too.

const LONG_PATH =
  '/Users/someone-with-a-rather-long-account-name/Library/Application Support/agent-productivity/a-folder-with-a-very-long-name-that-has-no-break-points-at-all/agent-productivity.db';
const REASONS: DatabaseRecoveryReason[] = [
  'corrupt',
  'migration_failed',
  'newer_schema',
  'unreadable',
];
const RECOVERY: Array<[name: string, html: string]> = [
  ...REASONS.map((reason): [string, string] => [
    `database: ${reason}`,
    databaseRecoveryPage({
      reason,
      dbPath: LONG_PATH,
      detail: 'SQLite reports the file is damaged or is not a database.',
      migrationFile: '002_add_something_to_the_schema.sql',
    }),
  ]),
  [
    'already running',
    alreadyRunningPage({ url: 'http://127.0.0.1:4317', lockPath: `${LONG_PATH}.lock`, pid: 4242 }),
  ],
  [
    'not enough disk space',
    diskFullPage({ dataDir: LONG_PATH, detail: 'No space left on device.' }),
  ],
];

test.describe('the recovery pages', () => {
  for (const [name, html] of RECOVERY) {
    test(
      `${name}: no axe violations at 1280, 390 and 320px, and it says nothing was deleted`,
      TAGS,
      async ({ page }) => {
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: 900 });
          await page.setContent(html);
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
          await expect(page.getByText('Nothing was deleted or changed.')).toBeVisible();
          expect(await axeFindings(page), `${name} at ${width}px`).toEqual([]);
          expect(await fitsWidth(page), `${name} scrolls sideways at ${width}px`).toBe(true);
        }
      },
    );
  }
});

test.describe('a file-name suffix on a recovery page', () => {
  // "Move any -wal and -shm files beside it too." broke after the hyphen at 320px, leaving "-" at the end of one line and "wal" at the
  // start of the next. The names are code that does not break, so they read as the names the owner is about to type.
  test('database: -wal and -shm are each on one line at 320px', TAGS, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.setContent(
      databaseRecoveryPage({
        reason: 'corrupt',
        dbPath: LONG_PATH,
        detail: 'SQLite reports the file is damaged or is not a database.',
      }),
    );
    for (const name of ['-wal', '-shm']) {
      const suffix = page.locator('li > code', { hasText: new RegExp(`^${name}$`) });
      await expect(suffix, `${name} is drawn as code`).toHaveCount(1);
      expect(
        await suffix.evaluate((el) => ({
          lines: el.getClientRects().length,
          nowrap: getComputedStyle(el).whiteSpace,
        })),
      ).toEqual({ lines: 1, nowrap: 'nowrap' });
    }
  });
});

// ---- text from outside is text; nothing is asked of another origin ----------------------------------------------------------------

test.describe('what the page does with outside text and outside addresses', () => {
  test(
    'a PR title that is markup is shown as text and runs nothing (TECH › Security: XSS)',
    TAGS,
    async ({ page }) => {
      const world = await openWorld(page);
      const title =
        '<img src=x onerror="window.__injected = true"><script>window.__injected = true</script>';
      world.db.prepare('UPDATE pull_request SET title = ?').run(title);
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${ORIGIN}/delivery?author=all`);
        await expect(page.getByRole('heading', { level: 1, name: 'Delivery' })).toBeVisible();
        await expect(page.getByText(title, { exact: false }).first()).toBeVisible();
        await settled(page);
        expect(
          await page.evaluate(() => (window as unknown as { __injected?: boolean }).__injected),
        ).toBeUndefined();
        expect(await page.locator('main img[src="x"], main script').count()).toBe(0);
        expect(await axeFindings(page), `at ${width}px`).toEqual([]);
        expect(await fitsWidth(page), `scrolls sideways at ${width}px`).toBe(true);
      }
    },
  );

  test('every request, on every screen, goes to the app’s own address and nothing else', async ({
    page,
  }) => {
    await openWorld(page);
    const outside: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith(`${ORIGIN}/`) && !url.startsWith('data:') && !url.startsWith('blob:'))
        outside.push(url);
    });
    for (const path of ['/', '/trends', '/delivery', '/usage', '/hq', '/sources', '/setup']) {
      await page.goto(`${ORIGIN}${path}`);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await settled(page);
    }
    expect(outside, 'requests to another address').toEqual([]);
  });
});
