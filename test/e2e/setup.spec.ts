import AxeBuilder from '@axe-core/playwright';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import type { Hono } from 'hono';
import type { HttpEnv } from '../../src/server/http/errors.ts';
import { findOnPath } from '../../src/server/services/setup.ts';
import { UNTRACKED_REPO } from '../fixtures/github/world.ts';
import { gate } from '../fixtures/scripted-adapters/scripted.ts';
import { FIXED_NOW } from '../fixtures/seed.ts';
import { expect, test } from './fixtures';
import { failures, measureContainment } from './helpers/containment';
import { CAN_DENY } from './helpers/homes';
import { mountSetup } from './helpers/setupMachine';
import { ORIGIN } from './helpers/virtualOrigin';
import { answerApi, type World } from './helpers/world';

// First-launch Setup (M10: A35, goals G10_1 and G10_2; TECH J1; P-39, P-40, P-41, P-43, P-44), in the real build in a real browser over the
// real API and a seeded database. The world is a brand-new install (`firstLaunch`): setup is not finished, so the shell sends the first
// load to /setup.
//
// What is real and what is scripted. The setup routes are the real ones (`setupRoutes`), mounted here over the world's database and
// answering before the world's own routes (a route registered on the page later wins, as recovery.spec.ts does). Discovery looks at a
// TEMPORARY home with copies of the invented fixture folders (`world.homes`): nothing reads this computer's folders, and nothing here
// reads a variable of the process. Paseo is a scripted daemon (a fake client, no socket) and `codex` on the PATH is a scripted answer; no
// program is started. The first refresh run is the real runner over scripted adapters that wait until the spec lets them finish.
//
// The clock is the seed's fixed one (Wed 2026-11-04 9:42 AM in America/Los_Angeles).

test.use({ worldOptions: { firstLaunch: true } });

const SOURCES_CARD = 'Finding agent records on this machine';
const ACCOUNTS_CARD = 'Connect accounts';
const REPOS_CARD = 'Choose repositories to track';

// ---- finding things on the page ----

const stepper = (page: Page): Locator => page.getByRole('list', { name: 'Setup progress' });
const current = (page: Page): Locator => stepper(page).locator('[aria-current="step"]');
const card = (page: Page, title: string): Locator => page.getByRole('region', { name: title });
/** One row of a step's own list. The App guide's numbered steps are a list inside a row, not a row. */
const sourceRow = (page: Page, name: string): Locator =>
  card(page, SOURCES_CARD).locator(':scope > ul > li').filter({ hasText: name });
const accountRow = (page: Page, name: string): Locator =>
  card(page, ACCOUNTS_CARD).locator(':scope > ul > li').filter({ hasText: name });
const button = (page: Page, name: string): Locator =>
  page.getByRole('button', { name, exact: true });
const overviewSkeleton = (page: Page): Locator => page.locator('section[aria-busy="true"]');

/** Opens the app the way a first launch does: at its address, with nothing said about Setup. The shell sends it there. */
async function openFirstLaunch(page: Page, path = '/'): Promise<void> {
  await page.clock.setFixedTime(new Date(FIXED_NOW));
  await page.goto(`${ORIGIN}${path}`);
  await expect(page).toHaveURL(`${ORIGIN}/setup`);
  await expect(page.getByRole('heading', { level: 1, name: /^Setup/ })).toBeVisible();
}

/** Step 1 has answered: nothing says "Looking…" any more. */
async function lookDone(page: Page): Promise<void> {
  await expect(card(page, SOURCES_CARD).getByText('Looking…')).toHaveCount(0);
  await expect(button(page, 'Continue')).not.toHaveAttribute('aria-disabled', 'true');
}

const finish = async (page: Page): Promise<void> => {
  await button(page, 'Finish setup').click();
};

/** Every control that takes text or a choice on the page, as `tag[type] "its name"`, so a spec says what a step lets the owner type. */
async function fields(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const controls = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
    return Array.from(document.querySelectorAll(controls))
      .filter((el) => {
        const style = getComputedStyle(el);
        return (
          el.getAttribute('type') !== 'hidden' &&
          style.visibility !== 'hidden' &&
          style.display !== 'none'
        );
      })
      .map((el) => {
        const id = el.getAttribute('id');
        const label =
          el.getAttribute('aria-label') ??
          (id ? document.querySelector(`label[for="${id}"]`)?.textContent : null) ??
          el.getAttribute('placeholder') ??
          '';
        return `${el.tagName.toLowerCase()}[${el.getAttribute('type') ?? 'text'}] "${label.trim()}"`;
      });
  });
}

/** The words that would mean the page asks for something it must never ask for. */
const FORBIDDEN_FIELD =
  /api[ -]?key|password|passcode|cookie|secret|token|folder|director|browse|choose a (file|path)|path/i;

const json = { 'content-type': 'application/json', 'x-agent-productivity-request': '1' };
const post = (api: Hono<HttpEnv>, path: string, body?: string) =>
  answerApi(api, { method: 'POST', path, headers: json, body: body ? Buffer.from(body) : null });
