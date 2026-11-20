import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { failures, measureContainment, type ContainmentReport } from './helpers/containment';
import { ORIGIN } from './helpers/virtualOrigin';
import { openWorld } from './helpers/world';

// The responsive pass over every route (M7: A28, goal G7_8), in a real browser against the real API over the seeded world.
//
//   - the containment helper (test/e2e/helpers/containment.ts) runs at 1280, 390 and 320px on EVERY route: Overview, Trends,
//     Delivery, Usage, HQ, Sources & repos, Setup and the not-found page. A FAIL (the page scrolls sideways, or something ends past the
//     window) fails the test. A CHECK (content wider than its own box) must be one of KNOWN_CHECKS below, each with its reason, so a new
//     one cannot appear unnoticed; every report is attached to the test, so the results are recorded with the run
//   - on a phone (below 720px): the shell's own controls are 44px targets, text fields are 16px (iOS does not zoom on focus), the
//     tab bar, app bar and page keep clear of the device's safe-area insets, and a toast is drawn above the tab bar
//   - the records drawer on a phone: nearly the full width, inside the window at 390 and 320px, with 44px controls
//
// Not asserted, but listed in every phone report as `targets-below-44`: the controls a SCREEN draws smaller than 44px
// (the chart and link-filter segmented controls, a few text links). They belong to features and components, outside the shell's
// paths; the report is what is handed back to their owners.

const WIDTHS = [1280, 390, 320] as const;
const PHONE_WIDTHS = [390, 320] as const;

interface Route {
  name: string;
  path: string;
}
const ROUTES: readonly Route[] = [
  { name: 'Overview', path: '/' },
  { name: 'Trends', path: '/trends' },
  { name: 'Delivery', path: '/delivery' },
  { name: 'Usage', path: '/usage' },
  { name: 'HQ', path: '/hq' },
  { name: 'Sources & repos', path: '/sources' },
  { name: 'Setup', path: '/setup' },
  { name: 'Not found', path: '/no-such-page' },
];

/**
 * The CHECK items the helper reports that are not defects, matched on the start of their label. A CHECK is "an element has
 * content wider than its own box"; each of these is by design or a measuring artefact, said here so that a new one fails.
 */
const KNOWN_CHECKS: ReadonlyArray<{ match: RegExp; why: string }> = [
  {
    match: /^label\.astryx-field-label/,
    why: 'a visually hidden field label (Astryx isLabelHidden, a 1px clipped box): the helper only skips `.sr-only`',
  },
  {
    match: /^button\.relative\.inline-flex \(content 34px in a 24px box\)/,
    why: 'a 24px row toggle whose `::before` grows the hit area to 44px on a phone (counted as overflow by scrollWidth)',
  },
];

/** The route's own first heading is there and nothing is still loading: the page is as it will be looked at. */
async function openRoute(page: Page, route: Route, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await openWorld(page);
  await page.goto(`${ORIGIN}${route.path}`);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
}

/**
 * Every visible control, and how big its target is. A pseudo-element that grows the hit area (the row toggles) counts, as it
 * does for a finger. Inline links inside a line of text are exempt (WCAG 2.5.8), so they are not listed.
 */
