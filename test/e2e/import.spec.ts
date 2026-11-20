import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import { failures, measureContainment } from './helpers/containment';
import { makeHome, openMachine, usageTotals } from './helpers/machine';
import { ORIGIN } from './helpers/virtualOrigin';

// Local import (M5, G5_5, G5_7, G5_9) in the real build in a real browser: the app reads a MACHINE, a temp HOME holding copies of the
// INVENTED fixture logs where Claude Code and Codex keep their history, through the real adapters, discovery, runner and API
// (test/e2e/helpers/machine.ts). What is shown is what the importer made of invented files; no real E1 or E2 run is claimed.
//
// The clock is the seed's fixed one (Wed 2026-11-04 9:42 AM in America/Los_Angeles); the fixture sessions are from September and
// October 2026, inside the 366 days retention keeps.

const localSection = (page: Page): Locator =>
  page.getByRole('region', { name: 'On this machine', exact: true });
const rowOf = (page: Page, name: string): Locator =>
  localSection(page).getByRole('listitem').filter({ hasText: name });
const bannerOf = (page: Page): Locator =>
  page.getByRole('status').filter({ hasText: 'Refresh failed.' });
const tagOf = (row: Locator, text: string): Locator => row.getByText(text, { exact: true });

test.describe('the first import', () => {
  test('shows how far each source has got, with no folder to pick, and ends with both Found', async ({
    page,
  }) => {
    const machine = await openMachine(page, { hold: true });
    machine.startFirstRun(); // what `pnpm start` does when it is listening: the timer's run, no button pressed
    await page.goto(`${ORIGIN}/sources`);

    const codex = rowOf(page, 'Codex');
    const claude = rowOf(page, 'Claude Code');
    // While it goes: each source says it is refreshing and how many files it is on, in words.
    await expect(tagOf(codex, 'Refreshing…')).toBeVisible();
    await expect(tagOf(claude, 'Refreshing…')).toBeVisible();
    await expect(codex.getByText(/^Importing 0 of \d+ files?$/)).toBeVisible();
    await expect(claude.getByText(/^Importing 0 of \d+ files?$/)).toBeVisible();

    // There is nothing to choose: discovery found the folders by itself.
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    await expect(
      page.getByRole('button', {
        name: /browse|choose (a )?(folder|path)|select (a )?(folder|path)/i,
      }),
    ).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: /folder|path|directory/i })).toHaveCount(0);

    machine.release();
    await expect(tagOf(codex, 'Found')).toBeVisible();
    await expect(tagOf(claude, 'Found')).toBeVisible();
    await expect(codex.getByText(/^Importing/)).toHaveCount(0);
    // What was found, in the document's words: where, and the history the importer holds.
    await expect(codex.getByText(/History from Sep 28, 2026/)).toBeVisible();
    await expect(claude.getByText(/History from Oct \d+, 2026/)).toBeVisible();
    expect(usageTotals(machine.db)).toMatchObject({ events: 18, sessions: 9 });
    expect(machine.logs.join('\n')).not.toMatch(/SENTINEL/);
  });

  test('the imported history is on Usage', async ({ page }) => {
    const machine = await openMachine(page);
    machine.startFirstRun();
    await page.goto(`${ORIGIN}/sources`);
    await expect(tagOf(rowOf(page, 'Codex'), 'Found')).toBeVisible();
    await expect(tagOf(rowOf(page, 'Claude Code'), 'Found')).toBeVisible();

    await page.goto(`${ORIGIN}/usage?start=2026-09-01&end=2026-11-04`);
    await expect(
      page.getByRole('heading', { level: 2, name: 'Sessions by repository' }),
    ).toBeVisible();
    // Real sessions from the folders, not the seed: the fixture sessions have no GitHub repo, so they sit in Unknown repo.
    await expect(
      page.locator('section[aria-labelledby="us-tree-title"] button[aria-expanded]').first(),
    ).toBeVisible();
    expect(usageTotals(machine.db).sessions).toBe(9);
  });

  test('on a machine with neither provider, both say Not found and nothing is a failure', async ({
    page,
  }) => {
    await openMachine(page, { home: makeHome({ empty: true }) }).then((machine) =>
      machine.startFirstRun(),
    );
    await page.goto(`${ORIGIN}/sources`);
    await expect(tagOf(rowOf(page, 'Codex'), 'Not found')).toBeVisible();
    await expect(tagOf(rowOf(page, 'Claude Code'), 'Not found')).toBeVisible();
    await expect(rowOf(page, 'Codex').getByRole('button', { name: 'Check again' })).toBeVisible();
    await expect(bannerOf(page)).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
  });
});

