import { expect, type Page } from '@playwright/test';

// On a wide screen the Filters button ("Filters", or "Filters · n" with n groups off their default) opens a popover that holds the
// groups besides the period (Group by, Repos, Provider, Author). It is a dialog named Filters; the phone's sheet is another dialog
// with the same name.
export const filtersButton = (page: Page) => page.getByRole('button', { name: /^Filters/ });
export const filtersPanel = (page: Page) => page.getByRole('dialog', { name: 'Filters' });

/** Opens the Filters popover if it is not open, and returns it. Closing it is Escape (focus returns to its button). */
export async function openFilters(page: Page) {
  const panel = filtersPanel(page);
  if (!(await panel.isVisible())) await filtersButton(page).click();
  await expect(panel).toBeVisible();
  return panel;
}

export async function closeFilters(page: Page) {
  await page.keyboard.press('Escape');
  await expect(filtersPanel(page)).toBeHidden();
}