const parse = <T>(answer: { body: Buffer }): T => JSON.parse(answer.body.toString('utf8')) as T;
const count = (world: World, table: string): number =>
  (world.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

// ---- what a first launch shows ----

test.describe('a first launch', () => {
  test('is sent to Setup, which has no navigation and no filters, and shows a three-step progress list with the current step marked', async ({
    page,
    world,
  }) => {
    await mountSetup(page, world);
    await openFirstLaunch(page);

    await expect(page.getByRole('navigation', { name: 'Sections' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Filters' })).toHaveCount(0);
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page).toHaveTitle('Setup · Agent Productivity HQ');

    // SetupProgress is an ordered list with one item marked aria-current="step"; steps already passed are announced as done.
    await expect(stepper(page).getByRole('listitem')).toHaveText([
      /Local sources/,
      /Accounts/,
      /Repositories/,
    ]);
    await expect(current(page)).toHaveCount(1);
    await expect(current(page)).toContainText('Local sources');
    await lookDone(page);
    await button(page, 'Continue').click();
    await expect(card(page, ACCOUNTS_CARD)).toBeVisible();
    await expect(current(page)).toHaveCount(1);
    await expect(current(page)).toContainText('Accounts');
    await expect(stepper(page).getByRole('listitem').first()).toContainText(/completed|done/i);
    // The focus moves to the new step's heading, so a keyboard or screen-reader user starts where the content does.
    await expect(page.getByRole('heading', { level: 2, name: ACCOUNTS_CARD })).toBeFocused();
    await button(page, 'Continue').click();
    await expect(current(page)).toContainText('Repositories');
    await button(page, 'Back').click();
    await expect(current(page)).toContainText('Accounts');
  });

  test('draws “Step N of 3” in the Setup app bar and the first-launch redirect takes no focus', async ({
    page,
    world,
  }) => {
    await mountSetup(page, world);
    await openFirstLaunch(page);
    const banner = page.getByRole('banner');
    await expect(banner.getByText('Step 1 of 3', { exact: true })).toBeVisible();
    await expect(banner.getByRole('button', { name: /Refresh/ })).toHaveCount(0);
    // Arriving by the app's own redirect is not something the owner did: no heading holds the focus (and draws a ring around itself).
    await expect(page.getByRole('heading', { level: 1 })).not.toBeFocused();
    await expect(page.getByText(/Made with ❤️ by/)).toHaveCount(0);
    const about = banner.getByRole('button', { name: 'About Agent Productivity HQ' });
    await about.click();
    await expect(page.getByRole('dialog', { name: 'About Agent Productivity HQ' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(about).toBeFocused();
    await lookDone(page);
    await button(page, 'Continue').click();
    await expect(banner.getByText('Step 2 of 3', { exact: true })).toBeVisible();
    await button(page, 'Continue').click();
    await expect(banner.getByText('Step 3 of 3', { exact: true })).toBeVisible();
    await button(page, 'Back').click();
    await expect(banner.getByText('Step 2 of 3', { exact: true })).toBeVisible();
  });

  test('finds Codex, Claude Code and Paseo with nothing to pick: no folder, no path, no picker', async ({
    page,
    world,
  }) => {
    const machine = await mountSetup(page, world);
    await openFirstLaunch(page);
    await lookDone(page);

    for (const name of ['Codex', 'Claude Code']) {
      const row = sourceRow(page, name);
      await expect(row.getByText('Found', { exact: true })).toBeVisible();
      // Where it was found is SAID: a folder in the temporary home, at the provider's usual place, and never asked for.
      await expect(row).toContainText(machine.home.home);
      await expect(row).toContainText('found automatically');
    }
    await expect(sourceRow(page, 'Paseo').getByText('Found', { exact: true })).toBeVisible();
    await expect(card(page, SOURCES_CARD)).toContainText(
      '3 of 3 sources found. History starts where each source’s records start.',
    );
    await expect(card(page, SOURCES_CARD).getByRole('button')).toHaveCount(0);
    expect(await fields(page)).toEqual([]);

    // Discovery only looked (G10_1): it wrote each source's word and place and nothing else. No attempt, no usage, no session, and the
    // daemon was connected to and hung up on, never asked for its agents. Nothing was started, and `codex` was only looked for.
    expect(machine.calls.setup).toEqual(['POST /api/setup/discover']);
    expect(machine.calls.paseoConnects).toBe(1);
    expect(machine.calls.paseoLists).toBe(0);
    expect(machine.calls.appServerLaunches).toBe(0);
    expect(count(world, 'usage_event')).toBe(0);
    expect(count(world, 'session')).toBe(0);
    expect(count(world, 'refresh_run')).toBe(0);
    const rows = world.db
      .prepare('SELECT source_id, status, last_attempt_at FROM source_state ORDER BY source_id')
      .all() as Array<{ source_id: string; status: string; last_attempt_at: number | null }>;
    expect(rows.map((r) => [r.source_id, r.status, r.last_attempt_at])).toEqual([
      ['claude', 'ok', null],
      ['codex', 'ok', null],
      ['paseo', 'ok', null],
    ]);
  });

  test('finds them at the provider’s own override variable too, as P-39 asks, and still asks for nothing', async ({
    page,
    world,
  }) => {
    const machine = await mountSetup(page, world, {
      homeOptions: { claudeAt: 'override', codexAt: 'override' },
    });
    await openFirstLaunch(page);
    await lookDone(page);

    for (const name of ['Codex', 'Claude Code']) {
      await expect(sourceRow(page, name).getByText('Found', { exact: true })).toBeVisible();
      await expect(sourceRow(page, name)).toContainText(join(machine.home.home, 'elsewhere'));
    }
    expect(machine.home.env['CODEX_HOME']).toBeDefined();
    expect(await fields(page)).toEqual([]);
  });

  test('pops the buddy of a source that is found by a mount transition, once, and not by a takeEnter flag', async ({
    page,
    world,
  }) => {
    await mountSetup(page, world);
    // Hold the answer so the rows are looking, then watch the found buddy arrive: its first style resolution carries a transition from
    // the `starting:` state, which is what a mount transition is.
    const answerHeld = gate();
    await page.route(`${ORIGIN}/api/setup/discover`, async (route) => {
      await answerHeld.promise;
      await route.fallback();
    });
    await page.clock.setFixedTime(new Date(FIXED_NOW));
    await page.goto(`${ORIGIN}/setup`);
    await expect(sourceRow(page, 'Codex').getByText('Looking…')).toBeVisible();
    await expect(button(page, 'Continue')).toHaveAttribute('aria-disabled', 'true');

    const seen = page.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          const watch = new MutationObserver(() => {
            const row = Array.from(document.querySelectorAll('li')).find((li) =>
              li.textContent?.includes('Codex'),
            );
            const buddy = row?.querySelector('b svg');
            if (!buddy || !row?.textContent?.includes('Found')) return;
            watch.disconnect();
            // Reading the animations resolves the style, which is when a `starting:` transition begins.
            resolve(
              buddy
                .getAnimations()
                .map((a) => `${a.constructor.name}:${(a as CSSTransition).transitionProperty}`),
            );
          });
          watch.observe(document.body, { childList: true, subtree: true, characterData: true });
        }),
    );
    answerHeld.release();
    const animations = await seen;
    expect(animations).toEqual(
      expect.arrayContaining(['CSSTransition:opacity', 'CSSTransition:scale']),
    );
    await expect(page.locator('.is-entering')).toHaveCount(0);

    // Not news the second time: the owner leaves the step and comes back, and the buddy is drawn at rest.
    await lookDone(page);
    await button(page, 'Continue').click();
    await button(page, 'Back').click();
    const again = await sourceRow(page, 'Codex')
      .locator('b svg')
      .evaluate((svg) => svg.getAnimations().length);
    expect(again).toBe(0);
  });

  test('under reduced motion the pop is opacity only', async ({ page, world }) => {
    await mountSetup(page, world);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const answerHeld = gate();
    await page.route(`${ORIGIN}/api/setup/discover`, async (route) => {
      await answerHeld.promise;
      await route.fallback();
    });
    await page.goto(`${ORIGIN}/setup`);
    await expect(sourceRow(page, 'Codex').getByText('Looking…')).toBeVisible();
    const seen = page.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          const watch = new MutationObserver(() => {
            const row = Array.from(document.querySelectorAll('li')).find((li) =>
              li.textContent?.includes('Codex'),
            );
            const buddy = row?.querySelector('b svg');
            if (!buddy || !row?.textContent?.includes('Found')) return;
            watch.disconnect();
            resolve(buddy.getAnimations().map((a) => (a as CSSTransition).transitionProperty));
          });
          watch.observe(document.body, { childList: true, subtree: true, characterData: true });
        }),
    );
    answerHeld.release();
    expect(await seen).toEqual(['opacity']);
  });
});

