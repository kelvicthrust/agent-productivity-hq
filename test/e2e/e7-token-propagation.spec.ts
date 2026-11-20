import { expect, test } from './fixtures';
import { ORIGIN, serveBuild } from './helpers/virtualOrigin';

// E7, rendered: change ONE product token on the page and read computed styles from an Astryx Button and from a
// Tailwind-styled element. test/e7/propagation.test.ts proves the same chain statically; this proves it in a
// browser. Untagged on purpose: it belongs to the functional group (C7).
const HARNESS = '.harness-dist';

test('changing --color-action changes an Astryx Button and a Tailwind element', async ({
  page,
}) => {
  await serveBuild(page, HARNESS);
  await page.goto(`${ORIGIN}/index.html`);

  const button = page.getByRole('button', { name: 'Astryx primary' });
  const box = page.getByTestId('tailwind-box');

  // The design's grape, #5A3FD6, reaches both through the one token.
  await expect(box).toHaveCSS('background-color', 'rgb(90, 63, 214)');
  await expect(button).toHaveCSS('background-color', 'rgb(90, 63, 214)');

  await page.evaluate(() =>
    document.documentElement.style.setProperty('--color-action', '#00A878'),
  );

  // The token chain is instant: Astryx's accent role follows --color-action in the same frame.
  const accent = await button.evaluate((el) =>
    getComputedStyle(el).getPropertyValue('--color-accent').trim(),
  );
  expect(accent.toLowerCase()).toBe('#00a878');

  // The painted colour is asserted with retry, because Astryx buttons transition their colour (0.125 s), so
  // computed style lags for a moment. It still fails if the Button never reaches the new colour.
  await expect(box).toHaveCSS('background-color', 'rgb(0, 168, 120)');
  await expect(button).toHaveCSS('background-color', 'rgb(0, 168, 120)');
});
