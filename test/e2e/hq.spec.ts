import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { HQ_HOOKS_PROMPT_KEY } from '../../src/client/lib/shownOnce.ts';
import { FIXED_NOW } from '../fixtures/seed.ts';
import {
  agent,
  emptyRoster,
  idleReviewRoster,
  officeRoster,
  type HqScenario,
} from '../fixtures/hq/scripted.ts';
import type { ScriptedHooksScenario } from '../fixtures/hq/scriptedHooks.ts';
import { expect, test } from './fixtures';
import { failures, measureContainment } from './helpers/containment';
import { ORIGIN } from './helpers/virtualOrigin';
import { openWorld, type World } from './helpers/world';

// HQ in a real browser, over the real API with a scripted roster (test/fixtures/hq). With no live feeder the page says so; with the
// example office it lists three focused sessions and a recent idle session, the one that needs the owner first. The roster is plain HTML (nested
// lists); the illustrated scene above it is decorative, so everything about the roster is asserted without it.
//
// The fixed clock is Wed 2026-11-04 17:42 UTC; the example roster is built from it, so "idle for 12 min" is exact.

async function openHq(
  page: Page,
  width: number,
  hq?: HqScenario,
  hooks?: ScriptedHooksScenario,
  options: { firstTime?: boolean } = {},
): Promise<World> {
  await page.setViewportSize({ width, height: 900 });
  const world = await openWorld(page, { ...(hq ? { hq } : {}), ...(hooks ? { hooks } : {}) });
  // The hooks switch's first-time dialog has been seen on this browser, unless the spec is about it.
  if (!options.firstTime)
    await page.addInitScript((key) => window.localStorage.setItem(key, '1'), HQ_HOOKS_PROMPT_KEY);
  await page.clock.setFixedTime(new Date(FIXED_NOW));
  await page.goto(`${ORIGIN}/hq`);
  await expect(page.getByRole('heading', { level: 1, name: 'HQ' })).toBeVisible();
  return world;
}

const sessions = (page: Page) => page.getByRole('list', { name: 'Sessions', exact: true });
const sessionCards = (page: Page) => sessions(page).locator(':scope > li');
const scene = (page: Page) => page.getByTestId('hq-scene');
const afk = (page: Page) => page.getByTestId('hq-afk');
const QUIET = 'A quiet one. No agents are running right now.';

