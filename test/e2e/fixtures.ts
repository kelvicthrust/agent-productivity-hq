import { chromium, expect, test as base } from '@playwright/test';
import { createWorld, serveWorld, type World, type WorldOptions } from './helpers/world';

// `test` for every browser spec. It overrides `page` so each test gets its OWN browser, launched from the
// configured values (launchOptions, headless, viewport, locale, timezoneId; see browser.ts and
// playwright.config.ts) and closed when the test ends. Playwright's shared worker browser is never started,
// because in single-process mode reusing one browser across contexts crashes on the second test.
export const test = base.extend<{ worldOptions: WorldOptions; world: World }>({
  // Which seeded world a spec gets: `test.use({ worldOptions: { scenario: 'refresh-failed' } })`. The default is the typical world.
  worldOptions: [{}, { option: true }],
  // The real app and a seeded database behind http://crew.test/api, with the production build served at the same origin.
  // Ask for `world` in a spec that loads a page needing data. It is closed (database and temp folder removed) after the test.
  world: async ({ page, worldOptions }, provide) => {
    const world = createWorld(worldOptions);
    try {
      await serveWorld(page, world);
      await provide(world);
    } finally {
      world.close();
    }
  },
  // The callback is named `provide`, not Playwright's usual `use`, so the React-hooks lint rule does not mistake it for React's `use`.
  page: async ({ launchOptions, headless, viewport, locale, timezoneId }, provide) => {
    const browser = await chromium.launch({ ...launchOptions, headless });
    try {
      const context = await browser.newContext({ viewport, locale, timezoneId });
      await provide(await context.newPage());
    } finally {
      await browser.close();
    }
  },
});

export { expect };
