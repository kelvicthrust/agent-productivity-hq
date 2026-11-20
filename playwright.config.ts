import { defineConfig } from '@playwright/test';
import { CONTEXT_OPTIONS, HEADLESS, LAUNCH_OPTIONS } from './test/e2e/browser';

// Browser tests. They load the production build through request interception (test/e2e/helpers/virtualOrigin.ts),
// so no dev server or port is needed. The browser is Playwright's headless shell, the build pinned by
// @playwright/test, installed in PLAYWRIGHT_BROWSERS_PATH before checks run (checks never install). Launch
// settings come from one module, test/e2e/browser.ts. Specs import `test` from test/e2e/fixtures.ts, which gives
// every test a fresh browser. Groups: untagged specs are functional (C7), @a11y is keyboard, focus and axe (C8),
// @responsive is layout at the viewport widths (C9).
export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './test/e2e/global-setup.ts',
  fullyParallel: true,
  // PDLC's share of this machine for test work (half the cores split across its agents); Playwright's default otherwise. The
  // variable is text, and Playwright refuses text here ("must be a number or percentage"), so it is turned into a number first.
  workers: Number(process.env.PDLC_TEST_WORKERS) || '50%',
  reporter: [['list']],
  use: {
    headless: HEADLESS,
    launchOptions: LAUNCH_OPTIONS,
    ...CONTEXT_OPTIONS,
  },
});
