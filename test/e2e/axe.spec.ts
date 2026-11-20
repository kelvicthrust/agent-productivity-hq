import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';
import { ORIGIN } from './helpers/virtualOrigin';
import { openWorld } from './helpers/world';

// A real axe-core scan of every page the shell renders, at the three widths that matter: desktop, phone and the
// narrowest phone. It runs axe's default rule set with NO rule disabled and no tag filter, so a violation is a
// failure to fix, not to hide. Tagged @a11y (C8).
const WIDTHS = [1280, 390, 320];
const PAGES: Array<[path: string, name: string]> = [
  ['/', 'Overview'],
  ['/trends', 'Trends'],
  ['/delivery', 'Delivery'],
  ['/usage', 'Usage'],
  ['/hq', 'HQ'],
  ['/sources', 'Sources & repos'],
  ['/setup', 'Setup'],
  ['/no/such/page', 'Page not found'],
];

for (const width of WIDTHS) {
  for (const [path, name] of PAGES) {
    test(`axe: ${name} at ${width}px has no violations`, { tag: '@a11y' }, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openWorld(page);
      await page.goto(`${ORIGIN}${path}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      // Setup's rows fade and its buddy pops in when the page mounts. axe reads a half-faded row at its colour of that instant, so
      // a scan inside the fade reports a contrast failure that is not on the settled screen (it failed on 1 of 3 widths in a full
      // run and passed alone). Waiting for every transition and animation that has an end makes the scan read the screen as it
      // stays; one that never ends (a skeleton's shimmer) is not waited for.
      await page.evaluate(async () => {
        const finite = document
          .getAnimations()
          .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
        await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
      });

      const { violations } = await new AxeBuilder({ page }).analyze();
      const summary = violations.map(
        (v) =>
          `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).join('\n    ')}`,
      );
      expect(summary, `axe found ${violations.length} violation(s)`).toEqual([]);
    });
  }
}
