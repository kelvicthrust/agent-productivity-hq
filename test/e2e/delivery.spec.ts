import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { upsertPullRequests, type PullRequestInput } from '../../src/server/db/queries/prs.ts';
import { PrsResponse } from '../../src/shared/contracts/prs.ts';
import { expect, test } from './fixtures';
import { closeFilters, openFilters } from './helpers/filtersPopover';
import {
  failures,
  findWrappedCells,
  findWrappedPieces,
  measureContainment,
} from './helpers/containment';
import { ORIGIN } from './helpers/virtualOrigin';
import { answerApi, openWorld, type World, type WorldOptions } from './helpers/world';

// The Delivery screen (M6: A23) in a real browser, against the real API over the seeded world: GET /api/prs is the server's own,
// and the spec reads the same API to know what the page should show. Nothing is stubbed except where a test says so (a failing
// request).
//
// What is covered, from the assignment's goals:
//   - the table from 640px and a list of cards below it, chosen by one media query, never a CSS override of table display
//   - the table's scroller: a labelled, focusable region with a visible focus ring, scrolled from the keyboard
//   - the D7 column policy: the Pull request column takes the spare width and no other data cell wraps
//   - PR titles are text, and an address that is not a web address is not a link
//   - evidence rows: the toggle, its name, and the link-evidence panel, shared across the 640px switch
//   - the link-basis tabs, the search and the author filter as URL state; paging; the inaccessible and no-repos states
//   - PRs that arrive through the scripted GitHub when a repository is added
//   - the containment check and axe at 1280, 390 and 320px
//
// The fixed clock is Wed 2026-11-04 in America/Los_Angeles, so the default period is Mon Nov 2 to Sun Nov 8, and the seeded login
// is `kelvin`. Until the link engine (M8) every PR is Unlinked.

// ---- the page ---------------------------------------------------------------------------------------------------------------

interface OpenOptions {
  search?: string;
  world?: WorldOptions;
  height?: number;
  /** Runs against the world before the page loads, to add what the seed does not have. */
  before?: (world: World) => void;
}

async function openDelivery(page: Page, width: number, options: OpenOptions = {}): Promise<World> {
  await page.setViewportSize({ width, height: options.height ?? 900 });
  const world = await openWorld(page, options.world);
  options.before?.(world);
  await page.goto(`${ORIGIN}/delivery${options.search ?? ''}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Delivery' })).toBeVisible();
  return world;
}

/** The real API's answer, for what the page should show. */
async function readApi(world: World, path: string): Promise<unknown> {
  const answer = await answerApi(world.app, { method: 'GET', path, headers: {} });
  return JSON.parse(answer.body.toString('utf8')) as unknown;
}
const prsOf = async (world: World, query = '') =>
  PrsResponse.parse(await readApi(world, `/api/prs${query}`));

const card = (page: Page) =>
  page.getByRole('region', { name: 'Merged pull requests', exact: true });
const table = (page: Page) =>
  page.getByRole('table', { name: /^Merged pull requests with linked sessions/ });
const list = (page: Page) =>
  page.getByRole('list', { name: /^Merged pull requests with linked sessions/ });
const scroller = (page: Page) =>
  page.getByRole('region', { name: 'Pull request table, scrolls sideways' });
/** A PR's row (table) or card (list). */
const rowOf = (page: Page, id: string) => page.locator(`[data-pr-id="${id}"]`);
const searchBox = (page: Page) => page.getByRole('searchbox', { name: 'Search pull requests' });
const tab = (page: Page, name: string | RegExp) => page.getByRole('radio', { name });

const showEvidence = (title: string) => `Show link evidence for ${title}`;
const hideEvidence = (title: string) => `Hide link evidence for ${title}`;

/** A merge in the default week (Mon Nov 2 to Sun Nov 8), by the seeded login, in a tracked and reachable repo. */
const merge = (over: {
  nodeId: string;
  number: number;
  title: string;
  url?: string;
  mergedByLogin?: string;
}): PullRequestInput => ({
  repoId: 'kelvin/atlas-api',
  authorLogin: 'kelvin',
  mergedByLogin: 'kelvin',
  mergedAt: Date.parse('2026-11-04T20:00:00Z'),
  headRef: null,
  baseRef: null,
  mergeCommitSha: null,
  commits: [],
  commitsComplete: true,
  url: `https://github.com/kelvin/atlas-api/pull/${over.number}`,
  ...over,
});