// A line the importer cannot read is counted, never kept (P-04): the row says how many, from the number the server stored, so it is
// still there after a reload and after a refresh that reads nothing new. The line itself is in no part of the page.
const TRANSCRIPT =
  '.claude/projects/-fixture-SENTINEL_CWD_a1b2c3-app/11111111-aaaa-4aaa-8aaa-000000000001.jsonl';
const BROKEN_LINE = 'SENTINEL_GARBAGE_7c1e5a this line is not JSON';

/** A machine whose Claude Code history holds one line that is not JSON. */
function homeWithOneBrokenLine(): string {
  const home = makeHome();
  appendFileSync(join(home, TRANSCRIPT), `${BROKEN_LINE}\n`);
  return home;
}

interface SourcesAnswer {
  sources: { id: string; status: string; unreadable?: number }[];
}

test.describe('a source with a line it could not read', () => {
  test('says how many, after a reload and after a refresh with nothing new, and shows no line', async ({
    page,
  }) => {
    const machine = await openMachine(page, { home: homeWithOneBrokenLine() });
    machine.startFirstRun();
    await page.goto(`${ORIGIN}/sources`);
    const claude = rowOf(page, 'Claude Code');
    await expect(tagOf(claude, 'Partial · 1 unreadable')).toBeVisible();
    await expect(tagOf(rowOf(page, 'Codex'), 'Found')).toBeVisible();
    // The good lines came in: the broken one cost nothing else.
    expect(usageTotals(machine.db)).toMatchObject({ events: 18, sessions: 9 });

    // The number on the row is the one the API stores and sends.
    const answer = await page.evaluate(
      async () => (await (await fetch('/api/sources')).json()) as SourcesAnswer,
    );
    expect(answer.sources.find((source) => source.id === 'claude')).toMatchObject({
      status: 'partial',
      unreadable: 1,
    });

    // A reload reads it from the server again: the count is still there, not only a bare "Partial".
    await page.reload();
    await expect(tagOf(rowOf(page, 'Claude Code'), 'Partial · 1 unreadable')).toBeVisible();
    await expect(tagOf(rowOf(page, 'Claude Code'), 'Partial')).toHaveCount(0);

    // A refresh that reads nothing new keeps the count and does not count the same line twice.
    await rowOf(page, 'Claude Code').getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(rowOf(page, 'Claude Code').getByText(/Importing/)).toHaveCount(0);
    await expect(tagOf(rowOf(page, 'Claude Code'), 'Partial · 1 unreadable')).toBeVisible();
    expect(usageTotals(machine.db)).toMatchObject({ events: 18, sessions: 9 });

    // Only the number is shown: no part of the line is in the page or the logs.
    await expect(page.locator('body')).not.toContainText('SENTINEL');
    expect(await page.content()).not.toContain('SENTINEL_GARBAGE');
    expect(machine.logs.join('\n')).not.toMatch(/SENTINEL/);
  });

  for (const width of [1280, 390, 320]) {
    test(`has no layout FAIL and no axe violation at ${width}px with the count showing @a11y`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const machine = await openMachine(page, { home: homeWithOneBrokenLine() });
      machine.startFirstRun();
      await page.goto(`${ORIGIN}/sources`);
      await expect(tagOf(rowOf(page, 'Claude Code'), 'Partial · 1 unreadable')).toBeVisible();
      await expect(tagOf(rowOf(page, 'Codex'), 'Found')).toBeVisible();
      expect(failures(await measureContainment(page))).toEqual([]);
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(
        violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
      ).toEqual([]);
    });
  }
});

