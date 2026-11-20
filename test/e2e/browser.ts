import type { LaunchOptions } from '@playwright/test';

// The one place the browser's launch settings live. playwright.config.ts puts them in `use`, global-setup.ts
// launches with them once as a preflight, and the page fixture (fixtures.ts) launches a fresh browser per test
// from the same configured values, so all three always agree.
//
// Why these arguments: the browser is Playwright's headless shell (the build pinned by @playwright/test, found
// through PLAYWRIGHT_BROWSERS_PATH), and on the macOS runner it runs in one process. In that mode a browser
// shared by several contexts crashes on the second test, hence the fresh browser per test in fixtures.ts.
// There is no `channel`: no installed Chrome is used. WebKit and Safari are not covered; those checks stay manual.
export const LAUNCH_OPTIONS: LaunchOptions = {
  args: ['--single-process', '--in-process-gpu'],
};

export const HEADLESS = true;

// Context settings every test gets, so dates and text do not depend on the machine running them.
export const CONTEXT_OPTIONS = {
  locale: 'en-US',
  timezoneId: 'America/Los_Angeles',
} as const;