// ---- when nothing is found, and when it cannot be read ----

test.describe('the page keeps D7’s measures', () => {
  test(
    'the column is D7’s .setup: 712px of content on a desktop, centred, with 24px above on a desktop and 16px on a phone',
    { tag: '@responsive' },
    async ({ page, world }) => {
      await mountSetup(page, world);
      await page.setViewportSize({ width: 1280, height: 800 });
      await openFirstLaunch(page);
      await lookDone(page);
      const desktop = await card(page, SOURCES_CARD).boundingBox();
      expect(desktop?.width).toBeCloseTo(712, 0);
      expect((desktop?.x ?? 0) + (desktop?.width ?? 0) / 2).toBeCloseTo(640, 0);
      const main = await page.locator('main').evaluate((node) => getComputedStyle(node).paddingTop);
      expect(main).toBe('24px');
      await page.setViewportSize({ width: 390, height: 800 });
      expect(await page.locator('main').evaluate((node) => getComputedStyle(node).paddingTop)).toBe(
        '16px',
      );
      // On a phone the art stands above the heading with D7's 24px between them.
      const art = await page.locator('main svg').first().boundingBox();
      const heading = await page.getByRole('heading', { level: 1 }).boundingBox();
      expect((heading?.y ?? 0) - ((art?.y ?? 0) + (art?.height ?? 0))).toBeGreaterThanOrEqual(23);
    },
  );
});