async function measureTargets(
  page: Page,
  within = 'body',
): Promise<{ all: string[]; small: string[] }> {
  return page.evaluate((rootSelector) => {
    const root = document.querySelector(rootSelector);
    if (!root) throw new Error(`targets: nothing matches ${rootSelector}`);
    const controls =
      'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="radio"], [role="checkbox"], [role="switch"], [role="tab"], summary, [tabindex="0"]';
    const all: string[] = [];
    const small: string[] = [];
    for (const el of Array.from(root.querySelectorAll(controls))) {
      if (el.closest('.sr-only')) continue;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (rect.width === 0 || rect.height === 0 || style.visibility === 'hidden') continue;
      if (el.tagName === 'A' && style.display === 'inline') continue;
      let { width, height } = rect;
      for (const pseudo of ['::before', '::after']) {
        const grown = getComputedStyle(el, pseudo);
        if (grown.content !== 'none' && grown.position === 'absolute') {
          width = Math.max(width, parseFloat(grown.width) || 0);
          height = Math.max(height, parseFloat(grown.height) || 0);
        }
      }
      const name = (el.getAttribute('aria-label') ?? el.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      const line = `${el.tagName.toLowerCase()} "${name.slice(0, 36)}" ${Math.round(width)}x${Math.round(height)}`;
      all.push(line);
      if (width < 44 || height < 44) small.push(line);
    }
    return { all, small };
  }, within);
}

/** The toast's own text (the same words are also read out by a hidden live region). */
const toastText = (page: Page) =>
  page
    .getByRole('region', { name: 'Notifications' })
    .getByText('Refreshed all sources · no duplicates.');

function unexplained(report: ContainmentReport): string[] {
  return report.spill.filter((item) => !KNOWN_CHECKS.some((known) => known.match.test(item)));
}

// ============================================================================================================================
// Containment: every route, three widths
// ============================================================================================================================

test.describe('containment on every route', () => {
  for (const route of ROUTES) {
    for (const width of WIDTHS) {
      test(
        `${route.name} at ${width}px: no FAIL, and every CHECK is a known one`,
        { tag: '@responsive' },
        async ({ page }, testInfo) => {
          await openRoute(page, route, width);
          const report = await measureContainment(page);
          const targets = width < 720 ? await measureTargets(page) : null;
          await testInfo.attach('containment', {
            body: JSON.stringify(
              { route: route.path, ...report, 'targets-below-44': targets?.small },
              null,
              2,
            ),
            contentType: 'application/json',
          });
          expect(report.width).toBe(width);
          expect(failures(report), JSON.stringify(report, null, 2)).toEqual([]);
          expect(unexplained(report), 'a CHECK that is not one of KNOWN_CHECKS').toEqual([]);
        },
      );
    }
  }
});

// ============================================================================================================================
// A phone: targets, fields, safe areas, toast
// ============================================================================================================================

test.describe('a phone', () => {
  for (const width of PHONE_WIDTHS) {
    test(`${width}px: the shell’s controls are 44px targets on every route`, async ({ page }) => {
      for (const route of ROUTES.filter((r) => r.path !== '/setup' && r.path !== '/no-such-page')) {
        await openRoute(page, route, width);
        // App bar, tab bar, and the filter summary's button: the controls the design names (design-to-code › Touch targets).
        const bars = await measureTargets(page, 'header');
        const tabs = await measureTargets(page, 'nav[aria-label="Sections"]:last-of-type');
        expect(bars.all.length, `${route.name}: app bar controls`).toBeGreaterThan(0);
        expect(tabs.all.length, `${route.name}: tab bar links`).toBe(5);
        // Sources & repos and HQ have nothing to filter by, so they have no bar; every other screen has the summary and its Filters button.
        const hasBar = route.path !== '/sources' && route.path !== '/hq';
        await expect(page.locator('section[aria-label="Filters"]'), route.name).toHaveCount(
          hasBar ? 1 : 0,
        );
        const filters = hasBar ? await measureTargets(page, 'section[aria-label="Filters"]') : null;
        if (filters)
          expect(filters.all.length, `${route.name}: filter controls`).toBeGreaterThan(0);
        expect(
          [
            ...bars.small,
            ...tabs.small,
            ...(filters?.small.filter((line) => /Filters/.test(line)) ?? []),
          ],
          `${route.name} at ${width}px`,
        ).toEqual([]);
      }
    });

    // What a SCREEN draws, not only the shell: every control inside the page (the chart's Chart/Table switch, the Delivery link
    // filter and search, the links under the coverage strip and the recently merged list) reaches 44px by size or by a hit-area
    // pseudo-element (design-to-code › Touch targets under 44px). Inline links in a line of text are exempt, as in the measure.
    test(`${width}px: every control on Overview, Trends, Delivery, Usage and Sources is a 44px target`, async ({
      page,
    }) => {
      // HQ is left out: with no live feeder it draws a sentence and no control (hq.spec.ts measures its roster).
      for (const route of ROUTES.filter(
        (r) => r.path !== '/setup' && r.path !== '/no-such-page' && r.path !== '/hq',
      )) {
        await openRoute(page, route, width);
        const page_ = await measureTargets(page, 'main');
        expect(page_.all.length, `${route.name}: controls found in the page`).toBeGreaterThan(0);
        expect(page_.small, `${route.name} at ${width}px`).toEqual([]);
      }
    });

    // A pseudo-element counts for the measure above, so this checks it is real: a point 7px above and below the 28px segmented item
    // (inside the 44px zone, outside the drawn item) lands on that item, and the same point does not on a wide screen.
    test(`${width}px: the Chart/Table switch takes a tap just outside its drawn size`, async ({
      page,
    }) => {
      await openRoute(page, ROUTES[0]!, width);
      const table = page.getByRole('radio', { name: 'Table' });
      await table.scrollIntoViewIfNeeded();
      const box = (await table.boundingBox())!;
      const landsOnTable = (dy: number) =>
        page.evaluate(
          ({ x, y }) =>
            document
              .elementFromPoint(x, y)
              ?.closest('.astryx-segmented-control-item')
              ?.textContent?.trim(),
          { x: box.x + box.width / 2, y: box.y + dy },
        );
      expect(box.height, 'drawn at the designed height').toBeLessThan(32);
      expect(await landsOnTable(-7), 'just above it').toBe('Table');
      expect(await landsOnTable(box.height + 7), 'just below it').toBe('Table');
    });

    test(`${width}px: every text field is 16px, so a phone does not zoom on focus`, async ({
      page,
    }) => {
      for (const route of ROUTES) {
        await openRoute(page, route, width);
        const sizes = await page.evaluate(() =>
          Array.from(
            document.querySelectorAll(
              'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), select, textarea',
            ),
          )
            .filter((el) => el.getBoundingClientRect().width > 0)
            .map((el) => ({
              field: `${el.tagName.toLowerCase()}[type=${el.getAttribute('type')}]`,
              size: parseFloat(getComputedStyle(el).fontSize),
            })),
        );
        for (const { field, size } of sizes) {
          expect(size, `${route.name}: ${field}`).toBeGreaterThanOrEqual(16);
        }
        if (route.path === '/delivery') expect(sizes.length, 'Delivery has its search box').toBe(1);
      }
    });
  }

  test('the date fields of the filter sheet are 16px too', async ({ page }) => {
    await openRoute(page, ROUTES[0]!, 390);
    await page.getByRole('button', { name: 'Filters' }).click();
    const sheet = page.getByRole('dialog', { name: 'Filters' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: /^Custom/ }).click();
    const inputs = sheet.locator('input[type="date"], input[type="text"]');
    await expect(inputs.first()).toBeVisible();
    const sizes = await inputs.evaluateAll((els) =>
      els.map((el) => parseFloat(getComputedStyle(el).fontSize)),
    );
    expect(sizes.length).toBeGreaterThanOrEqual(2);
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(16);
  });

  test('the tab bar, app bar and page keep clear of the device’s safe-area insets', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await openWorld(page);
    // A notched phone in landscape and with a home indicator: Chromium can be told the device's insets.
    const session = await page.context().newCDPSession(page);
    await session.send(
      'Emulation.setSafeAreaInsetsOverride' as never,
      {
        insets: { top: 0, bottom: 34, left: 47, right: 47 },
      } as never,
    );
    await page.goto(`${ORIGIN}/`);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await page.waitForLoadState('networkidle');

    const padding = (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((el) => {
          const style = getComputedStyle(el);
          return {
            left: parseFloat(style.paddingLeft),
            right: parseFloat(style.paddingRight),
            bottom: parseFloat(style.paddingBottom),
          };
        });
    // The tab bar: its own padding (6px) plus the inset, on the bottom, left and right.
    expect(await padding('nav[aria-label="Sections"]:last-of-type')).toEqual({
      left: 47,
      right: 47,
      bottom: 6 + 34,
    });
    expect(await padding('header')).toMatchObject({ left: 47, right: 47 });
    expect(await padding('main')).toMatchObject({ left: 47, right: 47 });

    // The last thing on the page can be scrolled clear of the bar.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const gap = await page.evaluate(() => {
      const tabBar = Array.from(document.querySelectorAll('nav[aria-label="Sections"]')).find(
        (nav) => getComputedStyle(nav).position === 'fixed',
      );
      // The content, not <main>: main's own bottom padding is what makes the room.
      const content = document.querySelector('main > div');
      if (!tabBar || !content) throw new Error('no tab bar or content');
      return tabBar.getBoundingClientRect().top - content.getBoundingClientRect().bottom;
    });
    expect(gap).toBeGreaterThanOrEqual(0);
  });

  for (const inset of [0, 34]) {
    test(`a toast is drawn above the tab bar (device bottom inset ${inset}px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 800 });
      await openWorld(page);
      if (inset > 0) {
        const session = await page.context().newCDPSession(page);
        await session.send(
          'Emulation.setSafeAreaInsetsOverride' as never,
          { insets: { top: 0, bottom: inset, left: 0, right: 0 } } as never,
        );
      }
      await page.goto(`${ORIGIN}/`);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await page.getByRole('button', { name: 'Refresh' }).click();
      const message = toastText(page);
      await expect(message).toBeVisible();
      await expect(message).toBeInViewport({ ratio: 1 });
      const geometry = await page.evaluate(() => {
        const tabBar = Array.from(document.querySelectorAll('nav[aria-label="Sections"]')).find(
          (nav) => getComputedStyle(nav).position === 'fixed',
        );
        const toast = Array.from(document.querySelectorAll('div')).find(
          (el) => el.children.length === 0 && /Refreshed all sources/.test(el.textContent ?? ''),
        );
        const region = toast?.closest('[popover]');
        if (!tabBar || !toast || !region) throw new Error('no tab bar, toast or toast region');
        return {
          tabBarTop: tabBar.getBoundingClientRect().top,
          toastBottom: toast.getBoundingClientRect().bottom,
          regionBottom: region.getBoundingClientRect().bottom,
        };
      });
      // The whole toast area ends at the tab bar, and the toast itself clears it by a visible margin.
      expect(geometry.regionBottom).toBeLessThanOrEqual(geometry.tabBarTop + 1);
      expect(geometry.tabBarTop - geometry.toastBottom).toBeGreaterThanOrEqual(8);
    });
  }

  test('on a wide screen the toast is not lifted: there is no tab bar to clear', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openWorld(page);
    await page.goto(`${ORIGIN}/`);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Refresh' }).click();
    const message = toastText(page);
    await expect(message).toBeVisible();
    const bottom = await message.evaluate((el) => innerHeight - el.getBoundingClientRect().bottom);
    // Toast margin only (16px of the viewport's padding and the toast's own), not the 64px of a tab bar.
    expect(bottom).toBeLessThan(48);
  });
});

// ============================================================================================================================
// The records drawer on a phone
// ============================================================================================================================

test.describe('the records drawer on a phone', () => {
  for (const width of PHONE_WIDTHS) {
    test(
      `${width}px: nearly the full width, inside the window, with 44px controls`,
      { tag: '@responsive' },
      async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 800 });
        await openWorld(page);
        await page.goto(`${ORIGIN}/?author=all`);
        await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
        await page.getByRole('radio', { name: 'Table' }).click();
        await page.getByRole('button', { name: /^Tue, Nov 3/ }).click();
        const drawer = page.getByRole('dialog', { name: 'Tue, Nov 3, 2026' });
        await expect(drawer).toBeVisible();
        await expect(drawer.getByRole('radio', { name: /^Merged PRs/ })).toBeVisible();
        await expect(drawer.getByRole('list', { name: 'Merged pull requests' })).toBeVisible();
        await expect(drawer).toBeInViewport({ ratio: 1 });
        // The slide-in has finished: no transition is still running on the panel.
        await expect.poll(() => drawer.evaluate((el) => el.getAnimations().length)).toBe(0);

        const box = await drawer.boundingBox();
        expect(box).toMatchObject({ x: 8, y: 8, width: width - 16, height: 800 - 16 });

        const report = await measureContainment(page, { root: 'dialog[open]' });
        await testInfo.attach('containment', {
          body: JSON.stringify({ drawer: 'prs', ...report }, null, 2),
          contentType: 'application/json',
        });
        expect(failures(report), JSON.stringify(report, null, 2)).toEqual([]);
        expect(report.spill, 'nothing in the drawer is wider than its box').toEqual([]);

        // Sessions: the identity lines and ids wrap inside the row, never past the edge.
        await drawer.getByRole('radio', { name: /^Sessions/ }).click();
        await expect(drawer.getByRole('list', { name: 'Sessions' })).toBeVisible();
        const sessions = await measureContainment(page, { root: 'dialog[open]' });
        expect(failures(sessions), JSON.stringify(sessions, null, 2)).toEqual([]);
        expect(sessions.spill).toEqual([]);

        // The controls the design names for a phone: Close, and the two ways on.
        const { small } = await measureTargets(page, 'dialog[open]');
        expect(
          small.filter((line) => /Close|Open in/.test(line)),
          'Close and the Open in… links',
        ).toEqual([]);
        // The footer is always on screen: the list scrolls, not the buttons.
        const footer = drawer.getByRole('link', { name: 'Open in Delivery' });
        await expect(footer).toBeInViewport({ ratio: 1 });
      },
    );
  }

  test('Show more is a 44px target on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await openWorld(page);
    await page.goto(`${ORIGIN}/trends?start=2025-11-04&end=2026-11-04&gran=month&author=all`);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await page.getByRole('radio', { name: 'Table' }).click();
    await page.getByRole('button', { name: /^Jul 2026/ }).click();
    const drawer = page.getByRole('dialog', { name: 'Jul 2026' });
    const more = drawer.getByRole('button', { name: 'Show more' });
    await expect(more).toBeVisible();
    const box = await more.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  });
});