test.describe('HQ', () => {
  test('says live agents are not available when no feeder is running', async ({ page }) => {
    await openHq(page, 1280);
    await expect(page.getByText('Live agents aren’t available in this session.')).toBeVisible();
    await expect(sessions(page)).toHaveCount(0);
    await expect(page).toHaveTitle('HQ · Agent Productivity HQ');
    // HQ is in the side nav, after Usage, and is the current page.
    const side = page.getByRole('navigation', { name: 'Sections' });
    await expect(side.getByRole('link', { name: 'HQ' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('region', { name: 'Filters' })).toHaveCount(0);
  });

  test('shows three focused sessions, the one that needs you first, with state words', async ({
    page,
  }) => {
    await openHq(page, 1280, 'office');
    await expect(sessionCards(page)).toHaveCount(3);
    await expect(page.getByText('6 working · 1 needs you')).toBeVisible();
    const first = sessionCards(page).first();
    await expect(first).toContainText('Sync shared instructions');
    await expect(first).toContainText('Needs you: permission');
    await expect(first).toContainText('Compare the two copies');
    const build = page.getByRole('list', { name: 'Build the HQ page: 4 agents' });
    await expect(build.getByRole('listitem')).toHaveCount(4);
    for (const words of ['Editing', 'Reading', 'Running a command', 'Thinking']) {
      await expect(build).toContainText(words);
    }
    const recent = page.getByRole('button', { name: 'Recent idle (1)' });
    await expect(recent).toHaveAttribute('aria-expanded', 'false');
    await recent.click();
    const idle = page.getByRole('list', { name: 'Recent idle' });
    await expect(idle).toContainText('Idle for 12 min');
    await expect(idle).toContainText('No name recorded');
    await expect(sessions(page)).toContainText('Claude Code · kelvin/agent-productivity');
  });

  test('shows roster changes after the next poll', async ({ page }) => {
    const world = await openHq(page, 1280, 'office');
    await expect(sessionCards(page)).toHaveCount(3);
    // A new solo agent arrives, and the waiting one goes back to work.
    const next = officeRoster(FIXED_NOW);
    next.agents = [
      ...next.agents.map((a) =>
        a.id === 'hq-sync'
          ? { ...a, state: 'working' as const, activity: 'editing' as const, waitReason: null }
          : a,
      ),
      agent(FIXED_NOW, {
        id: 'new',
        provider: 'codex',
        title: 'Update the changelog',
        activity: 'reading',
      }),
    ];
    world.hq!.set(next);
    await expect(sessionCards(page)).toHaveCount(4, { timeout: 8_000 });
    // The title is on the roster and, now, on the new room's sign: look in the list.
    await expect(sessions(page).getByText('Update the changelog')).toBeVisible();
    await expect(page.getByText('8 working')).toBeVisible();
    await expect(page.getByText('Needs you: permission')).toHaveCount(0);

    world.hq!.set(emptyRoster(FIXED_NOW));
    await expect(page.getByText(QUIET)).toBeVisible({ timeout: 8_000 });
    await expect(afk(page)).toBeVisible();
    await expect(sessions(page)).toHaveCount(0);
  });

  test('says when Paseo is not running, and still lists what the other feeds see', async ({
    page,
  }) => {
    await openHq(page, 1280, 'paseo-down');
    await expect(page.getByText('Not running')).toBeVisible();
    await expect(page.getByText('Start Paseo, then check again.')).toBeVisible();
    await expect(sessionCards(page)).toHaveCount(1);
  });

  test('keeps the last roster and offers Retry when a poll fails', async ({ page }) => {
    await openHq(page, 1280, 'office');
    await expect(sessionCards(page)).toHaveCount(3);
    // The app stops answering: the last roster stays, with a notice.
    await page.route(`${ORIGIN}/api/hq`, (route) => route.abort());
    const notice = page.getByRole('alert');
    await expect(notice).toContainText('Couldn’t refresh HQ', { timeout: 8_000 });
    await expect(sessionCards(page)).toHaveCount(3);
    await page.unroute(`${ORIGIN}/api/hq`);
    await notice.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});

test.describe('HQ recent idle and review', { tag: ['@a11y', '@responsive'] }, () => {
  for (const width of [1280, 390]) {
    test(`${width}px: keeps attention in rooms and discloses recent idle in activity order`, async ({
      page,
    }) => {
      const world = await openHq(page, width, 'idle-review');
      const rooms = scene(page).getByTestId('hq-room');
      await expect(rooms).toHaveCount(2);
      await expect(sessions(page).getByText('Ready to review')).toBeVisible();
      await expect(sessions(page).getByText('Background work running')).toBeVisible();
      await expect(page.getByText('Opened by accident')).toHaveCount(0);

      const disclosure = page.getByRole('button', { name: 'Recent idle (2)' });
      await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByRole('list', { name: 'Recent idle' })).toHaveCount(0);
      await disclosure.focus();
      await disclosure.press('Space');
      await expect(disclosure).toBeFocused();
      await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
      const recent = page.getByRole('list', { name: 'Recent idle' });
      await expect(recent.locator(':scope > li').first()).toContainText('Recently acknowledged');
      await expect(recent.locator(':scope > li').last()).toContainText('Older imported thread');
      await expect(recent).not.toContainText('Opened by accident');
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(failures(await measureContainment(page))).toEqual([]);

      const backgroundRoom = rooms.and(page.locator('[data-session="background"]'));
      const roomPosition = () =>
        backgroundRoom.evaluate((room) => {
          const building = room.closest('[data-testid="hq-scene"]')!.getBoundingClientRect();
          const position = room.getBoundingClientRect();
          return { x: position.x - building.x, y: position.y - building.y };
        });
      const previousPosition = await roomPosition();
      const roster = idleReviewRoster(FIXED_NOW);
      roster.agents = roster.agents.map((agent) =>
        agent.id === 'review'
          ? { ...agent, state: 'idle', reviewPending: false, lastActivityAt: roster.generatedAt }
          : agent,
      );
      world.hq!.set(roster);
      await expect(rooms).toHaveCount(1, { timeout: 8_000 });
      await expect(recent.locator(':scope > li').first()).toContainText('Review shipped work');
      expect(await roomPosition()).toEqual(previousPosition);

      world.hq!.set(idleReviewRoster(FIXED_NOW));
      await expect(rooms).toHaveCount(2, { timeout: 8_000 });
      await expect(sessions(page).getByText('Ready to review')).toBeVisible();
    });
  }
});

test.describe('HQ scene', () => {
  test('draws three rooms above the roster for the office, and none when there is nothing to draw', async ({
    page,
  }) => {
    await openHq(page, 1280, 'office');
    await expect(scene(page)).toBeVisible();
    await expect(scene(page).getByTestId('hq-room')).toHaveCount(3);
    // Three rooms to a row at this width, so a sign is narrow: its first line is the chat's title (cut with an ellipsis when long, and
    // shorter on the room with the star), its second the repository then the state, and the repository gives way to the state.
    const signs = await scene(page)
      .getByTestId('hq-room')
      .evaluateAll((rooms) =>
        rooms.map((room) =>
          [...room.querySelectorAll('text')].slice(0, 2).map((text) => text.textContent),
        ),
      );
    expect(signs).toEqual([
      ['Sync shared inst…', 'agent… · captain + 1'],
      ['Fix the flaky checko…', 'atlas-api · solo'],
      ['Build the HQ page', 'agent-prod… · captain + 3'],
    ]);
    // Above the roster, and out of the accessibility tree: nothing in it can be focused or read.
    const above = await page.evaluate(
      () =>
        !!(
          document
            .querySelector('[data-testid="hq-scene"]')!
            .compareDocumentPosition(document.querySelector('ul[aria-label="Sessions"]')!) &
          Node.DOCUMENT_POSITION_FOLLOWING
        ),
    );
    expect(above).toBe(true);
    await expect(scene(page)).toHaveAttribute('aria-hidden', 'true');
    await expect(scene(page).locator('a, button, [tabindex], [role]')).toHaveCount(0);
    await expect(afk(page)).toHaveCount(0);
  });

  test('is absent when no feeder is running and when nobody is running', async ({ page }) => {
    await openHq(page, 1280);
    await expect(page.getByText('Live agents aren’t available in this session.')).toBeVisible();
    await expect(scene(page)).toHaveCount(0);
    await expect(afk(page)).toHaveCount(0);
    await openHq(page, 1280, 'empty');
    await expect(page.getByText(QUIET)).toBeVisible();
    await expect(scene(page)).toHaveCount(0);
  });

  test('follows the roster: a room stays put, and the scene goes when the last agent does', async ({
    page,
  }) => {
    const world = await openHq(page, 1280, 'office');
    const order = () =>
      scene(page)
        .getByTestId('hq-room')
        .evaluateAll((rooms) => rooms.map((room) => room.getAttribute('data-session')));
    const before = await order();
    expect(before).toHaveLength(3);
    // A new solo agent arrives: it gets the first free cell, and no room moves.
    const next = officeRoster(FIXED_NOW);
    next.agents = [
      ...next.agents,
      agent(FIXED_NOW, { id: 'new', provider: 'codex', repo: 'kelvin/newcomer' }),
    ];
    world.hq!.set(next);
    await expect(scene(page).getByTestId('hq-room')).toHaveCount(4, { timeout: 8_000 });
    const after = await order();
    // The building is three rooms to a row at this width: every room keeps its place and the newcomer takes the first free cell.
    expect(after).toEqual([...before, 'new']);
    world.hq!.set(emptyRoster(FIXED_NOW));
    await expect(scene(page)).toHaveCount(0, { timeout: 8_000 });
  });

  test('is a still drawing under reduced motion, and moves otherwise', async ({ page }) => {
    const running = () =>
      scene(page).evaluate(
        (el) => el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length,
      );
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openHq(page, 1280, 'office');
    await expect(scene(page)).toBeVisible();
    expect(await running()).toBeGreaterThan(0);
    const wobbles = await scene(page)
      .getByTestId('hq-room')
      .first()
      .evaluate((room) =>
        room.getAnimations({ subtree: true }).some((animation) => {
          if (animation.playState !== 'running' || !(animation.effect instanceof KeyframeEffect))
            return false;
          const filters = animation.effect
            .getKeyframes()
            .map(({ filter }) => filter)
            .filter(Boolean);
          return new Set(filters).size >= 3;
        }),
      );
    expect(wobbles, 'the room ink should cycle among three filters').toBe(true);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await running()).toBe(0);
    expect(await scene(page).evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
    // Still drawn with the first wobble filter.
    const filter = await scene(page).evaluate((el) => {
      const group = el.querySelector('svg[data-testid="hq-room"] > g')!;
      return getComputedStyle(group).filter;
    });
    expect(filter).toMatch(/^url\(.*wobble.*-a.*\)$/);
  });
});

test.describe('HQ quiet state', () => {
  test('draws the AFK room, decorative, above the quiet sentence', async ({ page }) => {
    await openHq(page, 1280, 'empty');
    await expect(afk(page)).toBeVisible();
    await expect(afk(page)).toHaveAttribute('aria-hidden', 'true');
    await expect(
      afk(page).locator('a, button, [tabindex], [role], [aria-label], title'),
    ).toHaveCount(0);
    await expect(afk(page)).toContainText('AFK');
    await expect(afk(page)).toContainText('back');
    await expect(page.getByText(QUIET)).toBeVisible();
    const above = await page.evaluate((sentence) => {
      const art = document.querySelector('[data-testid="hq-afk"]')!.getBoundingClientRect();
      const line = [...document.querySelectorAll('p')].find((p) => p.textContent === sentence)!;
      return art.bottom <= line.getBoundingClientRect().top;
    }, QUIET);
    expect(above, 'the sentence sits below the drawing').toBe(true);
    await expect(scene(page)).toHaveCount(0);
  });

  test('is absent when a feed has a problem and when feeders are not running', async ({ page }) => {
    await openHq(page, 1280, 'paseo-down');
    await expect(page.getByText('Not running')).toBeVisible();
    await expect(afk(page)).toHaveCount(0);
    await openHq(page, 1280);
    await expect(page.getByText('Live agents aren’t available in this session.')).toBeVisible();
    await expect(afk(page)).toHaveCount(0);
  });

  for (const width of [1280, 320]) {
    test(`${width}px: the word AFK is drawn at 28px or more`, async ({ page }) => {
      await openHq(page, width, 'empty');
      const size = await afk(page).evaluate((el) => {
        const sign = [...el.querySelectorAll('text')].find((t) => t.textContent === 'AFK')!;
        const svg = sign.ownerSVGElement!;
        return Number(sign.getAttribute('font-size')) * (svg.getBoundingClientRect().width / 480);
      });
      expect(size).toBeGreaterThanOrEqual(28);
    });
  }

  test('moves, and is a still drawing under reduced motion', async ({ page }) => {
    const running = () =>
      afk(page).evaluate(
        (el) => el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length,
      );
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openHq(page, 1280, 'empty');
    await expect(afk(page)).toBeVisible();
    expect(await running()).toBeGreaterThan(0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await running()).toBe(0);
    expect(await afk(page).evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
    const filter = await afk(page).evaluate(
      (el) => getComputedStyle(el.querySelector('svg > g')!).filter,
    );
    expect(filter).toMatch(/^url\(.*wobble.*-a.*\)$/);
  });
});

test.describe('HQ accessibility', { tag: '@a11y' }, () => {
  test('navigating to HQ moves focus to its heading', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openWorld(page, { hq: 'office' });
    await page.goto(`${ORIGIN}/`);
    await page
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('link', { name: 'HQ' })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'HQ' })).toBeFocused();
  });

  test('the roster is nested lists, rows are not tab stops, and polling is not announced', async ({
    page,
  }) => {
    await openHq(page, 1280, 'office');
    await expect(sessionCards(page)).toHaveCount(3);
    // One list of sessions; each session holds a list whose first item is its root and which nests the agents it spawned.
    const build = page.getByRole('list', { name: 'Build the HQ page: 4 agents' });
    await expect(build.locator(':scope > li')).toHaveCount(1);
    await expect(build.locator(':scope > li > ul > li')).toHaveCount(3);
    await expect(sessions(page).locator('a, button, [tabindex]')).toHaveCount(0);
    // No live region in the roster or the scene. (The hooks section's buttons carry Astryx's own hidden one; it speaks only after the owner acts.)
    await expect(sessions(page).locator('[aria-live], [role="status"]')).toHaveCount(0);
    await expect(scene(page).locator('[aria-live], [role="status"]')).toHaveCount(0);
    await expect(page.locator('main [aria-live]:not(section *)')).toHaveCount(0);
    // Decorative buddies stay out of the accessibility tree.
    await expect(sessions(page).locator('svg:not([aria-hidden="true"])')).toHaveCount(0);
  });

  for (const width of [1280, 390, 320]) {
    test(`axe: HQ with the office roster at ${width}px has no violations`, async ({ page }) => {
      await openHq(page, width, 'office');
      await expect(sessionCards(page)).toHaveCount(3);
      await expect(scene(page)).toBeVisible();
      const { violations } = await new AxeBuilder({ page }).analyze();
      const summary = violations.map(
        (v) =>
          `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).join('\n    ')}`,
      );
      expect(summary, `axe found ${violations.length} violation(s)`).toEqual([]);
    });
  }
});