test.describe('when there is nothing to find', () => {
  test('says Not found, Not running and the designed empty state, offers Check again, and goes on: nothing here is required', async ({
    page,
    world,
  }) => {
    const machine = await mountSetup(page, world, {
      homeOptions: { claude: 'absent', codex: 'absent' },
      paseo: 'down',
      codexOnPath: false,
    });
    await openFirstLaunch(page);
    await lookDone(page);

    await expect(sourceRow(page, 'Codex').getByText('Not found', { exact: true })).toBeVisible();
    await expect(
      sourceRow(page, 'Claude Code').getByText('Not found', { exact: true }),
    ).toBeVisible();
    await expect(sourceRow(page, 'Paseo').getByText('Not running', { exact: true })).toBeVisible();
    await expect(sourceRow(page, 'Codex')).toContainText(
      'No records in its usual locations. If you use Codex here, run it once, then check again.',
    );
    await expect(card(page, SOURCES_CARD)).toContainText(
      'No local agent records found on this machine. You can still connect accounts for account-reported usage and track repos for merged PRs.',
    );
    await expect(card(page, SOURCES_CARD).getByRole('button', { name: 'Check again' })).toHaveCount(
      3,
    );
    // The crew looks around instead of waking: nothing to wake.
    expect(machine.calls.paseoLists).toBe(0);

    // Without `codex` on the PATH ChatGPT cannot be connected, and the row says so instead of offering a Connect that cannot work.
    await button(page, 'Continue').click();
    const chatgpt = accountRow(page, 'ChatGPT');
    await expect(chatgpt).toContainText('Unavailable: Codex CLI not found');
    await expect(chatgpt.getByRole('button', { name: /Connect ChatGPT/ })).toHaveCount(0);
    // GitHub is still there to connect, and Finish is allowed with all of it empty.
    await expect(accountRow(page, 'GitHub').getByText('Using your existing sign-in')).toBeVisible();
    expect(machine.calls.codexChecks).toBeGreaterThan(0);
    expect(machine.calls.appServerLaunches).toBe(0);
  });

  test('Check again looks again, so a folder that appears later is found without anyone typing its place', async ({
    page,
    world,
  }) => {
    const machine = await mountSetup(page, world, { homeOptions: { claude: 'absent' } });
    await openFirstLaunch(page);
    await lookDone(page);
    await expect(
      sourceRow(page, 'Claude Code').getByText('Not found', { exact: true }),
    ).toBeVisible();

    // Claude Code is run once: its folder appears at the usual place. (Copied from the same invented fixture the home is made from.)
    const other = world.homes.make({ codex: 'absent' });
    const claudeDir = join(machine.home.home, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    cpSync(join(other.home, '.claude'), claudeDir, { recursive: true });

    await sourceRow(page, 'Claude Code').getByRole('button', { name: 'Check again' }).click();
    await expect(sourceRow(page, 'Claude Code').getByText('Found', { exact: true })).toBeVisible();
    await expect(sourceRow(page, 'Claude Code')).toContainText(claudeDir);
    expect(machine.calls.setup).toEqual(['POST /api/setup/discover', 'POST /api/setup/discover']);
  });

  test('a process with no Paseo leaves Paseo out, and never claims a state nobody looked at', async ({
    page,
    world,
  }) => {
    await mountSetup(page, world, { paseo: 'absent' });
    await openFirstLaunch(page);
    await lookDone(page);
    await expect(card(page, SOURCES_CARD).getByRole('listitem')).toHaveCount(2);
    await expect(sourceRow(page, 'Paseo')).toHaveCount(0);
    await expect(card(page, SOURCES_CARD)).toContainText('2 of 2 sources found.');
  });

  test('says Access denied for a folder that is there and cannot be read, and Needs a password for a protected Paseo, then Retry sees the folder once it can be read', async ({
    page,
    world,
  }) => {
    test.skip(!CAN_DENY, 'a user that can read everything cannot be denied a folder');
    const machine = await mountSetup(page, world, {
      homeOptions: { claude: 'denied' },
      paseo: 'password',
    });
    await openFirstLaunch(page);
    await lookDone(page);

    const claude = sourceRow(page, 'Claude Code');
    await expect(claude.getByText('Access denied', { exact: true })).toBeVisible();
    await expect(claude).toContainText('Claude Code’s data is here but couldn’t be read');
    await expect(sourceRow(page, 'Codex').getByText('Found', { exact: true })).toBeVisible();
    const paseo = sourceRow(page, 'Paseo');
    await expect(paseo.getByText('Needs a password', { exact: true })).toBeVisible();
    await expect(paseo).toContainText('which this dashboard doesn’t support');
    await expect(card(page, SOURCES_CARD)).toContainText('1 of 3 sources found.');
    // A password is never asked for: not a field, not a prompt.
    expect(await fields(page)).toEqual([]);

    // The owner allows read access (outside the app, as the sentence says), then presses Retry.
    for (const path of machine.home.denied) chmodSync(path, 0o700);
    await claude.getByRole('button', { name: 'Retry' }).click();
    await expect(claude.getByText('Found', { exact: true })).toBeVisible();
    await expect(claude.getByRole('button')).toHaveCount(0);
  });

  test('says the look could not be made when the app does not answer, keeps Skip, and Check again tries once more', async ({
    page,
    world,
  }) => {
    await mountSetup(page, world);
    let answered = 0;
    await page.route(`${ORIGIN}/api/setup/discover`, async (route) => {
      answered += 1;
      if (answered === 1) await route.abort('failed');
      else await route.fallback();
    });
    await openFirstLaunch(page);
    await expect(card(page, SOURCES_CARD).getByRole('alert')).toContainText(
      'Couldn’t look at this machine.',
    );
    await expect(button(page, 'Skip this step')).toBeEnabled();
    await card(page, SOURCES_CARD).getByRole('button', { name: 'Check again' }).click();
    await expect(sourceRow(page, 'Codex').getByText('Found', { exact: true })).toBeVisible();
  });
});

// ---- skipping, finishing ----

test.describe('finishing', () => {
  test('every step can be skipped, and Finish with nothing connected and nothing tracked starts the first run once and lands on Overview with skeletons', async ({
    page,
    world,
  }) => {
    const machine = await mountSetup(page, world);
    await openFirstLaunch(page);

    // Step 1 is skipped while it is still looking: Continue waits for the look, Skip never does.
    const lookHeld = gate();
    await page.route(`${ORIGIN}/api/setup/discover`, async (route) => {
      await lookHeld.promise;
      await route.fallback();
    });
    await page.goto(`${ORIGIN}/setup`);
    await expect(button(page, 'Continue')).toHaveAttribute('aria-disabled', 'true');
    await expect(button(page, 'Skip this step')).toBeEnabled();
    await button(page, 'Skip this step').click();
    await expect(card(page, ACCOUNTS_CARD)).toBeVisible();
    await button(page, 'Skip this step').click();
    await expect(card(page, REPOS_CARD)).toBeVisible();
    await expect(page.getByText('You can finish without any')).toBeVisible();
    lookHeld.release();

    // Hold Overview's own data, so the landing is seen the way a first import is: skeletons until it arrives.
    const overviewHeld = gate();
    await page.route(`${ORIGIN}/api/overview*`, async (route) => {
      await overviewHeld.promise;
      await route.fallback();
    });
    expect(count(world, 'refresh_run')).toBe(0);
    await finish(page);
    await expect(page).toHaveURL(`${ORIGIN}/`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Overview');
    await expect(overviewSkeleton(page).first()).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();

    // One request finished it, and it started one run: the first full refresh, still going. Setup is done on the server.
    expect(machine.calls.setup.filter((call) => call === 'POST /api/setup/complete')).toHaveLength(
      1,
    );
    const runs = world.db.prepare('SELECT id, trigger, state FROM refresh_run').all() as Array<{
      id: number;
      trigger: string;
      state: string;
    }>;
    expect(runs).toEqual([{ id: 1, trigger: 'setup', state: 'running' }]);
    const bootstrap = parse<{ setupComplete: boolean }>(
      await answerApi(world.app, { method: 'GET', path: '/api/bootstrap', headers: {} }),
    );
    expect(bootstrap.setupComplete).toBe(true);

    // Sources says it is importing while the run goes, and Overview fills in when its answer arrives and the run ends.
    overviewHeld.release();
    await expect(overviewSkeleton(page)).toHaveCount(0);
    machine.held.release();
    await machine.runner.idle();
    expect(
      (world.db.prepare('SELECT state FROM refresh_run WHERE id = 1').get() as { state: string })
        .state,
    ).toBe('succeeded');

    // Setup is not asked for again: the shell lets the owner stay on Overview, and the page's own /setup is still reachable.
    await page.goto(`${ORIGIN}/`);
    await expect(page).toHaveURL(`${ORIGIN}/`);
  });

  test('a repeat Finish (a second tab, a double click) changes nothing and starts no second run', async ({
    page,
    world,
  }) => {
    const machine = await mountSetup(page, world);
    await openFirstLaunch(page);
    await lookDone(page);
    await button(page, 'Skip this step').click();
    await button(page, 'Skip this step').click();

    // A double click: the second press is ignored while the first is in flight.
    await button(page, 'Finish setup').dblclick();
    await expect(page).toHaveURL(`${ORIGIN}/`);
    expect(machine.calls.setup.filter((call) => call === 'POST /api/setup/complete')).toHaveLength(
      1,
    );
    expect(count(world, 'refresh_run')).toBe(1);

    // A second tab pressing Finish: the same answer, the run that is going, and still one run.
    const first = parse<{ id: number; state: string }>(
      await post(machine.api, '/api/setup/complete'),
    );
    const second = parse<{ id: number; state: string }>(
      await post(machine.api, '/api/setup/complete'),
    );
    expect(first.id).toBe(1);
    expect(second).toEqual(first);
    expect(first.state).toBe('running');
    expect(count(world, 'refresh_run')).toBe(1);

    // Once the run has ended, a repeat answers the latest finished one: still no new run.
    machine.held.release();
    await machine.runner.idle();
    const later = parse<{ id: number; state: string }>(
      await post(machine.api, '/api/setup/complete'),
    );
    expect(later).toMatchObject({ id: 1, state: 'succeeded' });
    expect(count(world, 'refresh_run')).toBe(1);
  });

  test('stays on Setup, with the reason, when the server could not save it, and Finish can be pressed again', async ({
    page,
    world,
  }) => {
    await mountSetup(page, world);
    await openFirstLaunch(page);
    await lookDone(page);
    await button(page, 'Skip this step').click();
    await button(page, 'Skip this step').click();

    let refused = true;
    await page.route(`${ORIGIN}/api/setup/complete`, async (route) => {
      if (!refused) return route.fallback();
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'internal',
            message: 'Something went wrong on this computer. Try again.',
            retryable: true,
          },
        }),
      });
    });
    await finish(page);
    await expect(
      page.getByRole('alert').filter({ hasText: 'Couldn’t finish setup.' }),
    ).toBeVisible();
    await expect(page).toHaveURL(`${ORIGIN}/setup`);
    await expect(button(page, 'Finish setup')).toBeVisible();
    expect(count(world, 'refresh_run')).toBe(0);

    refused = false;
    await finish(page);
    await expect(page).toHaveURL(`${ORIGIN}/`);
    expect(count(world, 'refresh_run')).toBe(1);
  });
});