test.describe('a folder that cannot be read, then Retry', () => {
  test('fails the source with its last success and cached data, and Retry imports nothing twice', async ({
    page,
  }) => {
    const machine = await openMachine(page);
    machine.startFirstRun();
    await page.goto(`${ORIGIN}/sources`);
    const claude = rowOf(page, 'Claude Code');
    await expect(tagOf(claude, 'Found')).toBeVisible();
    const before = usageTotals(machine.db);
    expect(before.events).toBeGreaterThan(0);

    // A real EACCES on both places Claude Code keeps its transcripts.
    await machine.deny(
      [join(machine.home, '.claude/projects'), join(machine.home, '.config/claude/projects')],
      async () => {
        await page.getByRole('button', { name: 'Refresh all' }).first().click();
        await expect(tagOf(claude, 'Access denied')).toBeVisible();
        await expect(bannerOf(page)).toBeVisible();
        await expect(bannerOf(page)).toContainText('Claude Code');
        await expect(bannerOf(page)).toContainText('Previously collected records are kept.');
        // The last success is still on the row, and what was imported is untouched.
        await expect(claude.getByText(/Last successful refresh: (today|Nov)/i)).toBeVisible();
        expect(usageTotals(machine.db)).toEqual(before);
        // The other source did not suffer for it.
        await expect(tagOf(rowOf(page, 'Codex'), 'Found')).toBeVisible();
      },
    );

    // The folders are readable again: Retry brings Claude Code back and counts nothing a second time.
    await claude.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(tagOf(claude, 'Found')).toBeVisible();
    await expect(bannerOf(page)).toHaveCount(0);
    expect(usageTotals(machine.db)).toEqual(before);
    expect(machine.logs.join('\n')).not.toMatch(/SENTINEL/);
  });

  test('a first import that cannot read the folder fails with nothing imported, and Retry imports it all', async ({
    page,
  }) => {
    const machine = await openMachine(page);
    await page.goto(`${ORIGIN}/sources`);
    await machine.deny([join(machine.home, '.codex')], async () => {
      machine.startFirstRun();
      await expect(tagOf(rowOf(page, 'Codex'), 'Access denied')).toBeVisible();
      await expect(tagOf(rowOf(page, 'Claude Code'), 'Found')).toBeVisible();
    });
    const partway = usageTotals(machine.db);
    expect(partway.sessions).toBe(6); // Claude Code's only
    await rowOf(page, 'Codex').getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(tagOf(rowOf(page, 'Codex'), 'Found')).toBeVisible();
    expect(usageTotals(machine.db)).toMatchObject({ sessions: 9 });
  });
});

test.describe('the Sources page during an import', () => {
  test('keeps its buttons reachable by keyboard while the run goes', async ({ page }) => {
    const machine = await openMachine(page, { hold: true });
    machine.startFirstRun();
    await page.goto(`${ORIGIN}/sources`);
    const refresh = rowOf(page, 'Codex').getByRole('button', { name: 'Refresh', exact: true });
    await expect(rowOf(page, 'Codex').getByText(/^Importing/)).toBeVisible();
    await refresh.focus();
    await expect(refresh).toBeFocused();
    // Busy is aria-disabled, not disabled: the button keeps focus, and a press is ignored while the run goes.
    await expect(refresh).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Enter');
    await expect(refresh).toBeFocused();
    machine.release();
    await expect(tagOf(rowOf(page, 'Codex'), 'Found')).toBeVisible();
  });

  for (const width of [1280, 390, 320]) {
    test(`has no layout FAIL and no axe violation at ${width}px with the progress line showing @a11y`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const machine = await openMachine(page, { hold: true });
      machine.startFirstRun();
      await page.goto(`${ORIGIN}/sources`);
      await expect(rowOf(page, 'Codex').getByText(/^Importing 0 of/)).toBeVisible();
      await expect(rowOf(page, 'Claude Code').getByText(/^Importing 0 of/)).toBeVisible();
      // Where each source was found is a path with no spaces in it, and the home is named long (helpers/machine.ts), so at a phone
      // width it cannot fit on one line. It must wrap inside its row, never widen the page, and still read in full.
      const locations = {
        Codex: join(machine.home, '.codex/sessions'),
        'Claude Code': join(machine.home, '.config/claude/projects'),
      };
      for (const [name, path] of Object.entries(locations)) {
        const location = rowOf(page, name).locator('span.font-mono');
        await expect(location).toHaveText(path);
        if (width <= 390) {
          expect(await location.evaluate((el) => el.getClientRects().length)).toBeGreaterThan(1);
        }
      }
      expect(failures(await measureContainment(page))).toEqual([]);
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(
        violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
      ).toEqual([]);
      machine.release();
    });
  }
});