test.describe('HQ quiet state accessibility', { tag: '@a11y' }, () => {
  for (const width of [1280, 390, 320]) {
    test(`axe: the quiet state at ${width}px has no violations`, async ({ page }) => {
      await openHq(page, width, 'empty');
      await expect(afk(page)).toBeVisible();
      const { violations } = await new AxeBuilder({ page }).analyze();
      const summary = violations.map(
        (v) =>
          `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).join('\n    ')}`,
      );
      expect(summary, `axe found ${violations.length} violation(s)`).toEqual([]);
    });
  }
});

test.describe('HQ layout', { tag: '@responsive' }, () => {
  test('fits workspace titles and distinct subagent labels on a phone', async ({ page }) => {
    const world = await openHq(page, 390, 'empty');
    world.hq!.set({
      ...officeRoster(FIXED_NOW),
      agents: [
        agent(FIXED_NOW, { id: 'paseo', provider: 'codex', title: 'Assess PDLC workflow' }),
        agent(FIXED_NOW, {
          id: 'a123456789abc',
          provider: 'claude',
          kind: 'child',
          parentBasis: 'native',
          parentAway: true,
        }),
      ],
    });
    await expect(sessions(page)).toContainText('Assess PDLC workflow');
    await expect(sessions(page)).toContainText('Subagent · 789abc');
    const rooms = scene(page).getByTestId('hq-room');
    await expect(rooms.and(page.locator('[data-session="paseo"]'))).toContainText('Assess PDLC');
    await expect(rooms.and(page.locator('[data-session="a123456789abc"]'))).toContainText(
      'Subagent',
    );
    expect(failures(await measureContainment(page))).toEqual([]);
  });
  for (const width of [1280, 390, 320]) {
    test(`${width}px: the quiet state stays inside the window`, async ({ page }, testInfo) => {
      await openHq(page, width, 'empty');
      await expect(afk(page)).toBeVisible();
      const box = (await afk(page).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      const report = await measureContainment(page);
      await testInfo.attach('containment', {
        body: JSON.stringify(report, null, 2),
        contentType: 'application/json',
      });
      expect(report.width).toBe(width);
      expect(failures(report), JSON.stringify(report, null, 2)).toEqual([]);
      expect(report.spill, 'content wider than its own box').toEqual([]);
    });
  }

  for (const width of [1280, 390, 320]) {
    test(`${width}px: the office roster stays inside the window`, async ({ page }, testInfo) => {
      await openHq(page, width, 'office');
      await expect(sessionCards(page)).toHaveCount(3);
      await expect(scene(page)).toBeVisible();
      // The scene stays inside the window, and the page does not scroll sideways.
      const box = (await scene(page).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      const report = await measureContainment(page);
      await testInfo.attach('containment', {
        body: JSON.stringify(report, null, 2),
        contentType: 'application/json',
      });
      expect(report.width).toBe(width);
      expect(failures(report), JSON.stringify(report, null, 2)).toEqual([]);
      expect(report.spill, 'content wider than its own box').toEqual([]);
    });
  }

  test('a long title and a deep roster wrap inside the card at 320px', async ({ page }) => {
    const world = await openHq(page, 320, 'office');
    const long = 'A'.repeat(80);
    const next = emptyRoster(FIXED_NOW);
    next.agents = Array.from({ length: 14 }, (_, index) =>
      agent(FIXED_NOW, {
        id: `nested-${index}`,
        provider: 'codex',
        kind: index === 0 ? 'root' : 'child',
        parentId: index === 0 ? null : `nested-${index - 1}`,
        parentBasis: index === 0 ? null : 'paseo',
        title: index === 13 ? long : `Agent ${index + 1}`,
      }),
    );
    world.hq!.set(next);
    await expect(page.getByText(long)).toBeVisible({ timeout: 8_000 });
    await expect(
      sessions(page).getByRole('list', { name: 'Agent 1: 14 agents' }).getByRole('listitem'),
    ).toHaveCount(14);
    expect(failures(await measureContainment(page))).toEqual([]);
  });

  for (const width of [390, 320]) {
    test(`${width}px: HQ is an app bar link of 44px, and the tab bar keeps its five tabs`, async ({
      page,
    }) => {
      await openHq(page, width, 'office');
      const bar = page.getByRole('banner').first();
      const link = bar.getByRole('link', { name: 'HQ', exact: true });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('aria-current', 'page');
      const box = (await link.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      // The app bar still fits: Refresh stays inside the window beside it.
      const refresh = (await bar.getByRole('button', { name: 'Refresh' }).boundingBox())!;
      expect(refresh.x + refresh.width).toBeLessThanOrEqual(width);
      const tabs = page.getByRole('navigation', { name: 'Sections' });
      await expect(tabs).toHaveCount(1);
      await expect(tabs.getByRole('link')).toHaveCount(5);
      await expect(tabs.getByRole('link', { name: 'HQ' })).toHaveCount(0);
    });

    test(`${width}px: the app bar link opens HQ from another page`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openWorld(page, { hq: 'office' });
      await page.goto(`${ORIGIN}/usage`);
      const link = page.getByRole('banner').first().getByRole('link', { name: 'HQ', exact: true });
      await expect(link).not.toHaveAttribute('aria-current', 'page');
      await link.click();
      await expect(page).toHaveURL(`${ORIGIN}/hq`);
      await expect(page.getByRole('heading', { level: 1, name: 'HQ' })).toBeFocused();
    });
  }

  test('1280px: there is no app bar HQ link, the side nav has it', async ({ page }) => {
    await openHq(page, 1280, 'office');
    await expect(page.getByRole('banner').first().getByRole('link', { name: 'HQ' })).toBeHidden();
    await expect(
      page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'HQ' }),
    ).toBeVisible();
  });
});