// ---- what the page never asks for ----

test.describe('what Setup never asks for (P-41, P-43)', () => {
  test('has no API-key, password, cookie or folder field on any step, and no client-ID field while gh is signed in', async ({
    page,
    world,
  }) => {
    await mountSetup(page, world);
    await openFirstLaunch(page);
    await lookDone(page);

    // Step 1: nothing to type at all.
    expect(await fields(page)).toEqual([]);
    // Step 2: gh is signed in, so there is nothing to type here either, and no client-ID field in the page.
    await button(page, 'Continue').click();
    await expect(accountRow(page, 'GitHub').getByText('Using your existing sign-in')).toBeVisible();
    expect(await fields(page)).toEqual([]);
    await expect(page.getByLabel('GitHub App client ID')).toHaveCount(0);
    await expect(page.getByText('Register your GitHub App')).toHaveCount(0);
    // Step 3: the one field is the repository, named for what it takes.
    await button(page, 'Continue').click();
    const step3 = await fields(page);
    expect(step3).toEqual(['input[search] "Find a repository"']);

    // The words on every step: no field, label or placeholder asks for a key, a password, a cookie or a folder.
    for (const text of [...step3]) expect(text).not.toMatch(FORBIDDEN_FIELD);
    await expect(
      page.locator('input[type="password"], input[type="file"], input[webkitdirectory]'),
    ).toHaveCount(0);
    // And what the page says about it, so the owner knows it is by design.
    await button(page, 'Back').click();
    await expect(card(page, ACCOUNTS_CARD)).toContainText(
      'never asks for your password, model API keys or browser cookies',
    );
  });
});

test.describe('what Setup asks for when gh is not signed in (P-41, P-43)', () => {
  test.use({ worldOptions: { firstLaunch: true, ghSignedIn: false } });

  test('reveals the client ID on demand and leaves registration instructions collapsed', async ({
    page,
    world,
  }) => {
    await mountSetup(page, world, { ghSignedIn: false });
    world.github.device = { interval: 5, pendingPolls: 0, outcome: 'approve' };
    const githubWrites: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/accounts/github/') && request.method() !== 'GET') {
        githubWrites.push(request.method());
      }
    });
    await openFirstLaunch(page);
    await lookDone(page);
    await button(page, 'Continue').click();

    const github = accountRow(page, 'GitHub');
    await expect(github.getByText('Setup needed', { exact: true })).toBeVisible();
    await expect(github).toContainText(
      'Merged PRs require a GitHub connection and a tracked repository.',
    );
    await expect(button(page, 'Continue without GitHub')).toBeVisible();
    await expect(github.getByLabel('GitHub App client ID')).toHaveCount(0);
    await expect(accountRow(page, 'ChatGPT')).toBeVisible();
    await github.getByRole('button', { name: 'Connect GitHub' }).click();
    const disclosure = github.getByRole('button', { name: 'Close GitHub setup' });
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    const guide = github.getByText('Register your GitHub App (one time)');
    await expect(guide).toBeVisible();
    const registration = github.getByRole('link', { name: 'github.com/settings/apps/new' });
    await expect(registration).toBeHidden();
    await guide.click();
    await expect(registration).toBeVisible();
    await expect(github.getByText('Not yet designed', { exact: false })).toHaveCount(0);
    const found = await fields(page);
    expect(found).toEqual(['input[text] "GitHub App client ID"']);
    for (const text of found) expect(text).not.toMatch(FORBIDDEN_FIELD);
    await expect(
      page.locator('input[type="password"], input[type="file"], input[webkitdirectory]'),
    ).toHaveCount(0);
    // The field says what it is, and never asks for a secret.
    await expect(github).toContainText(
      'Never paste a client secret here; this app never asks for one.',
    );
    expect(githubWrites).toEqual([]);

    // Saving it is a setting: the server stores it and the field says one is saved, then empties.
    await github.getByLabel('GitHub App client ID').fill('Iv1.0123456789abcdef');
    await github.getByRole('button', { name: 'Save' }).click();
    await expect(github.getByText('Client ID saved')).toBeVisible();
    await expect(github.getByLabel('GitHub App client ID')).toHaveValue('');
    expect(githubWrites).toEqual(['PUT']);

    await github.getByRole('button', { name: 'Connect GitHub' }).click();
    await expect(github.getByRole('group', { name: 'Enter this code on GitHub' })).toBeVisible();
    await world.stepDeviceFlow();
    await expect(github.getByText('Connected', { exact: true })).toBeVisible();
    await button(page, 'Continue').click();
    await expect(page.getByLabel('Find a repository')).toBeVisible();
  });
});

// ---- step 3 ----

