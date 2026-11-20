import type { Page } from '@playwright/test';
import { gate } from '../fixtures/scripted-adapters/scripted';
import { expect, test } from './fixtures';
import { ORIGIN } from './helpers/virtualOrigin';
import { openWorld } from './helpers/world';

// Functional journeys through the real build in a real browser: the six routes (Overview to HQ and Sources) plus setup render, and the
// navigation moves between them. Untagged on purpose, so they belong to the functional group (C7).
async function open(page: Page, path: string) {
  await openWorld(page);
  await page.goto(`${ORIGIN}${path}`);
}

// Every route has its h1 and title. Every screen is built (Usage and Sources & repos from M4, Delivery from M6, Overview and
// Trends from M7, Setup from M10) and has its own spec for what it shows, so only the heading and title are asserted here. (An
// Overview heading reads "Overview: Good morning, ..." for a reader, so the name is matched as a substring, as Playwright does
// by default.) The world has finished setup, so /setup is looked at again, as it can be after the first launch.
const PAGES: Array<[path: string, heading: string]> = [
  ['/', 'Overview'],
  ['/trends', 'Trends'],
  ['/delivery', 'Delivery'],
  ['/usage', 'Usage'],
  ['/hq', 'HQ'],
  ['/sources', 'Sources & repos'],
  ['/setup', 'Setup'],
];

for (const [path, heading] of PAGES) {
  test(`${path} renders "${heading}" and is not Under Construction`, async ({ page }) => {
    await open(page, path);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(page.getByText('Under Construction')).toHaveCount(0);
    await expect(page).toHaveTitle(`${heading} · Agent Productivity HQ`);
  });
}

test('the navigation moves between pages and marks the current one', async ({ page }) => {
  await open(page, '/');
  const nav = page.getByRole('navigation', { name: 'Sections' });
  await nav.getByRole('link', { name: 'Delivery' }).click();
  await expect(page).toHaveURL(`${ORIGIN}/delivery`);
  await expect(page.getByRole('heading', { level: 1, name: 'Delivery' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Delivery' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('link', { name: 'Overview' })).not.toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('heading', { level: 1, name: 'Delivery' })).toBeFocused();
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeFocused();
});

test('a deferred page shows loading and can be reloaded after its bundle fails', async ({
  page,
}) => {
  await open(page, '/');
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  const scripts = '**/assets/*.js';
  const pending = gate();
  await page.route(scripts, async (route) => {
    await pending.promise;
    await route.abort();
  });
  const nav = page.getByRole('navigation', { name: 'Sections' });
  try {
    await nav.getByRole('link', { name: 'Delivery' }).click();
    await expect(page.getByText('Loading page…', { exact: true })).toBeVisible();
    await expect(nav).toBeVisible();
  } finally {
    pending.release();
  }
  await expect(page.getByRole('heading', { name: 'This page couldn’t load' })).toBeFocused();
  await expect(nav).toBeVisible();
  await page.unroute(scripts);
  await page.getByRole('button', { name: 'Reload page' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Delivery' })).toBeVisible();
});

test('an unknown address shows a way back, not a blank page', async ({ page }) => {
  await open(page, '/no/such/page');
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to Overview' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
});

for (const width of [1280, 390]) {
  test(`the Sources nav item shows the reported issue count at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await open(page, '/');
    // The typical seeded world has one thing needing attention: the repo GitHub no longer grants access to.
    const nav = page.getByRole('navigation', { name: 'Sections' });
    const sources = nav.getByRole('link', { name: /^Sources & repos\s*, 1 issue$/ });
    await expect(sources).toBeVisible();
    const appBar = page.getByRole('banner');
    // No Sources link in the app bar. Its only link is HQ's, shown on a phone in place of a sixth tab.
    await expect(appBar.getByRole('link', { name: /Sources/ })).toHaveCount(0);
    await expect(appBar.getByRole('link')).toHaveCount(width < 720 ? 1 : 0);
    await expect(appBar.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
    await sources.click();
    await expect(page).toHaveURL(`${ORIGIN}/sources`);
    await expect(sources).toHaveAttribute('aria-current', 'page');
  });
}
