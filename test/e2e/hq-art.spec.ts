import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { FIXED_NOW } from '../fixtures/seed.ts';
import type { HqScenario } from '../fixtures/hq/scripted.ts';
import { expect, test } from './fixtures';
import { failures, measureContainment } from './helpers/containment';
import { ORIGIN } from './helpers/virtualOrigin';
import { openWorld } from './helpers/world';

// HQ's drawn text is the self-hosted Shantell Sans (theme/globals.css), the critters stand in for the buddies on every other screen,
// and none of it asks anything of the network beyond the dashboard's own origin.

async function openHq(page: Page, width: number, hq: HqScenario = 'office'): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await openWorld(page, { hq });
  await page.clock.setFixedTime(new Date(FIXED_NOW));
  await page.goto(`${ORIGIN}/hq`);
  await expect(page.getByRole('heading', { level: 1, name: 'HQ' })).toBeVisible();
  await expect(page.getByTestId('hq-scene')).toBeVisible();
}

test.describe('HQ art', () => {
  test('draws the scene text in the self-hosted Shantell Sans, from this origin only', async ({
    page,
  }) => {
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await openHq(page, 1280);

    const loaded = await page.evaluate(async () => {
      await document.fonts.load("600 15px 'Shantell Sans'");
      await document.fonts.ready;
      return {
        check: document.fonts.check("600 15px 'Shantell Sans'"),
        faces: [...document.fonts]
          .filter((face) => face.family.replaceAll('"', '') === 'Shantell Sans')
          .map((face) => face.status),
      };
    });
    expect(loaded.check).toBe(true);
    expect(loaded.faces).toEqual(['loaded']);

    // Every drawn word is set in it: the heading, a sign's two lines, a caption and the bench count are all the scene's own text.
    const families = await page.getByTestId('hq-scene').evaluate((scene) => {
      const own = [...scene.querySelectorAll('p, text')].filter((el) => el.textContent?.trim());
      return {
        count: own.length,
        families: [...new Set(own.map((el) => getComputedStyle(el).fontFamily.split(',')[0]))],
      };
    });
    expect(families.count).toBeGreaterThan(8);
    expect(families.families).toEqual(['"Shantell Sans"']);

    // It is the dashboard's own file, and nothing in the whole page load went to another origin.
    const files = requests.filter((url) => /\.woff2(\?|$)/.test(url));
    expect(files.filter((url) => /shantell-sans-latin-wght-.*\.woff2$/.test(url))).toHaveLength(1);
    expect(requests.filter((url) => new URL(url).origin !== ORIGIN)).toEqual([]);
    expect(requests.filter((url) => /fonts\.(googleapis|gstatic)/.test(url))).toEqual([]);
  });

  test('keeps the roster list in the UI fonts, not the scene handwriting', async ({ page }) => {
    await openHq(page, 1280);
    const family = await page
      .getByRole('list', { name: 'Sessions', exact: true })
      .evaluate((list) => getComputedStyle(list).fontFamily);
    expect(family).not.toContain('Shantell');
  });

  test('draws the critters beside the provider names on the roster', async ({ page }) => {
    await openHq(page, 1280);
    const sessions = page.getByRole('list', { name: 'Sessions', exact: true });
    // A fox is round with ears (a circle and a muzzle ellipse), an owl is a rounded rectangle: the shape says the provider.
    const claude = sessions.getByText('Claude Code', { exact: false }).first();
    const row = claude.locator('xpath=ancestor::li[1]');
    await expect(row.locator('svg ellipse').first()).toBeAttached();
    const codex = sessions
      .getByText('Codex', { exact: false })
      .first()
      .locator('xpath=ancestor::li[1]');
    await expect(codex.locator('svg rect').first()).toBeAttached();
  });
});

test.describe('HQ art accessibility and layout', { tag: ['@a11y', '@responsive'] }, () => {
  for (const width of [1280, 390, 320]) {
    test(`${width}px: axe finds nothing and the page stays inside the window`, async ({ page }) => {
      await openHq(page, width);
      await page.evaluate(() => document.fonts.ready);
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(
        violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
      ).toEqual([]);
      const report = await measureContainment(page);
      expect(report.width).toBe(width);
      expect(failures(report), JSON.stringify(report, null, 2)).toEqual([]);
      expect(report.spill, 'content wider than its own box').toEqual([]);
    });
  }
});
