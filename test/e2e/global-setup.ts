import { resolve } from 'node:path';
import { chromium, type FullConfig } from '@playwright/test';
import { build } from 'vite';
import { HEADLESS, LAUNCH_OPTIONS } from './browser';

/** The lines of a Playwright launch error that say why, without the crash-reporter noise. */
function causeOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const clean = text
    .split('\n')
    .map((line) => line.replace(/^\s*-?\s*\[pid=\d+\]\[err\]\s*/, '').trim())
    .filter(Boolean);
  const fatal = clean.filter(
    (line) =>
      /FATAL|ProcessSingleton|Failed to create|MachPortRendezvous|Executable doesn't exist|is not found/i.test(
        line,
      ) && !/crashpad/i.test(line),
  );
  return (fatal.length > 0 ? fatal : clean).slice(0, 3).join('\n  ');
}

// Before anything else: can a browser start at all? If not, every spec would fail at launch with a stack trace
// that reads like a product failure. Fail once, early, and say plainly that no assertion ran. It launches with the
// same project settings the specs use (browser.ts through the config's `use`).
async function requireBrowser(config: FullConfig): Promise<void> {
  const use = config.projects[0]?.use;
  try {
    const browser = await chromium.launch({
      ...LAUNCH_OPTIONS,
      ...use?.launchOptions,
      channel: use?.channel,
      headless: use?.headless ?? HEADLESS,
    });
    await browser.close();
  } catch (error) {
    throw new Error(
      [
        'Browser checks did not run: no browser could start here, so no assertion was executed.',
        'This is a limit of the environment, not a result about the product.',
        `Why (from the browser):\n  ${causeOf(error)}`,
        "These checks use Playwright's headless shell, the build pinned by @playwright/test, found through PLAYWRIGHT_BROWSERS_PATH. " +
          'If it is missing, install it before running checks: `PLAYWRIGHT_BROWSERS_PATH=<dir> pnpm exec playwright install chromium-headless-shell`. Checks never install it.',
      ].join('\n\n'),
    );
  }
}

// Then build what the specs load, so `pnpm test:e2e` is self-contained: the product SPA and the E7 harness. Like
// `pnpm build`, they are production builds whatever NODE_ENV the shell exported, so the specs test what ships.
export default async function globalSetup(config: FullConfig): Promise<void> {
  await requireBrowser(config);
  const root = resolve(import.meta.dirname, '../..');
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await build({ configFile: resolve(root, 'vite.config.ts'), logLevel: 'warn' });
    await build({ configFile: resolve(root, 'vite.harness.config.ts'), logLevel: 'warn' });
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
}