test.describe('choosing repositories', () => {
  test('adds a repository GitHub lets the connection read, and shows it as Access confirmed with its import still to come', async ({
    page,
    world,
  }) => {
    await mountSetup(page, world);
    await openFirstLaunch(page);
    await lookDone(page);
    await button(page, 'Skip this step').click();
    await button(page, 'Skip this step').click();
    const repos = card(page, REPOS_CARD);
    await expect(repos.getByText('No repositories tracked yet.')).toBeVisible();

    await page.getByLabel('Find a repository').fill(UNTRACKED_REPO);
    await repos.getByRole('button', { name: `Track ${UNTRACKED_REPO}`, exact: true }).click();
    const row = repos.locator(':scope > ul > li').filter({ hasText: UNTRACKED_REPO });
    await expect(row.getByText('Access confirmed')).toBeVisible();
    await expect(row).toContainText('Merged PRs will import after setup');
    await expect(page.getByLabel('Find a repository')).toHaveValue(UNTRACKED_REPO);
    await expect(
      repos.getByRole('button', { name: `Tracking ${UNTRACKED_REPO}`, exact: true }),
    ).toBeVisible();
    expect(count(world, 'pull_request')).toBe(0);
    expect(count(world, 'refresh_run')).toBe(0);

    // Remove stops tracking at once; nothing has been collected to lose.
    await row.getByRole('button', { name: `Remove ${UNTRACKED_REPO}` }).click();
    await expect(repos.getByText('No repositories tracked yet.')).toBeVisible();
  });

  test('keeps what was typed when a repository cannot be added, and says why (P-16)', async ({
    page,
    world,
  }) => {
    await mountSetup(page, world);
    await openFirstLaunch(page);
    await lookDone(page);
    await button(page, 'Skip this step').click();
    await button(page, 'Skip this step').click();
    const field = page.getByLabel('Find a repository');
    await field.fill('kelvin/no-such-repo');
    await card(page, REPOS_CARD)
      .getByRole('button', { name: 'Track kelvin/no-such-repo directly' })
      .click();
    await expect(card(page, REPOS_CARD).getByRole('alert')).toContainText(
      'GitHub didn’t grant access to kelvin/no-such-repo.',
    );
    await expect(field).toHaveValue('kelvin/no-such-repo');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(field).toBeFocused();
  });

  test('lets a signed-out owner go back or finish without showing the repository form', async ({
    page,
    world,
  }) => {
    await mountSetup(page, world, { ghSignedIn: false });
    world.github.signOutGh();
    await openFirstLaunch(page);
    await lookDone(page);
    await button(page, 'Skip this step').click();
    await button(page, 'Continue without GitHub').click();
    await expect(card(page, REPOS_CARD)).toContainText('Connect GitHub to add repositories.');
    await expect(page.getByLabel('Find a repository')).toHaveCount(0);
    await button(page, 'Back to accounts').click();
    await expect(card(page, ACCOUNTS_CARD)).toBeVisible();
    await expect(page.getByLabel('GitHub App client ID')).toHaveCount(0);
    await button(page, 'Continue without GitHub').click();
    await finish(page);
    await expect(page).toHaveURL(`${ORIGIN}/`);
  });
});

// ---- the server's half, asked directly ----