// The Claude Code hooks switch: a card on the Sources screen, over a scripted switch that only flips in memory.
async function openSources(
  page: Page,
  width: number,
  hooks?: ScriptedHooksScenario,
): Promise<World> {
  await page.setViewportSize({ width, height: 900 });
  const world = await openWorld(page, hooks ? { hooks } : {});
  await page.clock.setFixedTime(new Date(FIXED_NOW));
  await page.goto(`${ORIGIN}/sources`);
  await expect(page.getByRole('heading', { level: 1, name: 'Sources & repos' })).toBeVisible();
  return world;
}
const hooksSection = (page: Page) =>
  page.getByRole('region', { name: 'Know when Claude Code needs you' });

test.describe('Sources hooks switch', () => {
  test('explains itself, changes nothing until the owner acts, then turns on and says so', async ({
    page,
  }) => {
    const world = await openSources(page, 1280, 'off');
    const section = hooksSection(page);
    await expect(section).toBeVisible();
    await expect(section).toContainText(
      'HQ can only guess when an agent outside Paseo is waiting for you. Turn this on to have Claude Code tell HQ directly.',
    );
    await expect(section).toContainText('Off. HQ guesses, and says “May be waiting for you”.');
    expect(world.hooks!.changes).toEqual([]);
    await expect(section).toContainText(
      'This only changes what HQ can show. Your usage and delivery numbers are unaffected.',
    );
    // After "On this machine", before the accounts, and not on HQ.
    const order = await page.evaluate(() => {
      const titles = [...document.querySelectorAll('main h2')].map((h) => h.textContent);
      return titles;
    });
    expect(order.indexOf('Know when Claude Code needs you')).toBe(
      order.indexOf('On this machine') + 1,
    );
    expect(order.indexOf('Accounts')).toBe(order.indexOf('Know when Claude Code needs you') + 1);

    // What will change: read from the preview, on demand.
    const toggle = section.getByRole('button', { name: 'What will change' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(section).toContainText('~/.claude/settings.json');
    await expect(section).toContainText(
      'PermissionRequest, Notification, Stop, SessionStart, SessionEnd',
    );
    await expect(section).toContainText(': agent-productivity-hq-hook;');
    expect(world.hooks!.changes).toEqual([]);
    await toggle.click();

    await section.getByRole('button', { name: 'Turn on' }).click();
    await expect(section.getByText(/^Turned on\. Claude Code will tell HQ/)).toBeVisible();
    await expect(section.getByRole('button', { name: 'Turn off' })).toBeVisible();
    await expect(section).toContainText('On. Claude Code tells HQ when it needs you.');
    expect(world.hooks!.changes).toEqual([true]);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await section.getByRole('button', { name: 'Turn off' }).click();
    await expect(section.getByText(/^Turned off\./)).toBeVisible();
    await expect(section.getByRole('button', { name: 'Turn on' })).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(world.hooks!.changes).toEqual([true, false]);
  });

  test('says a refusal in the server’s fixed words and leaves the switch as it was', async ({
    page,
  }) => {
    const world = await openSources(page, 1280, 'off');
    world.hooks!.failNext('not_json');
    const section = hooksSection(page);
    await section.getByRole('button', { name: 'Turn on' }).click();
    const alert = section.getByRole('alert');
    await expect(alert).toContainText(
      'Claude Code’s settings file isn’t valid JSON, so HQ didn’t change it.',
    );
    await expect(alert).toContainText('Nothing was turned on or off.');
    await expect(section.getByRole('button', { name: 'What will change' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(section.getByRole('button', { name: 'Turn on' })).toBeVisible();
    // Trying again works: the next call succeeds.
    await section.getByRole('button', { name: 'Turn on' }).click();
    await expect(section.getByRole('button', { name: 'Turn off' })).toBeVisible();
  });

  test('offers Repair when the entries no longer match, and says when it is not available', async ({
    page,
  }) => {
    await openSources(page, 1280, 'needs_repair');
    const section = hooksSection(page);
    await expect(section).toContainText('Needs repair.');
    await section.getByRole('button', { name: 'What will change' }).click();
    await expect(section).toContainText(': agent-productivity-hq-hook;');
    await section.getByRole('button', { name: 'Repair' }).click();
    await expect(
      section.getByText('Repaired. HQ’s entries match this version of the app again.'),
    ).toBeVisible();
    await openSources(page, 1280, 'blocked');
    const blocked = hooksSection(page);
    await expect(blocked).toContainText('Not available.');
    await expect(blocked.getByRole('button', { name: /Turn on|Turn off|Repair/ })).toHaveCount(0);
    await blocked.getByRole('button', { name: 'What will change' }).click();
    await expect(blocked).toContainText('isn’t valid JSON');
    await expect(blocked).toContainText('HQ leaves a file it can’t change exactly as it is.');
  });

  test('is keyboard operable', async ({ page }) => {
    const world = await openSources(page, 1280, 'off');
    const section = hooksSection(page);
    const toggle = section.getByRole('button', { name: 'What will change' });
    await toggle.focus();
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(section).toContainText(': agent-productivity-hq-hook;');
    await page.keyboard.press('Tab');
    await expect(section.getByRole('button', { name: 'Turn on' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(section.getByRole('button', { name: 'Turn off' })).toBeVisible();
    expect(world.hooks!.changes).toEqual([true]);
  });

  for (const width of [1280, 390, 320]) {
    test(`${width}px: the section and its preview stay inside the window, and axe is clean`, async ({
      page,
    }, testInfo) => {
      await openSources(page, width, 'off');
      const section = hooksSection(page);
      await section.getByRole('button', { name: 'What will change' }).click();
      await expect(section).toContainText(': agent-productivity-hq-hook;');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      const report = await measureContainment(page);
      await testInfo.attach('containment', {
        body: JSON.stringify(report, null, 2),
        contentType: 'application/json',
      });
      expect(failures(report), JSON.stringify(report, null, 2)).toEqual([]);
      // A press target of 44px on a phone.
      if (width < 720) {
        for (const name of ['What will change', 'Turn on']) {
          const box = await section.getByRole('button', { name }).boundingBox();
          expect(box!.height).toBeGreaterThanOrEqual(44);
        }
      }
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(
        violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
      ).toEqual([]);
    });
  }
});

// The first time HQ is opened on a browser with the switch off, the same control is offered once, in a dialog (no panel on the page).
test.describe('HQ hooks first-time dialog', () => {
  const DIALOG = 'Know when Claude Code needs you';

  test('opens once, says where it is found later, and never opens by itself again once closed', async ({
    page,
  }) => {
    const world = await openHq(page, 1280, 'office', 'off', { firstTime: true });
    const dialog = page.getByRole('dialog', { name: DIALOG });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('You can find this later under Sources.');
    await expect(dialog).toContainText(
      'This only changes what HQ can show. Your usage and delivery numbers are unaffected.',
    );
    // The title takes focus, and the page behind it is out of reach.
    await expect(dialog.getByRole('heading', { level: 2, name: DIALOG })).toBeFocused();
    expect(world.hooks!.changes).toEqual([]);
    // The control is the Sources one: the plan is read on demand, and nothing is written by opening or reading it.
    await dialog.getByRole('button', { name: 'What will change' }).click();
    await expect(dialog).toContainText(': agent-productivity-hq-hook;');
    expect(world.hooks!.changes).toEqual([]);
    // Nothing is recorded until it is closed; Escape closes it and records it.
    expect(
      await page.evaluate((key) => window.localStorage.getItem(key), HQ_HOOKS_PROMPT_KEY),
    ).toBe(null);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(
      await page.evaluate((key) => window.localStorage.getItem(key), HQ_HOOKS_PROMPT_KEY),
    ).toBe('1');
    // HQ itself holds no switch, and a reload does not ask again.
    await expect(hooksSection(page)).toHaveCount(0);
    await page.reload();
    await expect(sessionCards(page)).toHaveCount(3);
    await expect(page.getByRole('dialog', { name: DIALOG })).toHaveCount(0);
    expect(world.hooks!.changes).toEqual([]);
  });

  test('"Not now" closes it and records that it was shown', async ({ page }) => {
    await openHq(page, 1280, 'office', 'off', { firstTime: true });
    const dialog = page.getByRole('dialog', { name: DIALOG });
    await dialog.getByRole('button', { name: 'Not now' }).click();
    await expect(dialog).toBeHidden();
    expect(
      await page.evaluate((key) => window.localStorage.getItem(key), HQ_HOOKS_PROMPT_KEY),
    ).toBe('1');
  });

  test('turning it on from the dialog shows the plan first, says so, and is not asked again', async ({
    page,
  }) => {
    const world = await openHq(page, 1280, 'office', 'off', { firstTime: true });
    const dialog = page.getByRole('dialog', { name: DIALOG });
    await dialog.getByRole('button', { name: 'Turn on' }).click();
    await expect(dialog).toContainText(': agent-productivity-hq-hook;');
    expect(world.hooks!.changes).toEqual([]);
    await dialog.getByRole('button', { name: 'Turn on' }).click();
    await expect(dialog.getByText(/^Turned on\. Claude Code will tell HQ/)).toBeVisible();
    expect(world.hooks!.changes).toEqual([true]);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();
    await page.reload();
    await expect(sessionCards(page)).toHaveCount(3);
    await expect(page.getByRole('dialog', { name: DIALOG })).toHaveCount(0);
  });

  test('is not offered when the switch is on', async ({ page }) => {
    await openHq(page, 1280, 'office', 'on', { firstTime: true });
    await expect(sessionCards(page)).toHaveCount(3);
    await expect(page.getByRole('dialog', { name: DIALOG })).toHaveCount(0);
  });

  for (const width of [1280, 390, 320]) {
    test(`${width}px: the dialog stays inside the window with its plan open, and axe is clean`, async ({
      page,
    }) => {
      await openHq(page, width, 'office', 'off', { firstTime: true });
      const dialog = page.getByRole('dialog', { name: DIALOG });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'What will change' }).click();
      await expect(dialog).toContainText(': agent-productivity-hq-hook;');
      const box = (await dialog.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(900);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      // The close button and "Not now" are reachable, and a press target of 44px on a phone.
      const notNow = dialog.getByRole('button', { name: 'Not now' });
      await expect(notNow).toBeVisible();
      if (width < 720) expect((await notNow.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(
        violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
      ).toEqual([]);
    });
  }
});
