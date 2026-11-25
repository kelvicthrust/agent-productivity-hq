import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import manifest from '../../package.json' with { type: 'json' };
import { expect, test } from './fixtures';
import { ORIGIN } from './helpers/virtualOrigin';
import { openWorld } from './helpers/world';

// The app shell at the widths where its layout changes. test/shell/shell.test.tsx covers structure and focus in
// jsdom (DOM order, names, route-change focus); this covers what needs real layout. Layout and viewport specs are
// tagged @responsive (C9); keyboard and focus specs are tagged @a11y (C8).
async function open(page: Page, path: string, width: number, height = 800) {
  await page.setViewportSize({ width, height });
  await openWorld(page);
  await page.goto(`${ORIGIN}${path}`);
}
const visibleNav = (page: Page) => page.getByRole('navigation', { name: 'Sections' });

for (const width of [1280, 320]) {
  test(
    `About is an icon button at ${width}px and opens a focused dialog`,
    {
      tag: ['@a11y', '@responsive'],
    },
    async ({ page }) => {
      await open(page, '/', width);
      const banner = page.getByRole('banner');
      const trigger = banner.getByRole('button', { name: 'About Agent Productivity HQ' });
      const dialog = page.getByRole('dialog', { name: 'About Agent Productivity HQ' });
      await expect(trigger).toBeVisible();
      await expect(trigger).toHaveText('');
      await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
      await expect(page.getByText(/Made with ❤️ by/)).toHaveCount(0);
      if (width === 320) {
        const box = (await trigger.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        await trigger.click();
      } else {
        await trigger.focus();
        await page.keyboard.press('Enter');
      }
      await expect(
        dialog.getByRole('heading', { name: 'About Agent Productivity HQ' }),
      ).toBeFocused();
      await expect(dialog.getByText(manifest.version, { exact: true })).toBeVisible();
      await expect(dialog.getByRole('link', { name: 'GitHub repository' })).toHaveAttribute(
        'href',
        'https://github.com/kelvicthrust/agent-productivity-hq',
      );
      await expect(dialog.getByRole('link', { name: 'Release notes' })).toBeVisible();
      await expect(dialog.getByRole('link', { name: 'Setup and troubleshooting' })).toBeVisible();
      await expect(dialog.getByText(/Made with ❤️ by/)).toBeVisible();
      await expect(dialog.getByRole('link', { name: 'kelvicthrust' })).toBeVisible();
      // Scan the settled dialog so its fade-in does not affect the contrast measurement.
      await expect.poll(() => dialog.evaluate((el) => el.getAnimations().length)).toBe(0);
      expect((await new AxeBuilder({ page }).include('dialog[open]').analyze()).violations).toEqual(
        [],
      );
      const { x, width: dialogWidth } = (await dialog.boundingBox())!;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x + dialogWidth).toBeLessThanOrEqual(width);
      if (width === 320) await dialog.getByRole('button', { name: 'Close' }).click();
      else await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
    },
  );
}

for (const width of [1280, 1024, 800, 719, 390, 320]) {
  test(
    `${width}px: the page does not scroll sideways`,
    { tag: '@responsive' },
    async ({ page }) => {
      await open(page, '/usage', width);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    },
  );
}

test(
  '1280px: a 220px pill column, and no phone tab bar',
  { tag: '@responsive' },
  async ({ page }) => {
    await open(page, '/', 1280);
    await expect(visibleNav(page)).toHaveCount(1);
    const box = await visibleNav(page).boundingBox();
    expect(box?.x).toBe(0);
    expect(box?.width).toBeCloseTo(220, 0);
    const links = visibleNav(page).getByRole('link');
    const [first, second] = [await links.nth(0).boundingBox(), await links.nth(1).boundingBox()];
    expect(second?.y).toBeGreaterThan(first?.y ?? 0); // stacked
  },
);

test(
  '1280px: HQ and Sources & repos follow Usage in the rail, spaced like the other items',
  { tag: '@responsive' },
  async ({ page }) => {
    await open(page, '/', 1280);
    const links = visibleNav(page).getByRole('link');
    const [overview, delivery] = [
      await links.nth(0).boundingBox(),
      await links.nth(1).boundingBox(),
    ];
    await expect(links).toHaveCount(7);
    await expect(links.nth(3)).toHaveAccessibleName('Work Review');
    const [usage, hq, sources] = [
      await links.nth(4).boundingBox(),
      await links.nth(5).boundingBox(),
      await links.nth(6).boundingBox(),
    ];
    await expect(links.nth(5)).toHaveAccessibleName('HQ');
    const itemGap = (delivery?.y ?? 0) - ((overview?.y ?? 0) + (overview?.height ?? 0));
    const hqGap = (hq?.y ?? 0) - ((usage?.y ?? 0) + (usage?.height ?? 0));
    const sourcesGap = (sources?.y ?? 0) - ((hq?.y ?? 0) + (hq?.height ?? 0));
    // Each sits directly under the one before: the same few pixels between items as anywhere else, not pinned to the bottom of the rail.
    for (const gap of [hqGap, sourcesGap]) {
      expect(gap).toBeLessThan(itemGap + 4);
      expect(gap).toBeGreaterThanOrEqual(0);
    }
  },
);

test(
  '800px: the same nav is a pill row under the app bar',
  { tag: '@responsive' },
  async ({ page }) => {
    await open(page, '/', 800);
    await expect(visibleNav(page)).toHaveCount(1);
    const links = visibleNav(page).getByRole('link');
    const [first, second] = [await links.nth(0).boundingBox(), await links.nth(1).boundingBox()];
    expect(Math.abs((second?.y ?? 0) - (first?.y ?? 99))).toBeLessThanOrEqual(1); // one row
  },
);

test(
  '390px: a fixed bottom tab bar with 44px-plus targets and the full Sources name',
  { tag: '@responsive' },
  async ({ page }) => {
    await open(page, '/', 390);
    await expect(visibleNav(page)).toHaveCount(1);
    const bar = await visibleNav(page).boundingBox();
    expect((bar?.y ?? 0) + (bar?.height ?? 0)).toBeCloseTo(800, 0); // pinned to the bottom edge
    const links = visibleNav(page).getByRole('link');
    await expect(links).toHaveCount(5);
    for (let i = 0; i < 5; i++) {
      expect((await links.nth(i).boundingBox())?.height).toBeGreaterThanOrEqual(44);
    }
    const sources = visibleNav(page).getByRole('link', { name: 'Sources & repos' });
    await expect(sources).toBeVisible();
    await expect(sources).toContainText('Sources');
  },
);

test(
  'the skip link is the first tab stop and becomes visible',
  { tag: '@a11y' },
  async ({ page }) => {
    await open(page, '/', 1280);
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    expect((await skip.boundingBox())?.y).toBeGreaterThanOrEqual(0);
  },
);

test('navigating moves focus to the new page heading', { tag: '@a11y' }, async ({ page }) => {
  await open(page, '/', 1280);
  await visibleNav(page).getByRole('link', { name: 'Usage' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Usage' })).toBeFocused();
  await expect(page).toHaveTitle('Usage · Agent Productivity HQ');
});