test.describe('the setup routes', () => {
  test('discover answers the three sources and the two accounts from an empty body, and takes nothing the client sends', async ({
    page,
    world,
  }) => {
    const machine = await mountSetup(page, world, { codexOnPath: false });
    const empty = await post(machine.api, '/api/setup/discover');
    expect(empty.status).toBe(200);
    const body = parse<{
      sources: Array<{ id: string; status: string; location?: string | null }>;
      accounts: Array<{ id: string; status: string; reason?: string | null }>;
    }>(empty);
    expect(body.sources.map((s) => [s.id, s.status])).toEqual([
      ['codex', 'ok'],
      ['claude', 'ok'],
      ['paseo', 'ok'],
    ]);
    expect(body.accounts.map((a) => [a.id, a.status])).toEqual([
      ['github', 'existing'],
      ['chatgpt', 'unavailable'],
    ]);
    expect(body.accounts[1]!.reason).toBe('codex_not_found');

    // A path, a folder, a key or a token in the body is not read: the same answer, and nothing it named is looked at or stored.
    const sent = await post(
      machine.api,
      '/api/setup/discover',
      JSON.stringify({
        path: '/etc',
        folder: '/Users/someone',
        apiKey: 'sk-SENTINEL',
        token: 'SENTINEL',
      }),
    );
    expect(parse(sent)).toEqual(body);
    const stored = JSON.stringify(
      world.db
        .prepare('SELECT * FROM source_state')
        .all()
        .concat(world.db.prepare('SELECT * FROM app_meta').all()),
    );
    expect(stored).not.toContain('SENTINEL');
    expect(stored).not.toContain('/etc');
    expect(stored).not.toContain('someone');
  });

  test('both routes sit behind the app header, like every write', async ({ page, world }) => {
    const machine = await mountSetup(page, world);
    for (const path of ['/api/setup/discover', '/api/setup/complete']) {
      const refused = await answerApi(machine.api, {
        method: 'POST',
        path,
        headers: {},
        body: null,
      });
      expect(refused.status, path).toBe(403);
    }
    expect(count(world, 'refresh_run')).toBe(0);
    expect(
      parse<{ setupComplete: boolean }>(
        await answerApi(world.app, { method: 'GET', path: '/api/bootstrap', headers: {} }),
      ).setupComplete,
    ).toBe(false);
  });

  test('Finish with a run already going (the boot’s first run) attaches to it and starts no second', async ({
    page,
    world,
  }) => {
    const machine = await mountSetup(page, world);
    const started = machine.runner.start({ trigger: 'scheduler' });
    expect(started.started).toBe(true);
    const answer = await post(machine.api, '/api/setup/complete');
    expect(answer.status).toBe(202);
    expect(parse<{ id: number }>(answer).id).toBe(started.started ? started.run.id : -1);
    expect(count(world, 'refresh_run')).toBe(1);
    machine.held.release();
    await machine.runner.idle();
  });

  test('finds `codex` by looking at the PATH folders, never by running it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-path-'));
    try {
      const bin = join(root, 'bin');
      const other = join(root, 'other');
      mkdirSync(bin);
      mkdirSync(other);
      // A program that would leave a mark if it were ever run: it is only looked at.
      const mark = join(root, 'was-run');
      writeFileSync(join(bin, 'codex'), `#!/bin/sh\ntouch '${mark}'\n`);
      chmodSync(join(bin, 'codex'), 0o755);
      expect(await findOnPath('codex', { PATH: `${other}:${bin}` })).toBe(true);
      expect(await findOnPath('codex', { PATH: `${other}:${join(root, 'missing')}` })).toBe(false);
      expect(await findOnPath('codex', {})).toBe(false);
      // A file that is not runnable, and a folder with the name, are not a program.
      writeFileSync(join(other, 'codex'), 'not runnable');
      chmodSync(join(other, 'codex'), 0o644);
      expect(await findOnPath('codex', { PATH: other })).toBe(false);
      mkdirSync(join(root, 'dir-bin', 'codex'), { recursive: true });
      expect(await findOnPath('codex', { PATH: join(root, 'dir-bin') })).toBe(false);
      expect(existsSync(mark)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---- a setup that was finished long ago ----

test.describe('Finish on a setup that is already finished', () => {
  // The typical seeded world: setup finished, and one finished run in the history.
  test.use({ worldOptions: {} });

  test('answers the latest finished run and starts none, however many runs there have been', async ({
    page,
    world,
  }) => {
    const machine = await mountSetup(page, world, { hold: false });
    const seeded = count(world, 'refresh_run');
    expect(seeded).toBeGreaterThan(0);
    const newest = () =>
      (world.db.prepare('SELECT MAX(id) AS id FROM refresh_run').get() as { id: number }).id;

    const first = await post(machine.api, '/api/setup/complete');
    expect(first.status).toBe(202);
    expect(parse<{ id: number }>(first).id).toBe(newest());
    expect(count(world, 'refresh_run')).toBe(seeded);

    // More runs happen (the timer, a Refresh); a repeat Finish still answers the newest and starts nothing.
    for (let run = 0; run < 3; run += 1) {
      expect(machine.runner.start({ trigger: 'manual' }).started).toBe(true);
      await machine.runner.idle();
    }
    expect(count(world, 'refresh_run')).toBe(seeded + 3);
    const again = parse<{ id: number; state: string }>(
      await post(machine.api, '/api/setup/complete'),
    );
    expect(again.id).toBe(newest());
    expect(again.id).toBe(seeded + 3);
    expect(again.state).not.toBe('running');
    expect(count(world, 'refresh_run')).toBe(seeded + 3);
  });

  test('starts one only if there has never been a run', async ({ page, world }) => {
    const machine = await mountSetup(page, world, { hold: false });
    world.db.exec('DELETE FROM refresh_run');
    const answer = await post(machine.api, '/api/setup/complete');
    expect(answer.status).toBe(202);
    await machine.runner.idle();
    expect(count(world, 'refresh_run')).toBe(1);
    const once = await post(machine.api, '/api/setup/complete');
    expect(parse<{ id: number }>(once).id).toBe(parse<{ id: number }>(answer).id);
    expect(count(world, 'refresh_run')).toBe(1);
  });
});

// ---- the look of it ----

test.describe('the look of it', () => {
  // The signed-out flow exercises the compact choice, optional App guide and the repository prerequisite.
  test.use({ worldOptions: { firstLaunch: true, ghSignedIn: false } });

  /** Opens one step of Setup at the width and waits until the page is still. */
  async function openStep(
    page: Page,
    world: World,
    step: 1 | 2 | 3,
    width: number,
    ghSignedIn = false,
  ): Promise<void> {
    await page.setViewportSize({ width, height: 900 });
    await mountSetup(page, world, { ghSignedIn });
    await openFirstLaunch(page);
    await lookDone(page);
    if (step > 1) await button(page, 'Continue').click();
    if (step > 2) {
      const next = button(page, ghSignedIn ? 'Continue' : 'Continue without GitHub');
      if (ghSignedIn) {
        await expect(
          accountRow(page, 'GitHub').getByText('Using your existing sign-in'),
        ).toBeVisible();
      }
      await next.click();
    }
    await page.evaluate(async () => {
      await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
    });
  }

  test.describe('with an existing GitHub sign-in', () => {
    test.use({ worldOptions: { firstLaunch: true, ghSignedIn: true } });

    for (const width of [390, 320]) {
      test(`step 3 at ${width}px: the direct action is under the picker field, at the left`, async ({
        page,
        world,
      }) => {
        await openStep(page, world, 3, width, true);
        await page.getByLabel('Find a repository').fill('kelvin/no-such-repo');
        const field = (await page.getByLabel('Find a repository').boundingBox())!;
        const add = (await card(page, REPOS_CARD)
          .getByRole('button', { name: 'Track kelvin/no-such-repo directly' })
          .boundingBox())!;
        expect(add.y).toBeGreaterThanOrEqual(field.y + field.height - 1);
        expect(Math.abs(add.x - field.x)).toBeLessThanOrEqual(1);
      });
    }
  });

  // SETUP_STEPPER_MAPPING: D7 draws the indicator as three pills that wrap, and TECH (design-to-code › Setup indicator reconciliation)
  // supersedes the Astryx Stepper mapping. The product had a connected progress track, vertical on a phone. These read the RENDERED
  // geometry at the three widths on every step, so a return to a track (or to a phone-only column) fails them.
  interface PillRead {
    text: string;
    current: boolean;
    marker: string;
    markerHasCheck: boolean;
    doneWords: string;
    x: number;
    y: number;
    width: number;
    height: number;
    padding: string;
    radius: number;
    background: string;
    clipped: boolean;
    ellipsis: boolean;
    focusable: number;
  }

  async function readPills(page: Page): Promise<{
    pills: PillRead[];
    listFlex: {
      display: string;
      wrap: string;
      direction: string;
      columnGap: string;
      rowGap: string;
    };
    children: string[];
    sideways: number;
    viewport: number;
  }> {
    return stepper(page).evaluate((list) => {
      const style = getComputedStyle(list);
      const pills = Array.from(list.children).map((li) => {
        const box = li.getBoundingClientRect();
        const lis = getComputedStyle(li);
        const marker = li.querySelector<HTMLElement>('span[aria-hidden="true"]');
        return {
          text: (li.textContent ?? '').trim(),
          current: li.getAttribute('aria-current') === 'step',
          marker: (marker?.textContent ?? '').trim(),
          markerHasCheck: marker?.querySelector('svg path') != null,
          doneWords: li.querySelector('.sr-only')?.textContent ?? '',
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          padding: `${lis.paddingTop} ${lis.paddingRight} ${lis.paddingBottom} ${lis.paddingLeft}`,
          radius: parseFloat(lis.borderTopLeftRadius),
          background: lis.backgroundColor,
          clipped: li.scrollWidth > li.clientWidth + 1,
          ellipsis: lis.textOverflow === 'ellipsis',
          focusable: li.querySelectorAll('a, button, input, select, textarea, [tabindex]').length,
        };
      });
      return {
        pills,
        listFlex: {
          display: style.display,
          wrap: style.flexWrap,
          direction: style.flexDirection,
          columnGap: style.columnGap,
          rowGap: style.rowGap,
        },
        children: Array.from(list.children).map((child) => child.tagName),
        sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        viewport: window.innerWidth,
      };
    });
  }

  const PILL_LABELS = ['Local sources', 'Accounts', 'Repositories'];

  for (const width of [1280, 390, 320]) {
    test(
      `the Setup indicator is D7's three wrapping pills at ${width}px on every step: no connected track, no vertical column, no cut label`,
      { tag: '@responsive' },
      async ({ page, world }) => {
        await openStep(page, world, 1, width);
        for (const step of [1, 2, 3] as const) {
          if (step > 1) {
            await button(page, step === 3 ? 'Continue without GitHub' : 'Continue').click();
            await expect(current(page)).toContainText(PILL_LABELS[step - 1]!);
          }
          const read = await readPills(page);
          const at = `step ${step} at ${width}px`;

          // The list: three items and nothing else (no rail, no connector, no progress bar), a wrapping row of the design's 8px gap.
          expect(read.children, at).toEqual(['LI', 'LI', 'LI']);
          expect(read.listFlex, at).toEqual({
            display: 'flex',
            wrap: 'wrap',
            direction: 'row',
            columnGap: '8px',
            rowGap: '8px',
          });
          expect(
            read.pills.map((p) => PILL_LABELS.find((label) => p.text.includes(label))),
            at,
          ).toEqual(PILL_LABELS);

          // Semantics: exactly one item is the current step, the ones before it are done (a check and the words "(done)"), the rest show their number.
          expect(
            read.pills.map((p) => p.current),
            at,
          ).toEqual([0, 1, 2].map((i) => i === step - 1));
          read.pills.forEach((pill, i) => {
            const done = i < step - 1;
            expect(pill.markerHasCheck, `${at}, ${pill.text}`).toBe(done);
            expect(pill.doneWords, `${at}, ${pill.text}`).toBe(done ? ' (done)' : '');
            expect(pill.marker, `${at}, ${pill.text}`).toBe(done ? '' : String(i + 1));
            expect(pill.text, `${at}, ${pill.text}`).toBe(
              done ? `${PILL_LABELS[i]} (done)` : `${i + 1}${PILL_LABELS[i]}`,
            );
          });

          // Each is a pill with D7's padding (6px, 12px, 6px, 6px), content-sized (a track would stretch them to a third of the column each).
          for (const pill of read.pills) {
            expect(pill.padding, `${at}, ${pill.text}`).toBe('6px 12px 6px 6px');
            expect(pill.radius, `${at}, ${pill.text}`).toBeGreaterThanOrEqual(pill.height / 2);
            expect(pill.background, `${at}, ${pill.text}`).not.toBe('rgba(0, 0, 0, 0)');
            expect(pill.width, `${at}, ${pill.text}`).toBeLessThan(180);
            expect(pill.height, `${at}, ${pill.text}`).toBeLessThan(40);
            // Whole label, whole pill: nothing cut, nothing ellipsised, and no keyboard stop or control inside.
            expect(pill.clipped, `${at}, ${pill.text}`).toBe(false);
            expect(pill.ellipsis, `${at}, ${pill.text}`).toBe(false);
            expect(pill.focusable, `${at}, ${pill.text}`).toBe(0);
            expect(pill.x + pill.width, `${at}, ${pill.text}`).toBeLessThanOrEqual(read.viewport);
          }
          expect(read.sideways, at).toBeLessThanOrEqual(1);

          // The arrangement: one row at 1280; on a phone the first two share a row and Repositories wraps below (flex-wrap at the pill
          // boundary), never one column of three. Neighbours on a row are 8px apart.
          const [a, b, c] = read.pills as [PillRead, PillRead, PillRead];
          expect(Math.abs(a.y - b.y), at).toBeLessThanOrEqual(1);
          expect(b.x - (a.x + a.width), at).toBeCloseTo(8, 0);
          if (width >= 720) {
            expect(Math.abs(b.y - c.y), at).toBeLessThanOrEqual(1);
            expect(c.x - (b.x + b.width), at).toBeCloseTo(8, 0);
          } else {
            expect(c.y - (a.y + a.height), at).toBeCloseTo(8, 0);
            expect(Math.abs(c.x - a.x), at).toBeLessThanOrEqual(1);
          }
        }
      },
    );
  }

  test('the indicator follows Skip and Back with the body and the app bar, and a skipped step is passed, not connected', async ({
    page,
    world,
  }) => {
    await openStep(page, world, 1, 1280);
    const banner = page.getByRole('banner');
    const states = async () =>
      (await readPills(page)).pills.map((p) => [p.current, p.markerHasCheck]);

    expect(await states()).toEqual([
      [true, false],
      [false, false],
      [false, false],
    ]);
    // Skip passes step 1 without finding anything: it is done in the list's sense (passed), and nothing was connected.
    await button(page, 'Skip this step').click();
    await expect(banner.getByText('Step 2 of 3', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: ACCOUNTS_CARD })).toBeFocused();
    expect(await states()).toEqual([
      [false, true],
      [true, false],
      [false, false],
    ]);
    await button(page, 'Continue without GitHub').click();
    await expect(banner.getByText('Step 3 of 3', { exact: true })).toBeVisible();
    expect(await states()).toEqual([
      [false, true],
      [false, true],
      [true, false],
    ]);
    // Back recomputes the markers from the new position, and the page never leaves a pill focused.
    await button(page, 'Back to accounts').click();
    await expect(banner.getByText('Step 2 of 3', { exact: true })).toBeVisible();
    expect(await states()).toEqual([
      [false, true],
      [true, false],
      [false, false],
    ]);
    await button(page, 'Back').click();
    expect(await states()).toEqual([
      [true, false],
      [false, false],
      [false, false],
    ]);
    expect(await page.evaluate(() => document.activeElement?.closest('ol') ?? null)).toBeNull();
  });

  for (const width of [1280, 390, 320]) {
    for (const step of [1, 2, 3] as const) {
      test(
        `step ${step} fits at ${width}px, has no axe violations, and on a phone has 44px buttons`,
        { tag: ['@a11y', '@responsive'] },
        async ({ page, world }) => {
          await openStep(page, world, step, width);
          expect(failures(await measureContainment(page))).toEqual([]);
          const { violations } = await new AxeBuilder({ page }).analyze();
          expect(
            violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
          ).toEqual([]);
          if (step === 2) {
            const github = accountRow(page, 'GitHub');
            await github.getByRole('button', { name: 'Connect GitHub' }).click();
            await github.getByText('Register your GitHub App (one time)').click();
            expect(failures(await measureContainment(page))).toEqual([]);
            expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
          }
          if (width < 720) {
            const small = await page.evaluate(() =>
              Array.from(document.querySelectorAll('main button'))
                .filter((el) => el.getBoundingClientRect().height > 0)
                .map((el) => ({
                  name: el.textContent?.trim() ?? '',
                  h: Math.round(el.getBoundingClientRect().height),
                }))
                .filter((b) => b.h < 44),
            );
            // The nav buttons (Back, Skip, Continue, Finish) are the page's own; the in-row small buttons are listed for the owner of the pattern.
            expect(
              small.filter((b) =>
                /^(Back|Back to accounts|Skip this step|Continue|Continue without GitHub|Finish setup)$/.test(
                  b.name,
                ),
              ),
            ).toEqual([]);
          }
        },
      );
    }
  }
});
