import AxeBuilder from '@axe-core/playwright';
import { writeFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { replaceRateLimits } from '../../src/server/db/queries/accounts.ts';
import { FIXED_NOW } from '../fixtures/seed.ts';
import { expect, test } from './fixtures';
import { cutLabels, failures, measureContainment } from './helpers/containment';
import { ORIGIN } from './helpers/virtualOrigin';

// Exercise account actions through the production build and real API. Codex and Claude plan responses
// come from the scripted world, with temporary Claude Code settings for legacy removal.
const CAPTION = 'This signs Codex in on this computer too.';
const SIGN_IN_URL = 'https://auth.example.test/oauth/authorize?state=SENTINEL_STATE_e2';

const section = (page: Page): Locator =>
  page.getByRole('region', { name: 'Accounts', exact: true });
/** One account's row. The list is the section's own: the preview's notes are a list inside a row, not a row. */
const row = (page: Page, name: 'ChatGPT' | 'Claude'): Locator =>
  section(page)
    .locator(':scope > ul > li')
    .filter({
      has: page.getByText(name === 'Claude' ? 'Claude plan limits' : name, { exact: true }),
    });
const checkPlan = (page: Page, again = false): Locator =>
  row(page, 'Claude').getByRole('button', {
    name: again ? 'Check again' : 'Show Claude plan limits',
    exact: true,
  });
const removeHook = (page: Page): Locator =>
  row(page, 'Claude').getByRole('button', { name: 'Remove old status line', exact: true });
const panel = (page: Page): Locator =>
  row(page, 'Claude').getByRole('group', { name: /Claude capture removal/ });
const card = (page: Page, name: string): Locator => page.getByRole('region', { name, exact: true });
const overviewCards = (page: Page): Locator =>
  card(page, 'Account-reported usage').getByRole('listitem');
/** A toast, found in the visible notifications (Astryx also repeats its words in a hidden live region for screen readers). */
const toastWith = (page: Page, text: string): Locator =>
  page.getByRole('region', { name: 'Notifications' }).getByText(text);

test.beforeEach(async ({ page, world }) => {
  void world;
  await page.clock.setFixedTime(new Date(FIXED_NOW));
});

/**
 * Runs axe on the page once it has settled, and says what it found (an empty list is a clean page).
 *
 * When the preview lands, the Verify removal button stops being `aria-disabled` and Astryx fades it from 70% to full opacity over about
 * 150 ms. axe skips an `aria-disabled` control but reads an enabled one at its colour of that instant, so a scan that falls inside
 * the fade reports a contrast failure (4.4 against 4.5 at 79% opacity) that nobody sees on the settled screen. It showed as one
 * failure in about 300 runs under load, always on that button. Waiting for every running transition and animation to end first
 * makes the scan read the screen as it stays; an animation that never ends (a spinner) is not waited for.
 */
async function axeViolations(page: Page): Promise<string[]> {
  await page.evaluate(async () => {
    for (let round = 0; round < 5; round++) {
      const running = document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity);
      if (running.length === 0) return;
      await Promise.all(running.map((animation) => animation.finished.catch(() => undefined)));
    }
  });
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

/** The left edge of an element: used to say which of two buttons is on the left. */
async function leftOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('the element has no box, so it is not on screen');
  return box.x;
}

/** Every visible control inside `root` that is under 44px in either direction: what a finger cannot be expected to hit. */
async function smallTargets(root: Locator): Promise<string[]> {
  return root.evaluate((element) => {
    const controls =
      'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="switch"], summary';
    const small: string[] = [];
    for (const el of Array.from(element.querySelectorAll(controls))) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      let { width, height } = rect;
      // A hit area drawn as a pseudo-element counts, as it does for a finger.
      for (const pseudo of ['::before', '::after']) {
        const grown = getComputedStyle(el, pseudo);
        if (grown.content !== 'none' && grown.position === 'absolute') {
          width = Math.max(width, parseFloat(grown.width) || 0);
          height = Math.max(height, parseFloat(grown.height) || 0);
        }
      }
      if (width < 44 || height < 44) {
        small.push(
          `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 30)}" ${Math.round(width)}x${Math.round(height)}`,
        );
      }
    }
    return small;
  });
}

/** Records every address the page asks the browser to open, instead of opening a tab. */
async function recordOpenedTabs(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const opened: string[] = [];
    (window as unknown as { __opened: string[] }).__opened = opened;
    window.open = (url?: string | URL) => {
      opened.push(String(url));
      return null;
    };
  });
  return () => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
}

/** Answers the sign-in poll "pending" until `release()`, then lets the real server answer. */
async function holdSignIn(page: Page): Promise<{ release: () => void }> {
  let held = true;
  await page.route(/\/api\/accounts\/chatgpt\/connect\/[^/]+$/, async (route) => {
    if (held) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ state: 'pending' }),
      });
      return;
    }
    await route.fallback();
  });
  return {
    release: () => {
      held = false;
    },
  };
}

