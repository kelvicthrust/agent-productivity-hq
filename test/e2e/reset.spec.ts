import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';
import { ORIGIN } from './helpers/virtualOrigin';

test('cancels a reset, then starts onboarding again after confirmation', async ({
  page,
  world,
}) => {
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${ORIGIN}/sources`);
  await expect(page).toHaveTitle(/Sources & repos/);
  const originalRepos = world.db.prepare('SELECT count(*) AS n FROM repo').get()?.['n'];
  expect(originalRepos).toBeGreaterThan(0);

  const reset = page.getByRole('button', { name: 'Reset app', exact: true });
  const dialog = page.getByRole('alertdialog', { name: 'Reset Agent Productivity HQ?' });
  const cancel = dialog.getByRole('button', { name: 'Cancel' });
  await reset.click();
  await expect(dialog).toBeVisible();
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(reset).toBeFocused();
  expect(world.db.prepare('SELECT count(*) AS n FROM repo').get()).toEqual({ n: originalRepos });

  await reset.click();
  await dialog.getByRole('button', { name: 'Reset app and start over' }).click();
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('find your agents');
  for (const table of ['repo', 'session', 'usage_event', 'pr_session_link', 'account_snapshot']) {
    expect(world.db.prepare(`SELECT count(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
  }
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Connect GitHub' }).click();
  await expect(page.getByText('Using your GitHub CLI sign-in', { exact: true })).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

test(
  'the confirmation is accessible on a narrow screen',
  { tag: ['@a11y', '@responsive'] },
  async ({ page, world }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto(`${ORIGIN}/sources`);
    const reset = page.getByRole('button', { name: 'Reset app', exact: true });
    await reset.click();
    const dialog = page.getByRole('alertdialog', { name: 'Reset Agent Productivity HQ?' });
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    await dialog.evaluate(async (element) => {
      const animations = element.getAnimations({ subtree: true });
      await Promise.all(animations.map((animation) => animation.finished));
    });
    const { violations } = await new AxeBuilder({ page }).include('[role="alertdialog"]').analyze();
    expect(
      violations.map(({ id, nodes }) => ({ id, nodes: nodes.map((node) => node.failureSummary) })),
    ).toEqual([]);
    const screenshot = testInfo.outputPath('reset-confirmation.png');
    await page.screenshot({ path: screenshot });
    await testInfo.attach('reset-confirmation', {
      path: screenshot,
      contentType: 'image/png',
    });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(reset).toBeFocused();
    expect(world.db.prepare('SELECT count(*) AS n FROM repo').get()?.['n']).toBeGreaterThan(0);
  },
);