const violationsOf = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).join('\n    ')}`,
  );
};

// ============================================================================================================================
// The table (640px and wider)
// ============================================================================================================================

test.describe('table', () => {
  test('is a real table of six columns, in a labelled and focusable scroller', async ({ page }) => {
    await openDelivery(page, 1280);
    const region = scroller(page);
    await expect(region).toBeVisible();
    await expect(region).toHaveAttribute('tabindex', '0');
    await expect(region.getByRole('table')).toHaveCount(1);
    await expect(table(page).getByRole('columnheader')).toHaveText([
      'Pull request',
      'Merged',
      'Author',
      'Merged by',
      'Linked sessions',
      'Link basis',
    ]);
    await expect(list(page)).toHaveCount(0);
  });

  test('lists the server’s PRs newest first, with merge time in the report timezone, author and merger', async ({
    page,
  }) => {
    const world = await openDelivery(page, 1280);
    const answer = await prsOf(world);
    const items = answer.items!;
    expect(items).toHaveLength(8);

    await expect(table(page).locator('tbody tr')).toHaveCount(items.length);
    // Newest merge first, as the server ordered them.
    const titles = await table(page).locator('tbody tr td:first-child a').allTextContents();
    // The link's text ends with the words only a screen reader hears.
    expect(titles.map((text) => text.replace(/\s*\(opens GitHub\)\s*$/, ''))).toEqual(
      items.map((pr) => pr.title),
    );

    // #400 merged 2026-11-05T00:19Z, which is Nov 4, 4:19 PM in America/Los_Angeles, by you and merged by you.
    const first = rowOf(page, items[0]!.id);
    await expect(first.getByRole('cell').nth(0)).toContainText('open-tools/shared-schemas #400');
    await expect(first.getByRole('cell').nth(1)).toHaveText('Nov 4, 4:19 PM');
    await expect(first.getByRole('cell').nth(1).locator('time')).toHaveAttribute(
      'datetime',
      items[0]!.mergedAt,
    );
    await expect(first.getByRole('cell').nth(2)).toHaveText('You');
    await expect(first.getByRole('cell').nth(3)).toHaveText('You');
    // The seeded world's own links (the link engine's rule, one for every surface): #400 is named by a session's PR reference.
    await expect(first.getByRole('cell').nth(4)).toHaveText('Codex1 session');
    await expect(first.getByRole('cell').nth(5)).toHaveText('Evidence link');

    // Your PR that someone else merged names the merger.
    const byPriya = items.find((pr) => pr.mergedBy === 'priya-s')!;
    await expect(rowOf(page, byPriya.id).getByRole('cell').nth(2)).toHaveText('You');
    await expect(rowOf(page, byPriya.id).getByRole('cell').nth(3)).toHaveText('priya-s');
  });

  test('the title is a link that opens GitHub in a new tab, and says so', async ({ page }) => {
    const world = await openDelivery(page, 1280);
    const pr = (await prsOf(world)).items![0]!;
    const link = page.getByRole('link', { name: `${pr.title} (opens GitHub)` });
    await expect(link).toHaveAttribute('href', pr.url);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
  });

  test('the scope line and the period are in the page head and the card', async ({ page }) => {
    await openDelivery(page, 1280);
    await expect(
      page.getByText('This week · Nov 2 – Nov 8, 2026 · All repos · Authored by you'),
    ).toBeVisible();
    await expect(
      card(page).getByText(
        'All repos · Authored by you · counted on merge date · each PR counts once, however many sessions link to it',
      ),
    ).toBeVisible();
  });

  test('other authors’ PRs appear when the author filter is All, and the page says whose they are', async ({
    page,
  }) => {
    const world = await openDelivery(page, 1280, { search: '?author=all' });
    const all = (await prsOf(world, '?author=all')).items!;
    const bot = all.find((pr) => pr.author === 'dependabot[bot]')!;
    await expect(rowOf(page, bot.id).getByRole('cell').nth(2)).toHaveText('dependabot[bot]');
    // The bot's PR was merged by you.
    await expect(rowOf(page, bot.id).getByRole('cell').nth(3)).toHaveText('You');
    const colleague = all.find((pr) => pr.author === 'jmoreno')!;
    await expect(rowOf(page, colleague.id).getByRole('cell').nth(2)).toHaveText('jmoreno');
    await expect(page.getByText(/All repos · All authors/).first()).toBeVisible();
    expect(all.length).toBeGreaterThan((await prsOf(world)).items!.length);
  });

  test('a PR title is only ever text, and an address that is not a web address is not a link', async ({
    page,
  }) => {
    const hostile = '<img src=x onerror="window.__xss = 1"><b>bold</b> & more';
    await openDelivery(page, 1280, {
      before: (world) =>
        upsertPullRequests(world.db, [
          merge({ nodeId: 'PR_hostile_title', number: 901, title: hostile }),
          merge({
            nodeId: 'PR_hostile_url',
            number: 902,
            title: 'Open the script address',
            url: 'javascript:window.__xss = 2',
          }),
        ]),
    });
    // The title is shown as written, inside a link to its (https) address.
    await expect(page.getByRole('link', { name: `${hostile} (opens GitHub)` })).toBeVisible();
    await expect(page.locator('[data-pr-id] img, [data-pr-id] b')).toHaveCount(0);
    // A script address is not a link at all: the title stays, as plain text.
    await expect(page.getByText('Open the script address')).toBeVisible();
    await expect(page.getByRole('link', { name: /Open the script address/ })).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
    ).toBeUndefined();
  });
});

// ============================================================================================================================
// The table's columns and scroller (D7)
// ============================================================================================================================

test.describe('table columns and scroller', () => {
  // Linked sessions is a stack by design (the providers, then "2 sessions · +1 suggested"): it is held to "no piece breaks", below.
  const DATA_COLUMNS = ['Merged', 'Author', 'Merged by', 'Link basis'];

  for (const width of [1280, 1024, 720, 640]) {
    test(
      `${width}px: Merged, Author, Merged by, Linked sessions and Link basis cells never wrap`,
      { tag: '@responsive' },
      async ({ page }) => {
        await openDelivery(page, width, { search: '?author=all' });
        await expect(table(page)).toBeVisible();
        const report = await findWrappedCells(table(page), DATA_COLUMNS);
        // Not vacuous: eight PRs, each with all four cells.
        expect(report.checked).toBeGreaterThanOrEqual(4 * 8);
        expect(report.wrapped).toEqual([]);
        // The stacked cell: no provider name and no count line breaks across lines (six PRs have linked sessions).
        const pieces = await findWrappedPieces(table(page), 'Linked sessions');
        expect(pieces.checked).toBeGreaterThanOrEqual(6);
        expect(pieces.wrapped).toEqual([]);
      },
    );
  }

  test(
    'the Pull request column takes the spare width at 1280px, and a long title wraps inside it',
    { tag: '@responsive' },
    async ({ page }) => {
      const long =
        'Rework the usage importer so every provider adapter reports partial history and cached recent days consistently across refreshes and retries';
      await openDelivery(page, 1280, {
        before: (world) =>
          upsertPullRequests(world.db, [
            merge({ nodeId: 'PR_long_title', number: 903, title: long }),
          ]),
      });
      await expect(table(page)).toBeVisible();
      const widths = await table(page)
        .getByRole('columnheader')
        .evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect().width));
      const [pr, ...rest] = widths;
      expect(pr).toBeGreaterThan(Math.max(...rest));
      // The table fits: nothing scrolls sideways at this width.
      expect(
        await scroller(page).evaluate((el) => el.scrollWidth - el.clientWidth),
      ).toBeLessThanOrEqual(0);
      // The long title wrapped onto more than one line instead of stretching its column.
      const lines = await page
        .getByRole('link', { name: `${long} (opens GitHub)` })
        .evaluate((el) => el.getClientRects().length);
      expect(lines).toBeGreaterThan(1);
      const report = await findWrappedCells(table(page), DATA_COLUMNS);
      expect(report.wrapped).toEqual([]);
      expect((await findWrappedPieces(table(page), 'Linked sessions')).wrapped).toEqual([]);
    },
  );

  test(
    'never overrides table display: the table, its rows and its cells keep their own display',
    { tag: '@responsive' },
    async ({ page }) => {
      for (const width of [1280, 640]) {
        await openDelivery(page, width);
        await page
          .getByRole('button', { name: /^Show link evidence for/ })
          .first()
          .click();
        const displays = await table(page).evaluate((element) => {
          const of = (selector: string) => [
            ...new Set(
              Array.from(element.querySelectorAll(selector)).map(
                (el) => getComputedStyle(el).display,
              ),
            ),
          ];
          return {
            table: getComputedStyle(element).display,
            thead: of('thead'),
            tbody: of('tbody'),
            tr: of('tr'),
            cells: of('td, th'),
          };
        });
        expect(displays, `${width}px`).toEqual({
          table: 'table',
          thead: ['table-header-group'],
          tbody: ['table-row-group'],
          tr: ['table-row'],
          cells: ['table-cell'],
        });
      }
    },
  );

  test(
    '640px: a table too narrow for its columns scrolls inside its own region, and the page does not',
    { tag: '@responsive' },
    async ({ page }) => {
      await openDelivery(page, 640);
      const sizes = await scroller(page).evaluate((el) => ({
        scroll: el.scrollWidth,
        client: el.clientWidth,
      }));
      expect(sizes.scroll).toBeGreaterThan(sizes.client);
      const sideways = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(sideways).toBeLessThanOrEqual(0);
    },
  );

  test(
    'the scroller is reachable by keyboard, shows a focus ring, and scrolls with the arrow keys',
    { tag: '@a11y' },
    async ({ page }) => {
      await openDelivery(page, 640);
      const region = scroller(page);
      expect(
        await region.evaluate((el) => el.scrollWidth - el.clientWidth),
        'the table must be wider than its region at 640px for this check',
      ).toBeGreaterThan(0);

      let reached = false;
      for (let presses = 0; presses < 80 && !reached; presses += 1) {
        await page.keyboard.press('Tab');
        reached = await region.evaluate((el) => el === document.activeElement);
      }
      expect(reached, 'Tab reaches the scroller').toBe(true);

      const ring = await region.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          style: style.outlineStyle,
          width: parseFloat(style.outlineWidth),
          color: style.outlineColor,
        };
      });
      expect(ring.style).toBe('solid');
      expect(ring.width).toBeGreaterThanOrEqual(2);
      expect(ring.color).toBe('rgb(90, 63, 214)'); // --color-focus

      await page.keyboard.press('ArrowRight');
      await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
      await page.keyboard.press('ArrowLeft');
      await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBe(0);
    },
  );
});

// ============================================================================================================================
// The phone list (below 640px)
// ============================================================================================================================

test.describe('phone list', () => {
  test(
    'below 640px the PRs are a list; at 640px they are a table: one switch, exactly at the breakpoint',
    { tag: '@responsive' },
    async ({ page }) => {
      await openDelivery(page, 639);
      await expect(list(page)).toBeVisible();
      await expect(page.getByRole('table')).toHaveCount(0);
      await expect(scroller(page)).toHaveCount(0);

      await page.setViewportSize({ width: 640, height: 900 });
      await expect(table(page)).toBeVisible();
      await expect(list(page)).toHaveCount(0);
    },
  );

  test(
    'each card states Merged, Author, Merged by, Linked sessions and Link basis once, under its title',
    { tag: '@responsive' },
    async ({ page }) => {
      const world = await openDelivery(page, 390);
      const items = (await prsOf(world)).items!;
      const cards = list(page).getByRole('listitem');
      await expect(cards).toHaveCount(items.length);
      const first = rowOf(page, items[0]!.id);
      await expect(first).toContainText('open-tools/shared-schemas #400');
      const labels = await first.locator('dt').allTextContents();
      expect(labels).toEqual(['Merged', 'Author', 'Merged by', 'Linked sessions', 'Link basis']);
      const values = await first.locator('dd').allTextContents();
      expect(values).toEqual(['Nov 4, 4:19 PM', 'You', 'You', 'Codex1 session', 'Evidence link']);
      // Every merge time appears once per card, and no table cell is hidden underneath.
      await expect(list(page).locator('time')).toHaveCount(items.length);
      await expect(page.getByRole('cell')).toHaveCount(0);
    },
  );

  test('the card’s title still opens GitHub, and its toggle is named by the title', async ({
    page,
  }) => {
    const world = await openDelivery(page, 390);
    const pr = (await prsOf(world)).items![0]!;
    await expect(page.getByRole('link', { name: `${pr.title} (opens GitHub)` })).toHaveAttribute(
      'href',
      pr.url,
    );
    await expect(page.getByRole('button', { name: showEvidence(pr.title) })).toBeVisible();
  });

  test('a toggle is a 44px target on a phone', { tag: '@a11y' }, async ({ page }) => {
    const world = await openDelivery(page, 390);
    const pr = (await prsOf(world)).items![0]!;
    const toggle = page.getByRole('button', { name: showEvidence(pr.title) });
    // The drawn chevron is 24px; the pseudo-element around it is the 44px hit area (design-to-code "Touch targets").
    const reach = await toggle.evaluate((el) => {
      const after = getComputedStyle(el, '::before');
      return { width: parseFloat(after.width), height: parseFloat(after.height) };
    });
    expect(reach.width).toBeGreaterThanOrEqual(44);
    expect(reach.height).toBeGreaterThanOrEqual(44);
  });
});

// ============================================================================================================================
// Evidence rows (the panel itself is tested in links.spec.ts; here the row, its toggle and its place in the table)
// ============================================================================================================================

// The footnote every opened PR carries: one on the page per open PR.
const FOOTNOTE = 'A linked session is recorded evidence of involvement';

test.describe('evidence rows', () => {
  test('a PR opens and closes from the keyboard, named by its title, and shows its link evidence', async ({
    page,
  }) => {
    const world = await openDelivery(page, 1280);
    const pr = (await prsOf(world)).items![0]!;
    const toggle = page.getByRole('button', { name: showEvidence(pr.title) });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).not.toHaveAttribute('aria-controls', /./);
    await expect(page.getByText(FOOTNOTE)).toHaveCount(0);

    await toggle.focus();
    await page.keyboard.press('Enter');
    const open = page.getByRole('button', { name: hideEvidence(pr.title) });
    await expect(open).toHaveAttribute('aria-expanded', 'true');
    const panelId = await open.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    const panel = page.locator(`[id="${panelId}"]`);
    // The seeded week names this PR from a session (an evidence link): its basis is shown, and the footnote about what a link means.
    await expect(panel.getByRole('list', { name: `Link evidence: ${pr.title}` })).toBeVisible();
    await expect(panel).toContainText('Basis:');
    await expect(panel).toContainText(FOOTNOTE);
    // Focus stays on the toggle that was pressed, and only this PR is open.
    await expect(open).toBeFocused();
    await expect(page.getByText(FOOTNOTE)).toHaveCount(1);

    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: showEvidence(pr.title) })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(page.getByText(FOOTNOTE)).toHaveCount(0);
  });

  test('the opened row is one block across the table, and the other rows keep six cells', async ({
    page,
  }) => {
    const world = await openDelivery(page, 1280);
    const items = (await prsOf(world)).items!;
    await page.getByRole('button', { name: showEvidence(items[1]!.title) }).click();
    const counts = await table(page)
      .locator('tbody tr')
      .evaluateAll((rows) => rows.map((row) => (row as HTMLTableRowElement).cells.length));
    expect(counts).toHaveLength(items.length + 1);
    expect(counts.filter((n) => n === 1)).toHaveLength(1);
    expect(counts.filter((n) => n === 6)).toHaveLength(items.length);
  });

  test('a PR opened in the table is still open in the list, and the other way round', async ({
    page,
  }) => {
    const world = await openDelivery(page, 1280);
    const pr = (await prsOf(world)).items![2]!;
    await page.getByRole('button', { name: showEvidence(pr.title) }).click();
    await expect(page.getByText(FOOTNOTE)).toHaveCount(1);

    await page.setViewportSize({ width: 390, height: 900 });
    await expect(list(page)).toBeVisible();
    await expect(page.getByRole('button', { name: hideEvidence(pr.title) })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(page.getByText(FOOTNOTE)).toHaveCount(1);

    await page.getByRole('button', { name: hideEvidence(pr.title) }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(table(page)).toBeVisible();
    await expect(page.getByRole('button', { name: showEvidence(pr.title) })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});

// ============================================================================================================================
// Filters, search and paging
// ============================================================================================================================

test.describe('link-basis tabs, search and URL state', () => {
  test('the tabs show the server’s counts, each tab lists the PRs of its class, and the counts do not follow the tab', async ({
    page,
  }) => {
    const world = await openDelivery(page, 1280);
    const { counts } = await prsOf(world);
    // The seeded world's links, read by the one effective-class rule: a PR counts once, in one tab.
    expect(counts).toEqual({ all: 8, evidence: 4, owner: 1, suggested: 1, unlinked: 2 });
    await expect(tab(page, 'All 8')).toBeChecked();
    await expect(tab(page, 'Evidence 4')).toBeVisible();
    await expect(tab(page, 'Owner-confirmed 1')).toBeVisible();
    await expect(tab(page, 'Suggested only 1')).toBeVisible();
    await expect(tab(page, 'Unlinked 2')).toBeVisible();

    await tab(page, 'Evidence 4').click();
    await expect(page).toHaveURL(`${ORIGIN}/delivery?linkClass=evidence`);
    const rows = table(page).locator('tbody tr');
    await expect(rows).toHaveCount(4);
    for (const row of await rows.all())
      await expect(row.getByRole('cell').nth(5)).toHaveText('Evidence link');
    // The counts do not follow the tab.
    await expect(tab(page, 'Unlinked 2')).toBeVisible();

    await tab(page, 'Unlinked 2').click();
    await expect(page).toHaveURL(`${ORIGIN}/delivery?linkClass=unlinked`);
    await expect(rows).toHaveCount(2);
    for (const row of await rows.all()) {
      await expect(row.getByRole('cell').nth(4)).toHaveText('None');
      await expect(row.getByRole('cell').nth(5)).toHaveText('Unlinked');
    }

    // Back undoes a tab, as it undoes a filter.
    await page.goBack();
    await expect(tab(page, 'Evidence 4')).toBeChecked();
    await tab(page, 'All 8').click();
    await expect(page).toHaveURL(`${ORIGIN}/delivery`);
  });

  test('a tab with no PRs says so', async ({ page }) => {
    // Without the owner's decisions nothing is Owner-confirmed (the seeded confirmation goes back to being a suggestion).
    await openDelivery(page, 1280, {
      before: (world) => world.db.prepare('DELETE FROM owner_link_decision').run(),
    });
    await expect(tab(page, 'Owner-confirmed 0')).toBeVisible();
    await tab(page, 'Owner-confirmed 0').click();
    await expect(page).toHaveURL(`${ORIGIN}/delivery?linkClass=owner`);
    await expect(page.getByText('No PRs match these filters.')).toBeVisible();
    await expect(table(page)).toHaveCount(0);
    await expect(tab(page, 'Suggested only 2')).toBeVisible();
  });

  test('the tab comes from the URL on a reload, and is kept when a filter changes', async ({
    page,
  }) => {
    await openDelivery(page, 1280, { search: '?linkClass=unlinked' });
    await expect(tab(page, 'Unlinked 2')).toBeChecked();
    await openFilters(page);
    await page.getByRole('radio', { name: 'All in tracked repos' }).click();
    await closeFilters(page);
    await expect(page).toHaveURL(`${ORIGIN}/delivery?author=all&linkClass=unlinked`);
    await expect(tab(page, /^Unlinked/)).toBeChecked();
  });

  test('typing in the search narrows the list after a pause, writes q to the URL, and clearing restores it', async ({
    page,
  }) => {
    const world = await openDelivery(page, 1280);
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/prs')) requests.push(new URL(request.url()).search);
    });
    const all = (await prsOf(world)).items!;
    const wanted = all.filter((pr) => pr.repo === 'kelvin/notes-cli');
    expect(wanted.length).toBeGreaterThan(0);
    expect(wanted.length).toBeLessThan(all.length);

    await searchBox(page).fill('notes-cli');
    await expect(table(page).locator('tbody tr')).toHaveCount(wanted.length);
    await expect(page).toHaveURL(`${ORIGIN}/delivery?q=notes-cli`);
    // The search is the server's: it asks for q, and the counts on the tabs stay put.
    expect(requests.some((search) => search.includes('q=notes-cli'))).toBe(true);
    await expect(tab(page, 'All 8')).toBeVisible();

    await searchBox(page).fill('');
    await expect(table(page).locator('tbody tr')).toHaveCount(all.length);
    await expect(page).toHaveURL(`${ORIGIN}/delivery`);
  });

  test('a search that finds nothing says so, and Back restores the box', async ({ page }) => {
    await openDelivery(page, 1280);
    await searchBox(page).fill('zzzz-not-a-pr');
    await expect(page.getByText('No PRs match these filters.')).toBeVisible();
    // Typing replaces its own history entry, so Back leaves the screen rather than stepping through every key.
    await tab(page, 'Unlinked 2').click();
    await expect(page).toHaveURL(`${ORIGIN}/delivery?q=zzzz-not-a-pr&linkClass=unlinked`);
    await page.goBack();
    await expect(page).toHaveURL(`${ORIGIN}/delivery?q=zzzz-not-a-pr`);
    await expect(searchBox(page)).toHaveValue('zzzz-not-a-pr');
  });

  test('a link from Usage (?q=owner/name#number) opens with the box filled and that PR listed', async ({
    page,
  }) => {
    const world = await openDelivery(page, 1280, {
      search: `?q=${encodeURIComponent('kelvin/atlas-api#316')}`,
    });
    const pr = (await prsOf(world)).items!.find((item) => item.number === 316)!;
    await expect(searchBox(page)).toHaveValue('kelvin/atlas-api#316');
    await expect(table(page).locator('tbody tr')).toHaveCount(1);
    await expect(rowOf(page, pr.id)).toBeVisible();
  });

  // Nov 1 is a day that has happened and had no merges. A day that has not happened is another sentence ("This period hasn’t happened yet"),
  // which test/e2e/drawer.spec.ts checks where the drawer opens Delivery on one.
  test('a period with no PRs says so in words, naming who the author filter leaves out', async ({
    page,
  }) => {
    await openDelivery(page, 1280, { search: '?start=2026-11-01&end=2026-11-01' });
    await expect(page.getByText('No merged PRs in this period authored by you.')).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    await openFilters(page);
    await page.getByRole('radio', { name: 'All in tracked repos' }).click();
    await closeFilters(page);
    await expect(page.getByText('No merged PRs in this period.', { exact: true })).toBeVisible();
  });

  test('the default period follows the clock', async ({ page }) => {
    const world = await openDelivery(page, 1280);
    await expect(page.getByText('This week · Nov 2 – Nov 8, 2026')).toBeVisible();
    // A week later nothing was merged yet: the page opens on the new week, with its own empty state.
    world.setNow(Date.parse('2026-11-11T17:42:00Z'));
    await page.reload();
    await expect(page.getByText('This week · Nov 9 – Nov 15, 2026')).toBeVisible();
    await expect(page.getByText('No merged PRs in this period authored by you.')).toBeVisible();
  });
});

test.describe('paging', () => {
  const LAST_90 = '?start=2026-08-07&end=2026-11-04&author=all';

  test('shows 50 at a time with how many are not shown, and moves focus to the first PR it adds', async ({
    page,
  }) => {
    const world = await openDelivery(page, 1280, { search: LAST_90 });
    const total = (await prsOf(world, LAST_90)).counts!.all!;
    expect(total).toBeGreaterThan(100);

    const rows = table(page).locator('tbody tr');
    await expect(rows).toHaveCount(50);
    await expect(page.getByText(`${total - 50} not shown`)).toBeVisible();
    const more = page.getByRole('button', { name: 'Show 50 more' });
    await more.click();
    await expect(rows).toHaveCount(100);
    await expect(page.getByText(`${total - 100} not shown`)).toBeVisible();

    // The 51st PR is the first the button added; focus is on its toggle, not lost to the top of the page.
    const answer = await prsOf(world, `${LAST_90}&limit=200`);
    const firstAdded = answer.items![50]!;
    await expect(rowOf(page, firstAdded.id).getByRole('button')).toBeFocused();

    // Read to the end: the button goes, and focus does not.
    const rest = total - 100;
    for (let left = rest; left > 0; left -= 50) {
      const next = Math.min(50, left);
      await page.getByRole('button', { name: `Show ${next} more` }).click();
      await expect(rows).toHaveCount(total - left + next);
    }
    await expect(page.getByRole('button', { name: /^Show .* more$/ })).toHaveCount(0);
    await expect(page.getByText(/not shown/)).toHaveCount(0);
    await expect(rows).toHaveCount(total);
    await expect(page.locator(':focus')).toHaveAttribute('aria-expanded', 'false');
  });

  test('a search has no count of its own, so the button says "Show more" and no number is invented', async ({
    page,
  }) => {
    await openDelivery(page, 1280, { search: `${LAST_90}&q=atlas` });
    await expect(page.getByRole('button', { name: 'Show more', exact: true })).toBeVisible();
    await expect(page.getByText(/not shown/)).toHaveCount(0);
  });
});

// ============================================================================================================================
// States
// ============================================================================================================================

test.describe('states', () => {
  test('an inaccessible repository is named in a notice that leads to Sources & repos', async ({
    page,
  }) => {
    const world = await openDelivery(page, 1280);
    expect((await prsOf(world)).inaccessibleRepos).toEqual(['kelvin/archive-private']);
    const notice = page.getByText(
      'kelvin/archive-private is inaccessible. Its PRs are excluded until access is restored.',
    );
    await expect(notice).toBeVisible();
    await expect(page.getByRole('link', { name: 'Fix in Sources & repos' })).toHaveAttribute(
      'href',
      '/sources',
    );
  });

  test('with no tracked repositories there is no table, and the next step is to add one', async ({
    page,
  }) => {
    await openDelivery(page, 1280, { world: { scenario: 'no-repos' } });
    await expect(
      page.getByRole('heading', { level: 2, name: 'No tracked repositories' }),
    ).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    await expect(card(page)).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Add repositories' })).toHaveAttribute(
      'href',
      '/sources',
    );
  });

  test('a failed read says so with a Retry that gets the list', async ({ page }) => {
    let failuresLeft = 1;
    const world = await openWorld(page);
    await page.route(`${ORIGIN}/api/prs**`, async (route) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'internal', message: 'Something went wrong.', retryable: false },
          }),
        });
        return;
      }
      const url = new URL(route.request().url());
      const answer = await answerApi(world.app, {
        method: 'GET',
        path: url.pathname + url.search,
        headers: {},
      });
      await route.fulfill({ status: answer.status, headers: answer.headers, body: answer.body });
    });
    await page.goto(`${ORIGIN}/delivery`);
    await expect(page.getByRole('alert')).toContainText('Couldn’t load pull requests.');
    await expect(table(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(table(page)).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('PRs that arrive through GitHub appear when a repository is added, merge times in the report timezone', async ({
    page,
  }) => {
    const world = await openDelivery(page, 1280, {
      search: '?start=2026-10-01&end=2026-11-04&author=all',
    });
    await expect(page.getByText('Add the init command')).toHaveCount(0);

    // Add the scripted GitHub's untracked repo through the app's own route, and let its sync finish.
    const added = await answerApi(world.app, {
      method: 'POST',
      path: '/api/repos',
      headers: { 'content-type': 'application/json', 'x-agent-productivity-request': '1' },
      body: new TextEncoder().encode(JSON.stringify({ input: 'kelvin/dotfiles' })),
    });
    expect(added.status).toBeLessThan(300);
    await world.githubIdle();

    await page.reload();
    // 2 days before the clock is Nov 2, 9:42 AM PST; 9 days before is Oct 26, 10:42 AM PDT (the clocks changed on Nov 1).
    const init = page.getByRole('row').filter({ hasText: 'Add the init command' });
    await expect(init).toContainText('kelvin/dotfiles #1');
    await expect(init.getByRole('cell').nth(1)).toHaveText('Nov 2, 9:42 AM');
    const notes = page.getByRole('row').filter({ hasText: 'Read notes from a folder' });
    await expect(notes.getByRole('cell').nth(1)).toHaveText('Oct 26, 10:42 AM');
    // Merged by someone else, and (in the next row) authored by someone else.
    await expect(notes.getByRole('cell').nth(3)).toHaveText('review-bot');
    const parser = page.getByRole('row').filter({ hasText: 'Fix the date parser' });
    await expect(parser.getByRole('cell').nth(2)).toHaveText('a-colleague');
    await expect(parser.getByRole('cell').nth(3)).toHaveText('You');
  });
});

// ============================================================================================================================
// Containment, accessibility, privacy
// ============================================================================================================================

/** What makes a card at 320px hard: a long title, a 39-character login, and a title with no break in it. */
function hardCases(world: World): void {
  const unbroken = 'x'.repeat(90);
  upsertPullRequests(world.db, [
    merge({
      nodeId: 'PR_hard_1',
      number: 910,
      title:
        'Rework the usage importer so every provider adapter reports partial history and cached recent days consistently',
      mergedByLogin: 'a-very-long-github-login-of-39-characters',
    }),
    merge({ nodeId: 'PR_hard_2', number: 911, title: unbroken }),
  ]);
}

test.describe('containment and accessibility', () => {
  for (const width of [1280, 390, 320]) {
    test(
      `${width}px, a PR open, long titles and logins: the containment check finds no FAIL`,
      { tag: '@responsive' },
      async ({ page }) => {
        await openDelivery(page, width, { search: '?author=all', before: hardCases });
        await page
          .getByRole('button', { name: /^Show link evidence for/ })
          .first()
          .click();
        const report = await measureContainment(page);
        expect(failures(report), JSON.stringify(report, null, 2)).toEqual([]);
        // The only deliberate sideways scroller on the page is the table's own, and only where the table is on screen.
        if (width >= 640) expect(report.scrollers.length).toBeLessThanOrEqual(1);
        else expect(report.scrollers).toEqual([]);
      },
    );

    test(`${width}px, a PR open: axe finds no violations`, { tag: '@a11y' }, async ({ page }) => {
      await openDelivery(page, width, { search: '?author=all', before: hardCases });
      await page
        .getByRole('button', { name: /^Show link evidence for/ })
        .first()
        .click();
      const summary = await violationsOf(page);
      expect(summary, `axe found ${summary.length} violation(s)`).toEqual([]);
    });
  }

  test(
    '640px, table scrolling: axe finds no violations (the scroller is focusable and named)',
    { tag: '@a11y' },
    async ({ page }) => {
      await openDelivery(page, 640);
      expect(
        await scroller(page).evaluate((el) => el.scrollWidth - el.clientWidth),
      ).toBeGreaterThan(0);
      expect(await violationsOf(page)).toEqual([]);
    },
  );

  test(
    'the empty and the no-repos states have no axe violations either',
    { tag: '@a11y' },
    async ({ page }) => {
      await openDelivery(page, 390, { search: '?start=2026-11-01&end=2026-11-01' });
      await expect(page.getByText('No merged PRs in this period authored by you.')).toBeVisible();
      expect(await violationsOf(page)).toEqual([]);
    },
  );

  test('the page makes no request outside the origin, and the server logged no warning or error', async ({
    page,
  }) => {
    const outside: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith(ORIGIN)) outside.push(request.url());
    });
    const world = await openDelivery(page, 1280, { search: '?author=all' });
    await page
      .getByRole('button', { name: /^Show link evidence for/ })
      .first()
      .click();
    await searchBox(page).fill('atlas');
    await expect(table(page).locator('tbody tr').first()).toBeVisible();
    expect(outside).toEqual([]);
    expect(world.logs).toEqual([]);
  });
});