async function verifyRemoval(page: Page): Promise<void> {
  await panel(page).getByRole('button', { name: 'Verify removal', exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(removeHook(page)).toHaveCount(0);
}

// ===========================================================================================================================
// Sources: ChatGPT
// ===========================================================================================================================

test.describe('the ChatGPT row', () => {
  test('says Not connected, and Connect carries the sign-in disclosure beside it', async ({
    page,
  }) => {
    await page.goto(`${ORIGIN}/sources`);
    const chatgpt = row(page, 'ChatGPT');
    await expect(chatgpt).toBeVisible();
    await expect(chatgpt.getByText('Not connected', { exact: true })).toBeVisible();
    await expect(chatgpt).toContainText('Optional · account-reported Codex usage');
    await expect(chatgpt).toContainText('Usage report: none until connected');

    const connect = chatgpt.getByRole('button', { name: 'Connect ChatGPT' });
    const caption = chatgpt.getByText(CAPTION, { exact: true });
    await expect(connect).toBeVisible();
    await expect(caption).toBeVisible();
    // The disclosure is read with the button, not only seen near it.
    await expect(connect).toHaveAccessibleDescription(CAPTION);
    // It sits in the button's own column, under it, so it cannot be missed.
    const buttonBox = await connect.boundingBox();
    const captionBox = await caption.boundingBox();
    expect(buttonBox && captionBox && captionBox.y >= buttonBox.y + buttonBox.height - 1).toBe(
      true,
    );
  });

  test('Connect starts the sign-in, opens its page and waits for the server before it says connected', async ({
    page,
    world,
  }) => {
    world.chatgpt.useScenario('login-ok');
    const opened = await recordOpenedTabs(page);
    const signIn = await holdSignIn(page);
    await page.goto(`${ORIGIN}/sources`);

    await row(page, 'ChatGPT').getByRole('button', { name: 'Connect ChatGPT' }).click();

    const waiting = row(page, 'ChatGPT').getByRole('group', {
      name: 'Finish signing in to ChatGPT',
    });
    await expect(waiting).toBeVisible();
    await expect(waiting.getByText('Waiting for sign-in…')).toBeVisible();
    // The sign-in page was opened in its own tab, and the panel keeps its link in case the browser refused the tab.
    expect(await opened()).toEqual([SIGN_IN_URL]);
    const open = waiting.getByRole('link', { name: 'Open the ChatGPT sign-in page' });
    await expect(open).toHaveAttribute('href', SIGN_IN_URL);
    await expect(open).toHaveAttribute('target', '_blank');
    await expect(open).toHaveAttribute('rel', /noopener/);
    // Cancel on the left, the primary action on the right.
    const cancel = waiting.getByRole('button', { name: 'Cancel' });
    expect(await leftOf(cancel)).toBeLessThan(await leftOf(open));
    // The Connect button went with the focus it had: the panel's heading has it.
    await expect(
      waiting.getByRole('heading', { name: 'Finish signing in to ChatGPT' }),
    ).toBeFocused();
    // Nothing says connected yet: the server has not been asked about the sign-in's end.
    await expect(toastWith(page, 'ChatGPT connected. Usage report updated.')).toHaveCount(0);

    signIn.release();
    await expect(toastWith(page, 'ChatGPT connected. Usage report updated.')).toBeVisible();
    await expect(waiting).toHaveCount(0);
  });

  test('a sign-in that finishes is read as a connection: Connected, a report, and Disconnect', async ({
    page,
    world,
  }) => {
    // Codex signs in at once, then a read finds the usage (the scenario that has usage).
    world.chatgpt.useScenario('login-ok');
    await page.goto(`${ORIGIN}/sources`);
    await row(page, 'ChatGPT').getByRole('button', { name: 'Connect ChatGPT' }).click();
    await expect(toastWith(page, 'ChatGPT connected. Usage report updated.')).toBeVisible();

    world.chatgpt.useScenario('chatgpt-with-threads');
    await world.chatgpt.read();
    await page.reload();

    const chatgpt = row(page, 'ChatGPT');
    await expect(chatgpt.getByText('Connected', { exact: true })).toBeVisible();
    await expect(chatgpt).toContainText('Connected through Codex');
    await expect(chatgpt.getByRole('button', { name: 'Disconnect' })).toBeVisible();
    await expect(chatgpt.getByRole('button', { name: /^Connect ChatGPT$/ })).toHaveCount(0);
    // A connected row does not repeat the disclosure: nothing is being started.
    await expect(chatgpt.getByText(CAPTION)).toHaveCount(0);

    await page.getByRole('link', { name: 'Overview' }).first().click();
    const overview = overviewCards(page).nth(0);
    await expect(overview.getByText('Connected', { exact: true })).toBeVisible();
    await expect(overview.getByRole('link')).toHaveCount(0);
  });

  test('an existing Codex sign-in is used, and nothing is asked of the owner', async ({
    page,
    world,
  }) => {
    const opened = await recordOpenedTabs(page);
    await page.goto(`${ORIGIN}/sources`);
    await row(page, 'ChatGPT').getByRole('button', { name: 'Connect ChatGPT' }).click();

    await expect(toastWith(page, 'Using your existing Codex sign-in.')).toBeVisible();
    expect(await opened()).toEqual([]);
    await world.chatgpt.read();
    await page.reload();
    await expect(row(page, 'ChatGPT').getByRole('button', { name: 'Disconnect' })).toBeVisible();
  });

  test('Disconnect stops the dashboard reading; it does not sign Codex out', async ({
    page,
    world,
  }) => {
    await world.chatgpt.read();
    await page.goto(`${ORIGIN}/sources`);
    const chatgpt = row(page, 'ChatGPT');
    await expect(chatgpt.getByRole('button', { name: 'Disconnect' })).toBeVisible();

    await chatgpt.getByRole('button', { name: 'Disconnect' }).click();

    await expect(
      toastWith(
        page,
        'ChatGPT disconnected. Codex stays signed in, and what was imported stays on this machine.',
      ),
    ).toBeVisible();
    await expect(chatgpt.getByText('Not connected', { exact: true })).toBeVisible();
    // The button that replaced Disconnect has the focus it had, and says what it does.
    const connect = chatgpt.getByRole('button', { name: 'Connect ChatGPT' });
    await expect(connect).toBeFocused();
    await expect(connect).toHaveAccessibleDescription(CAPTION);
  });

  test('a computer with no Codex says so, and the row says it is unavailable', async ({
    page,
    world,
  }) => {
    world.chatgpt.useScenario(null);
    await page.goto(`${ORIGIN}/sources`);
    const chatgpt = row(page, 'ChatGPT');
    await chatgpt.getByRole('button', { name: 'Connect ChatGPT' }).click();

    await expect(chatgpt.getByRole('alert')).toContainText(
      'Codex isn’t installed on this computer, so ChatGPT can’t be connected here. Install Codex, then try again.',
    );
    // The server now knows there is no Codex, so the row stops offering a sign-in that cannot start: it says why instead.
    await expect(chatgpt.getByText('Unavailable', { exact: true })).toBeVisible();
    await expect(chatgpt).toContainText('Unavailable: Codex CLI not found');
    await expect(chatgpt.getByRole('button', { name: 'Connect ChatGPT' })).toHaveCount(0);
    await expect(toastWith(page, 'ChatGPT connected. Usage report updated.')).toHaveCount(0);
  });

  test('a sign-in Codex refuses is said in words, and Connect is offered again', async ({
    page,
    world,
  }) => {
    world.chatgpt.useScenario('login-denied');
    await page.goto(`${ORIGIN}/sources`);
    const chatgpt = row(page, 'ChatGPT');
    await chatgpt.getByRole('button', { name: 'Connect ChatGPT' }).click();

    await expect(chatgpt.getByRole('alert')).toContainText(
      'ChatGPT didn’t complete the sign-in. Start again.',
    );
    await expect(chatgpt.getByRole('button', { name: 'Connect ChatGPT' })).toBeVisible();
    await expect(toastWith(page, 'ChatGPT connected. Usage report updated.')).toHaveCount(0);
    // The refused sentence is Codex's own: none of it reaches the page.
    await expect(page.getByText('SENTINEL_NOTE_f3')).toHaveCount(0);
  });

  test('Cancel ends a sign-in that is waiting', async ({ page, world }) => {
    world.chatgpt.useScenario('login-ok');
    await recordOpenedTabs(page);
    await holdSignIn(page);
    await page.goto(`${ORIGIN}/sources`);
    const chatgpt = row(page, 'ChatGPT');
    await chatgpt.getByRole('button', { name: 'Connect ChatGPT' }).click();
    const waiting = chatgpt.getByRole('group', { name: 'Finish signing in to ChatGPT' });
    await expect(waiting).toBeVisible();

    await waiting.getByRole('button', { name: 'Cancel' }).click();

    await expect(waiting).toHaveCount(0);
    await expect(chatgpt.getByRole('button', { name: 'Connect ChatGPT' })).toBeFocused();
    await expect(chatgpt.getByText('Not connected', { exact: true })).toBeVisible();
  });
});

// ===========================================================================================================================
// Sources: Claude plan checks and legacy hook removal
// ===========================================================================================================================

test.describe('Claude plan limits in Sources', () => {
  test('checks only on explicit request and displays each window with its own reset', async ({
    page,
    world,
  }) => {
    world.claude.writeSettings({
      theme: 'dark',
      statusLine: { type: 'command', command: 'echo mine' },
    });
    const settings = world.claude.settings();
    const checkRequests: { method: string; body: unknown; guard: string | undefined }[] = [];
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`${ORIGIN}/api/accounts/claude/plan-limits/check`, async (route) => {
      const request = route.request();
      checkRequests.push({
        method: request.method(),
        body: request.postDataJSON(),
        guard: request.headers()['x-agent-productivity-request'],
      });
      await pending;
      await route.fallback();
    });
    await page.goto(`${ORIGIN}/sources`);
    const claude = row(page, 'Claude');
    await expect(claude).toContainText('Not checked');
    await expect(claude.getByRole('link', { name: 'View usage on Claude.ai' })).toHaveAttribute(
      'href',
      'https://claude.ai/settings/usage',
    );
    await expect(removeHook(page)).toHaveCount(0);
    expect(checkRequests).toHaveLength(0);
    expect(world.claude.planRequests()).toBe(0);

    await checkPlan(page).focus();
    await page.keyboard.press('Enter');
    try {
      await expect(checkPlan(page)).toBeDisabled();
      await expect(checkPlan(page)).toBeFocused();
      await expect(claude.getByRole('status').filter({ hasText: 'Checking…' })).toBeVisible();
      expect(checkRequests).toEqual([{ method: 'POST', body: {}, guard: '1' }]);
    } finally {
      release();
    }

    await expect(checkPlan(page, true)).toBeEnabled();
    await expect(checkPlan(page, true)).toBeFocused();
    await expect(claude).toContainText('Weekly · 62% used · resets Nov 5, 9:42 AM');
    await expect(claude).toContainText('5-hour · 23% used · resets today, 10:42 AM');
    await expect(claude).toContainText('Last checked today, 9:42 AM');
    await expect(claude).not.toContainText('macOS may ask for Keychain access');
    expect(world.claude.settings()).toBe(settings);

    await page.getByRole('link', { name: 'Overview' }).first().click();
    const card = overviewCards(page).nth(1);
    await expect(card).toContainText('62%');
    await expect(card).toContainText('Last checked today, 9:42 AM');
    await expect(card.getByText('5-hour window: 23% · resets today, 10:42 AM')).toBeVisible();
    expect(world.claude.planRequests()).toBe(1);
  });

  test('a plan-check connection error is visible when source collection succeeds', async ({
    page,
    world,
  }) => {
    await world.claude.check();
    await page.route(`${ORIGIN}/api/accounts/claude/plan-limits/check`, (route) =>
      route.abort('connectionfailed'),
    );
    await page.goto(`${ORIGIN}/sources`);
    await page.getByRole('button', { name: 'Refresh all', exact: true }).click();
    await expect(
      toastWith(page, 'Couldn’t reach the Claude plan check. Retry in Sources.'),
    ).toBeVisible();
    await expect(toastWith(page, 'Refreshed all sources · no duplicates.')).toBeVisible();
  });

  test('only the two global refresh buttons recheck enabled Claude limits', async ({
    page,
    world,
  }) => {
    const requests: unknown[] = [];
    await page.route(`${ORIGIN}/api/accounts/claude/plan-limits/check`, (route) => {
      requests.push(route.request().postDataJSON());
      return route.fallback();
    });
    await page.goto(`${ORIGIN}/sources`);
    const claude = row(page, 'Claude');
    const refreshAll = page.getByRole('button', { name: 'Refresh all', exact: true });
    await expect(claude).toContainText('After the first successful check');
    await expect(checkPlan(page)).toHaveAccessibleDescription(/Refresh and Refresh all/);
    await refreshAll.click();
    await expect(toastWith(page, 'Refreshed all sources · no duplicates.')).toBeVisible();
    expect(requests).toEqual([{ mode: 'refresh' }]);
    expect(world.claude.planRequests()).toBe(0);

    await checkPlan(page).click();
    await expect(claude).toContainText('62% used');
    expect(world.claude.planRequests()).toBe(1);
    await page.reload();
    await expect(claude).toContainText('62% used');
    const localClaude = page
      .getByRole('region', { name: 'On this machine', exact: true })
      .getByRole('listitem')
      .filter({ has: page.getByText('Claude Code', { exact: true }) });
    const localRefresh = localClaude.getByRole('button', { name: 'Refresh', exact: true });
    await localRefresh.click();
    await expect(toastWith(page, 'Claude Code: This source can’t be refreshed yet.')).toBeVisible();
    expect(world.claude.planRequests()).toBe(1);
    expect(requests).toEqual([{ mode: 'refresh' }, {}]);

    world.claude.usePlanResponse(() =>
      Response.json({ seven_day: { utilization: 79, resets_at: null } }),
    );
    await refreshAll.click();
    await expect(claude).toContainText('79% used');
    expect(world.claude.planRequests()).toBe(2);
    await page.getByRole('link', { name: 'Overview' }).first().click();
    const overview = overviewCards(page).nth(1);
    await expect(overview).toContainText('79%');
    await expect(overview.getByText('5-hour window unavailable.')).toBeVisible();
    world.claude.usePlanResponse(() =>
      Response.json({ seven_day: { utilization: 86, resets_at: null } }),
    );
    const refresh = page.getByRole('banner').getByRole('button', { name: 'Refresh', exact: true });
    await expect(refresh).toHaveAccessibleDescription(/recheck any previously enabled Claude/);
    await refresh.click();
    await expect(overview).toContainText('86%');
    expect(world.claude.planRequests()).toBe(3);
    expect(requests).toEqual([{ mode: 'refresh' }, {}, { mode: 'refresh' }, { mode: 'refresh' }]);
  });

  for (const [scenario, expected] of [
    ['signed_out', 'Sign in with your subscription in Claude Code on this machine'],
    ['unsupported', 'Use a Claude subscription sign-in in Claude Code'],
    ['reconnect', 'Renew your sign-in in Claude Code on this machine'],
    ['credential_denied', 'Allow access to the Claude Code sign-in in macOS'],
  ] as const) {
    test(`shows an inline next step when the Claude sign-in is ${scenario}`, async ({
      page,
      world,
    }) => {
      world.claude.useCredential(scenario);
      await page.goto(`${ORIGIN}/sources`);
      await checkPlan(page).click();

      await expect(row(page, 'Claude').getByRole('alert')).toContainText(expected);
      await expect(checkPlan(page, true)).toBeEnabled();
      expect(world.claude.planRequests()).toBe(0);
    });
  }

  test('keeps the previous report and honors the provider cooldown', async ({ page, world }) => {
    await world.claude.check();
    const firstCheck = FIXED_NOW + 60_000;
    world.setNow(firstCheck);
    await page.clock.setFixedTime(new Date(firstCheck));
    world.claude.usePlanResponse(
      () =>
        new Response(null, {
          status: 429,
          headers: { 'Retry-After': '120' },
        }),
    );
    await page.goto(`${ORIGIN}/sources`);
    await checkPlan(page, true).click();

    const claude = row(page, 'Claude');
    await expect(claude.getByRole('alert')).toContainText('Try again today, 9:45 AM.');
    await expect(claude).toContainText('62% used');
    await expect(claude).toContainText('Saved limits from today, 9:42 AM');
    await expect(checkPlan(page, true)).toBeDisabled();
    await page.reload();
    await expect(checkPlan(page, true)).toBeDisabled();
    expect(world.claude.planRequests()).toBe(2);

    world.setNow(firstCheck + 120_000);
    await page.clock.setFixedTime(new Date(firstCheck + 120_000));
    await page.reload();
    await expect(checkPlan(page, true)).toBeEnabled();
    expect(world.claude.planRequests()).toBe(2);
  });

  test('labels a legacy report until a successful plan check replaces it', async ({
    page,
    world,
  }) => {
    replaceRateLimits(
      world.db,
      'claude',
      [
        {
          limitId: 'seven_day',
          usedPercent: 31,
          windowMinutes: 10_080,
          resetsAt: FIXED_NOW + 86_400_000,
        },
      ],
      FIXED_NOW - 60_000,
    );
    await page.goto(`${ORIGIN}/`);
    const card = overviewCards(page).nth(1);
    await expect(card).toContainText('31%');
    await expect(card).toContainText('Saved status-line snapshot from today, 9:41 AM');

    await card.getByRole('link', { name: 'Check Claude plan limits in Sources' }).click();
    const claude = row(page, 'Claude');
    await expect(claude).toContainText('Saved status-line snapshot from today, 9:41 AM');
    await expect(removeHook(page)).toHaveCount(0);
    await checkPlan(page).click();
    await expect(claude).toContainText('62%');
    await expect(claude).not.toContainText('Saved status-line snapshot');
  });
});

test.describe('Claude legacy hook removal', () => {
  test('requires a manual edit and verifies the previous status line was restored', async ({
    page,
    world,
  }) => {
    const original = { type: 'command', command: 'echo mine', padding: 2 };
    await world.claude.seedLegacyHook({ theme: 'dark', statusLine: original });
    const wired = world.claude.settings();
    await page.goto(`${ORIGIN}/sources`);

    await removeHook(page).click();
    expect(world.claude.settings()).toBe(wired);
    await panel(page).getByRole('button', { name: 'Verify removal' }).click();
    await expect(panel(page).getByRole('alert')).toContainText('still references the capture hook');
    await expect(panel(page).getByLabel('Previous statusLine value')).toContainText('echo mine');

    world.claude.writeSettings({ theme: 'dark', model: 'opus', statusLine: original });
    const manuallyEdited = world.claude.settings();
    await verifyRemoval(page);
    expect(world.claude.settings()).toBe(manuallyEdited);
    await expect(checkPlan(page)).toBeFocused();
  });

  test('keeps a replacement status line through removal', async ({ page, world }) => {
    await world.claude.seedLegacyHook({ theme: 'dark' });
    world.claude.writeSettings({
      theme: 'dark',
      statusLine: { type: 'command', command: 'echo other' },
    });
    const edited = world.claude.settings();
    await page.goto(`${ORIGIN}/sources`);

    await removeHook(page).click();
    await expect(panel(page)).toContainText('Keep your current settings.');
    await verifyRemoval(page);
    expect(world.claude.settings()).toBe(edited);
  });

  test('shows unreadable settings without changing them', async ({ page, world }) => {
    await world.claude.seedLegacyHook({});
    writeFileSync(world.claude.settingsPath, '{ broken');
    await page.goto(`${ORIGIN}/sources`);
    await removeHook(page).click();

    await expect(panel(page).getByRole('alert')).toContainText('settings file can’t be read');
    expect(world.claude.settings()).toBe('{ broken');
  });
});

// ===========================================================================================================================
// Overview: the account cards
// ===========================================================================================================================

test.describe('the Overview account cards', () => {
  test('disconnected ChatGPT and unchecked Claude offer setup in Sources', async ({ page }) => {
    await page.goto(`${ORIGIN}/`);
    const items = overviewCards(page);
    await expect(items).toHaveCount(2);
    const chatgpt = items.nth(0);
    await expect(chatgpt).toContainText('Not connected');
    await expect(chatgpt.getByRole('link', { name: 'Connect ChatGPT in Sources' })).toBeVisible();
    const claude = items.nth(1);
    await expect(claude).toContainText('Claude plan limits haven’t been checked yet.');
    await expect(claude.getByText('5-hour window unavailable.')).toBeVisible();
    await expect(
      claude.getByRole('link', { name: 'Check Claude plan limits in Sources' }),
    ).toBeVisible();
  });

  test('connected accounts show weekly percentages and separate windows without setup actions', async ({
    page,
    world,
  }) => {
    await world.chatgpt.read();
    await world.claude.check();
    await page.goto(`${ORIGIN}/`);
    const items = overviewCards(page);
    await expect(items).toHaveCount(2);

    const chatgpt = items.nth(0);
    await expect(chatgpt).toContainText('ChatGPT');
    await expect(chatgpt).toContainText('Codex plan');
    await expect(chatgpt).toContainText('Using your existing sign-in');
    await expect(chatgpt).toContainText('41%');
    await expect(chatgpt).toContainText('of weekly usage limit used');
    await expect(chatgpt.getByText('Resets Nov 6, 9:42 AM', { exact: true })).toBeVisible();
    await expect(chatgpt).toContainText('As of today, 9:42 AM');
    await expect(chatgpt).not.toContainText('23%');
    await expect(chatgpt).not.toContainText('tokens');

    const claude = items.nth(1);
    await expect(claude).toContainText('Claude Code plan');
    await expect(claude).toContainText('62%');
    await expect(claude).toContainText('of weekly usage limit used');
    await expect(claude.getByText('Resets Nov 5, 9:42 AM', { exact: true })).toBeVisible();
    await expect(claude.getByText('5-hour window: 23% · resets today, 10:42 AM')).toBeVisible();
    await expect(items.getByRole('link')).toHaveCount(0);
    await expect(items.getByRole('button', { name: /^Why\?/ })).toHaveCount(0);
  });

  test('ChatGPT shows unavailable when only a short limit and daily buckets are stored', async ({
    page,
    world,
  }) => {
    await world.chatgpt.read();
    replaceRateLimits(
      world.db,
      'chatgpt',
      [
        {
          limitId: 'primary',
          usedPercent: 23,
          windowMinutes: 300,
          resetsAt: FIXED_NOW + 3_600_000,
        },
      ],
      FIXED_NOW,
    );
    await page.goto(`${ORIGIN}/`);
    const chatgpt = overviewCards(page).nth(0);
    await expect(chatgpt.getByText('Weekly usage unavailable.')).toBeVisible();
    await expect(chatgpt).not.toContainText(/\d+%|tokens/);
    await expect(chatgpt.getByRole('link')).toHaveCount(0);
  });

  test('evaluates reset times independently in Overview and Sources', async ({ page, world }) => {
    await world.claude.check();

    const twoHoursLater = FIXED_NOW + 2 * 3_600_000;
    await page.clock.setFixedTime(new Date(twoHoursLater));
    world.setNow(twoHoursLater);
    await page.goto(`${ORIGIN}/`);
    const claude = overviewCards(page).nth(1);
    await expect(claude.getByText('5-hour window reset today, 10:42 AM.')).toBeVisible();
    await expect(claude).not.toContainText('23%');
    await expect(claude).toContainText('62%');

    await page.goto(`${ORIGIN}/sources`);
    const sources = row(page, 'Claude');
    await expect(sources).toContainText('5-hour · Window reset');
    await expect(sources).not.toContainText('23%');
    await expect(sources).toContainText('62%');

    await page.clock.setFixedTime(new Date(FIXED_NOW + 2 * 86_400_000));
    await page.goto(`${ORIGIN}/`);
    await expect(overviewCards(page).nth(1)).toContainText('Weekly window reset Nov 5, 9:42 AM.');
    await expect(overviewCards(page).nth(1)).not.toContainText('62%');
  });

  test('repo and date filters leave connected reports alone while the provider filter selects cards', async ({
    page,
    world,
  }) => {
    await world.chatgpt.read();
    await world.claude.check();
    await page.goto(`${ORIGIN}/`);
    await expect(overviewCards(page)).toHaveCount(2);
    const before = await overviewCards(page).allInnerTexts();
    await page.goto(`${ORIGIN}/?repos=kelvin/atlas-api`);
    await expect(overviewCards(page)).toHaveCount(2);
    expect(await overviewCards(page).allInnerTexts()).toEqual(before);

    await page.goto(`${ORIGIN}/?start=2026-09-20&end=2026-09-20`);
    await expect(overviewCards(page)).toHaveCount(2);
    expect(await overviewCards(page).allInnerTexts()).toEqual(before);

    await page.goto(`${ORIGIN}/?provider=codex`);
    await expect(overviewCards(page)).toHaveCount(1);
    await expect(overviewCards(page).first()).toContainText('Codex plan');
  });

  test('a ChatGPT sign-in that needs renewing keeps its last report, marks it stale, and links to Sources', async ({
    page,
    world,
  }) => {
    await world.chatgpt.read();
    world.chatgpt.useScenario('auth-error');
    await world.chatgpt.read();
    await page.goto(`${ORIGIN}/`);

    const chatgpt = overviewCards(page).nth(0);
    await expect(chatgpt.getByText('Reconnect needed', { exact: true })).toBeVisible();
    await expect(chatgpt).toContainText('41%');
    await expect(chatgpt).toContainText(
      'Last report today, 9:42 AM, so these figures may be out of date.',
    );
    await expect(chatgpt).not.toContainText('As of today');
    // The card cannot start a sign-in, so its next step is the page that can.
    await chatgpt.getByRole('link', { name: 'Reconnect ChatGPT in Sources' }).click();
    await expect(page).toHaveURL(`${ORIGIN}/sources`);
    await expect(row(page, 'ChatGPT').getByRole('button', { name: 'Reconnect' })).toBeVisible();
    await expect(row(page, 'ChatGPT').getByText(CAPTION)).toBeVisible();
  });

  test('a ChatGPT card that is not connected links to Sources to connect', async ({ page }) => {
    await page.goto(`${ORIGIN}/`);
    await overviewCards(page)
      .nth(0)
      .getByRole('link', { name: 'Connect ChatGPT in Sources' })
      .click();
    await expect(page).toHaveURL(`${ORIGIN}/sources`);
    await expect(section(page)).toBeVisible();
  });
});

test.describe('managed weekly subscription quota', () => {
  test.use({
    worldOptions: {
      paseoUsage: {
        fetchedAt: new Date(FIXED_NOW).toISOString(),
        providers: [
          {
            providerId: 'codex',
            status: 'available',
            windows: [
              {
                id: 'weekly',
                label: 'Weekly',
                usedPct: 41,
                resetsAt: new Date(FIXED_NOW + 86_400_000).toISOString(),
              },
              { id: 'limit:gpt-x:weekly', label: 'GPT X · Weekly', usedPct: 17 },
            ],
          },
        ],
      },
    },
  });

  test('shows Paseo quota and checks Claude only on request @a11y @responsive', async ({
    page,
    world,
  }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto(`${ORIGIN}/`);
    const quota = card(page, 'Weekly subscription quota');
    await expect(quota).toContainText('41% of general weekly limit used');
    await expect(quota).toContainText('Paseo report');
    await expect(quota).toContainText('GPT X · Weekly · 17% used');
    await expect(quota.getByRole('button', { name: 'Check Codex quota' })).toHaveCount(0);
    const checkClaude = quota.getByRole('button', { name: 'Check Claude Code quota' });
    await expect(checkClaude).toHaveAccessibleDescription(/existing Claude Code sign-in/);
    expect(world.claude.planRequests()).toBe(0);
    await checkClaude.click();
    await expect(quota).toContainText('62% of general weekly limit used');
    await expect(quota).toContainText('Direct Claude Code check');
    expect(world.claude.planRequests()).toBe(1);
    expect(failures(await measureContainment(page))).toEqual([]);
    expect(await axeViolations(page)).toEqual([]);

    await page.goto(`${ORIGIN}/sources`);
    await expect(section(page)).toBeVisible();
    await expect(checkPlan(page)).toHaveCount(0);
    const refresh = page.getByRole('button', { name: 'Refresh all', exact: true });
    await refresh.click();
    await expect(refresh).toBeEnabled();
    expect(world.claude.planRequests()).toBe(1);
  });
});

// ===========================================================================================================================
// Layout and accessibility
// ===========================================================================================================================

test.describe('layout and accessibility', () => {
  for (const width of [1280, 390, 320]) {
    test(`Sources with the preview open stays inside the window and has no axe violations at ${width}px`, async ({
      page,
      world,
    }) => {
      await world.claude.seedLegacyHook({ theme: 'dark' });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${ORIGIN}/sources`);
      await removeHook(page).click();
      await expect(panel(page).getByLabel('Status line now')).toBeVisible();

      expect(failures(await measureContainment(page))).toEqual([]);
      expect(await axeViolations(page)).toEqual([]);
    });

    test(`the Overview account cards, connected, stay inside the window and have no axe violations at ${width}px`, async ({
      page,
      world,
    }) => {
      await world.chatgpt.read();
      await world.claude.check();
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${ORIGIN}/`);
      await expect(overviewCards(page)).toHaveCount(2);
      await expect(card(page, 'Account-reported usage')).toContainText('Not filtered by repo');
      await expect(overviewCards(page).nth(1)).toContainText('of weekly usage limit used');

      expect(failures(await measureContainment(page))).toEqual([]);
      expect(await axeViolations(page)).toEqual([]);
    });

    test(`the Overview account cards, not connected, stay inside the window and have no axe violations at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${ORIGIN}/`);
      await expect(overviewCards(page)).toHaveCount(2);
      await expect(overviewCards(page).nth(0)).toContainText('Not connected');

      expect(failures(await measureContainment(page))).toEqual([]);
      expect(await axeViolations(page)).toEqual([]);
    });
  }

  test('on a phone every control in the accounts section is a 44px target, the preview and the sign-in panel included', async ({
    page,
    world,
  }) => {
    await world.claude.seedLegacyHook({ theme: 'dark' });
    world.chatgpt.useScenario('login-ok');
    await recordOpenedTabs(page);
    await holdSignIn(page);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`${ORIGIN}/sources`);
    expect(await smallTargets(section(page))).toEqual([]);

    await removeHook(page).click();
    await expect(panel(page).getByLabel('Status line now')).toBeVisible();
    expect(await smallTargets(section(page))).toEqual([]);
    await panel(page).getByRole('button', { name: 'Close' }).click();

    await row(page, 'ChatGPT').getByRole('button', { name: 'Connect ChatGPT' }).click();
    await expect(
      row(page, 'ChatGPT').getByRole('group', { name: 'Finish signing in to ChatGPT' }),
    ).toBeVisible();
    expect(await smallTargets(section(page))).toEqual([]);
  });

  test('Claude legacy removal preview returns focus when closed', async ({ page, world }) => {
    await world.claude.seedLegacyHook({});
    await page.goto(`${ORIGIN}/sources`);
    await removeHook(page).focus();
    await page.keyboard.press('Space');
    await expect(panel(page).getByLabel('Status line now')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(panel(page).getByRole('button', { name: 'Close' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(panel(page)).toHaveCount(0);
    await expect(removeHook(page)).toBeFocused();
  });
});

test.describe('a long button label wraps instead of being cut', () => {
  // At 320px, "Open the ChatGPT sign-in page" and "Check Claude plan limits in Sources" were cut with an ellipsis (Astryx's own label
  // style truncates). The buttons now wrap their label and grow, still at least 44px tall, so the whole name is on screen.
  test('the Overview card link and the ChatGPT sign-in link at 320px', async ({ page, world }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(`${ORIGIN}/`);
    const card = page.getByRole('link', { name: 'Check Claude plan limits in Sources' });
    await expect(card).toBeVisible();
    expect(await cutLabels(card)).toEqual([]);
    expect((await card.boundingBox())?.height).toBeGreaterThanOrEqual(44);

    world.chatgpt.useScenario('login-ok');
    await recordOpenedTabs(page);
    const signIn = await holdSignIn(page);
    await page.goto(`${ORIGIN}/sources`);
    await row(page, 'ChatGPT').getByRole('button', { name: 'Connect ChatGPT' }).click();
    const waiting = row(page, 'ChatGPT').getByRole('group', {
      name: 'Finish signing in to ChatGPT',
    });
    const open = waiting.getByRole('link', { name: 'Open the ChatGPT sign-in page' });
    await expect(open).toBeVisible();
    expect(await cutLabels(open)).toEqual([]);
    expect((await open.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    signIn.release();
  });
});
