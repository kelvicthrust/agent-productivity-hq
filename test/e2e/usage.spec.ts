import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { Hono } from 'hono';
import { correlation, errorHandler, type HttpEnv } from '../../src/server/http/errors.ts';
import { usageRoutes } from '../../src/server/http/routes/usage.ts';
import { createLogger } from '../../src/server/lib/logger.ts';
import {
  UsageCategoriesResponse,
  UsageGroupsResponse,
  UsageRootsResponse,
} from '../../src/shared/contracts/usage.ts';
import { int } from '../../src/client/lib/format';
import { FIXED_NOW, FIXED_TIMEZONE } from '../fixtures/seed.ts';
import { expect, test } from './fixtures';
import { failures, findWrappedCells, measureContainment } from './helpers/containment';
import { ORIGIN } from './helpers/virtualOrigin';
import { answerApi, openWorld, type World, type WorldOptions } from './helpers/world';

// The Usage screen (M4: A16) in a real browser, against the real Usage API over the seeded world.
//
// The world's app does not mount usageRoutes yet, so this spec does what test/e2e/recovery.spec.ts will: it builds a Hono
// app with correlation(), errorHandler and usageRoutes over `world.db`, and answers /api/usage/** from it through
// page.route (registered after serveWorld's, so it wins). Nothing is stubbed: the numbers on the page are the server's
// own, and the spec reads the same API to know what to expect. When createApp mounts usageRoutes, this still works.
//
// What is covered, from the assignment's goals:
//   - the table from 640px and a nested list below it, chosen by one media query, never a CSS override of table display
//   - the table's scroller: a labelled, focusable region with a visible focus ring; data cells that never wrap
//   - one shared expanded-set across the two renderers
//   - provider, model and Started once per phone card (a count assertion)
//   - the ledgers only where the provider has figures
//   - the containment check at 1280, 390 and 320px, and axe on the expanded tree
//
// The fixed clock is Wed 2026-11-04 in America/Los_Angeles, so the default period is Mon Nov 2 to Sun Nov 8.

// ---- the Usage API over the world ---------------------------------------------------------------------------------------

interface UsageApi {
  /** The path and query of every /api/usage request the page made, in order. */
  requests: string[];
  /** Reads the real API directly, for what the page should show. */
  read: (path: string) => Promise<unknown>;
}

interface MountOptions {
  /** Appended to every roots request as `limit`, to make a small group page. The page itself never sends one. */
  rootsLimit?: number;
  /** Answer the first roots request of the page with a server error. */
  failFirstRoots?: boolean;
}

async function mountUsage(page: Page, world: World, options: MountOptions = {}): Promise<UsageApi> {
  const logger = createLogger({
    sink: (line) => world.logs.push(line),
    level: 'warn',
    now: () => FIXED_NOW,
  });
  const app = new Hono<HttpEnv>();
  app.use('*', correlation());
  app.onError(errorHandler(logger));
  app.route('/', usageRoutes({ db: world.db, now: () => FIXED_NOW, timezone: FIXED_TIMEZONE }));

  const requests: string[] = [];
  let failuresLeft = options.failFirstRoots ? 1 : 0;
  await page.route(`${ORIGIN}/api/usage/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const isRoots = url.pathname.endsWith('/roots');
    if (isRoots && options.rootsLimit) url.searchParams.set('limit', String(options.rootsLimit));
    requests.push(url.pathname + url.search);
    if (isRoots && failuresLeft > 0) {
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
    const answer = await answerApi(app, {
      method: request.method(),
      path: url.pathname + url.search,
      headers: request.headers(),
    });
    await route.fulfill({ status: answer.status, headers: answer.headers, body: answer.body });
  });
  return {
    requests,
    read: async (path) => {
      const answer = await answerApi(app, { method: 'GET', path, headers: {} });
      return JSON.parse(answer.body.toString('utf8')) as unknown;
    },
  };
}

interface Opened extends UsageApi {
  world: World;
}

async function openUsage(
  page: Page,
  width: number,
  options: { search?: string; world?: WorldOptions; mount?: MountOptions; height?: number } = {},
): Promise<Opened> {
  await page.setViewportSize({ width, height: options.height ?? 900 });
  const world = await openWorld(page, options.world);
  const api = await mountUsage(page, world, options.mount);
  await page.goto(`${ORIGIN}/usage${options.search ?? ''}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Usage' })).toBeVisible();
  return { world, ...api };
}

const groupsOf = async (api: UsageApi, query = '') =>
  UsageGroupsResponse.parse(await api.read(`/api/usage/groups${query}`)).groups ?? [];
const rootsOf = async (api: UsageApi, key: string, query = '') =>
  UsageRootsResponse.parse(
    await api.read(`/api/usage/groups/${encodeURIComponent(key)}/roots${query}`),
  );
const categoriesOf = async (api: UsageApi, query = '') =>
  UsageCategoriesResponse.parse(await api.read(`/api/usage/categories${query}`));

// ---- the page --------------------------------------------------------------------------------------------------------------

const treeCard = (page: Page) => page.getByRole('region', { name: 'Sessions by repository' });
/** The tree's table (it sits in the scroller). The ledgers are tables too, so the tree is found by its own caption. */
const treeTable = (page: Page) =>
  page.getByRole('table', { name: /^Sessions grouped by repository/ });
const treeList = (page: Page) =>
  page.getByRole('list', { name: /^Sessions grouped by repository/ });
const scroller = (page: Page) =>
  page.getByRole('region', { name: 'Usage by repository, scrolls sideways' });
const rowOf = (page: Page, sessionId: number) => page.locator(`[data-session-id="${sessionId}"]`);

/** Opens every group, root and unknown-relationship row, waiting for each group's sessions to arrive. */
async function expandEverything(page: Page): Promise<void> {
  const card = treeCard(page);
  // The tree is there once its first toggle is: before that there is nothing to open, which is not the same as done.
  await expect(card.locator('button[aria-expanded]').first()).toBeVisible();
  for (let guard = 0; guard < 80; guard += 1) {
    await expect(card.getByText('Loading sessions…')).toHaveCount(0);
    const closed = card.locator('button[aria-expanded="false"]');
    if ((await closed.count()) === 0) return;
    await closed.first().click();
  }
  throw new Error('the tree kept offering rows to open');
}

/** One group's toggle, by the name the design gives it. */
const groupToggle = (page: Page, label: string, open = false) =>
  page.getByRole('button', { name: `${open ? 'Collapse' : 'Expand'} ${label}`, exact: true });

// ============================================================================================================================
// The ledgers
// ============================================================================================================================

test.describe('provider ledgers', () => {
  test('each provider has its own ledger with the server’s figures, and nothing is added across providers', async ({
    page,
  }) => {
    const api = await openUsage(page, 1280);
    const categories = await categoriesOf(api);
    const codex = categories.codex!;
    const claude = categories.claude!;

    const codexLedger = page.getByRole('table', { name: 'Codex token categories' });
    const claudeLedger = page.getByRole('table', { name: 'Claude Code token categories' });
    await expect(codexLedger).toBeVisible();
    await expect(claudeLedger).toBeVisible();
    await expect(
      codexLedger
        .getByRole('row', { name: /^Input/ })
        .getByRole('cell')
        .last(),
    ).toHaveText(int(codex.input));
    await expect(codexLedger.getByRole('row', { name: /^Provider total/ })).toContainText(
      int(codex.total),
    );
    await expect(claudeLedger.getByRole('row', { name: /^Provider total/ })).toContainText(
      int(claude.total),
    );
    await expect(claudeLedger.getByRole('row', { name: /^Cache read/ })).toContainText(
      int(claude.cacheRead),
    );

    // The two totals are never summed into a third figure anywhere on the page.
    const combined = int((codex.total ?? 0) + (claude.total ?? 0));
    await expect(page.locator('main')).not.toContainText(combined);
  });

  test('a provider appears only when the provider filter includes it', async ({ page }) => {
    await openUsage(page, 1280, { search: '?provider=claude' });
    await expect(page.getByRole('table', { name: 'Claude Code token categories' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Codex token categories' })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 2, name: 'Codex' })).toHaveCount(0);
  });

  test('a period that has not happened yet shows words, not a ledger of zeros', async ({
    page,
  }) => {
    await openUsage(page, 1280, { search: '?start=2026-11-06&end=2026-11-08' });
    await expect(page.getByText('This period hasn’t happened yet.')).toHaveCount(2);
    await expect(page.getByRole('table', { name: /token categories/ })).toHaveCount(0);
  });

  test('a period before the history starts says it is unavailable, not zero', async ({ page }) => {
    await openUsage(page, 1280, { search: '?start=2025-12-01&end=2025-12-31' });
    await expect(page.getByText('History unavailable for this period.')).toHaveCount(2);
    await expect(page.getByRole('table', { name: /token categories/ })).toHaveCount(0);
    // The page also says where history does start.
    await expect(page.getByText(/Local usage history on this machine starts:/)).toBeVisible();
  });

  test('a period that starts before one provider’s history shows that ledger with where it begins, and leaves out the provider with none yet', async ({
    page,
  }) => {
    const api = await openUsage(page, 1280, { search: '?start=2026-01-15&end=2026-03-01' });
    const categories = await categoriesOf(api, '?start=2026-01-15&end=2026-03-01');
    expect(categories.codex?.coverage).toBe('partial');
    expect(categories.claude?.coverage).toBe('unavailable');

    await expect(page.getByRole('table', { name: 'Codex token categories' })).toBeVisible();
    await expect(page.getByText('Covers Feb 2, 2026 onward only.')).toBeVisible();
    await expect(page.getByRole('table', { name: 'Claude Code token categories' })).toHaveCount(0);
    await expect(page.getByText('History unavailable for this period.')).toHaveCount(1);
    await expect(page.getByText(/Local usage history on this machine starts:/)).toContainText(
      'Claude Code from Mar 15, 2026',
    );
  });

  test('a provider with no figures reads "—" in a group total, never a covered 0', async ({
    page,
  }) => {
    await openUsage(page, 1280, { search: '?start=2026-01-15&end=2026-03-01' });
    const row = treeTable(page).getByRole('row').filter({ hasText: 'kelvin/atlas-api' });
    // Codex has history for part of this period, so its total is a figure. Claude Code has none yet, so it is "—", not 0.
    await expect(row).toContainText(/Codex:\s*\d/);
    await expect(row).toContainText(/Claude Code:\s*—/);
    await expect(row).not.toContainText(/Claude Code:\s*0/);
  });

  test('a stale source still shows its imported figures, and says they are cached', async ({
    page,
  }) => {
    await openUsage(page, 1280, { world: { scenario: 'refresh-failed' } });
    await expect(page.getByRole('table', { name: 'Codex token categories' })).toBeVisible();
    await expect(page.getByText('Cached; recent days missing.')).toBeVisible();
  });

  test('a machine with no local records has no ledgers and no tree, and offers the next step', async ({
    page,
  }) => {
    await openUsage(page, 1280, { world: { scenario: 'empty' } });
    await expect(
      page.getByRole('heading', { level: 2, name: 'No session detail on this machine' }),
    ).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    await expect(treeCard(page)).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'View account-reported usage' })).toHaveAttribute(
      'href',
      '/',
    );
    await expect(page.getByRole('link', { name: 'Check sources' })).toHaveAttribute(
      'href',
      '/sources',
    );
  });

  test('the Paseo note and the repo-filter note appear above the ledgers', async ({ page }) => {
    const api = await openUsage(page, 1280, { search: '?repos=kelvin/atlas-api' });
    const note = (await categoriesOf(api, '?repos=kelvin/atlas-api')).paseoNote;
    expect(note).toBeTruthy();
    await expect(page.getByText(note!)).toBeVisible();
    await expect(page.getByText(/^Repo filter is on:/)).toBeVisible();
  });
});

// ============================================================================================================================
// The tree table (640px and wider)
// ============================================================================================================================

test.describe('tree table', () => {
  test('is a real table of six columns, in a labelled and focusable scroller', async ({ page }) => {
    await openUsage(page, 1280);
    const region = scroller(page);
    await expect(region).toBeVisible();
    await expect(region).toHaveAttribute('tabindex', '0');
    await expect(region.getByRole('table')).toHaveCount(1);

    const headers = treeTable(page).getByRole('columnheader');
    await expect(headers).toHaveText([
      'Session',
      'Provider',
      'Model',
      'Started',
      'Tokens',
      'Linked PRs',
    ]);
    await expect(treeList(page)).toHaveCount(0);
  });

  test('lists every repository group with its counts and token totals, one provider per line', async ({
    page,
  }) => {
    const api = await openUsage(page, 1280);
    const groups = await groupsOf(api);
    expect(groups.length).toBeGreaterThan(5);
    const table = treeTable(page);
    for (const group of groups) {
      const row = table.getByRole('row').filter({ hasText: group.label! }).first();
      await expect(row).toContainText(`${group.roots} ${group.roots === 1 ? 'root' : 'roots'}`);
      await expect(row).toContainText(
        `${group.sessions} ${group.sessions === 1 ? 'session' : 'sessions'}`,
      );
    }
    // atlas-api: Codex then Claude Code, each on its own line, as compact figures.
    const atlas = groups.find((group) => group.key === 'kelvin/atlas-api')!;
    const stack = table
      .getByRole('row')
      .filter({ hasText: 'kelvin/atlas-api' })
      .locator('td')
      .nth(4);
    const lines = stack.locator('> span > span');
    await expect(lines).toHaveCount(2);
    await expect(lines.nth(0)).toContainText('Codex');
    await expect(lines.nth(1)).toContainText('Claude Code');
    expect(atlas.tokens?.codex).toBeGreaterThan(0);
    const [first, second] = [await lines.nth(0).boundingBox(), await lines.nth(1).boundingBox()];
    expect(second!.y).toBeGreaterThan(first!.y);
  });

  test('every row has six cells', async ({ page }) => {
    await openUsage(page, 1280);
    await expandEverything(page);
    const counts = await treeTable(page)
      .locator('tr')
      .evaluateAll((rows) => rows.map((row) => (row as HTMLTableRowElement).cells.length));
    expect(counts.length).toBeGreaterThan(20);
    expect(new Set(counts)).toEqual(new Set([6]));
  });

  test('a reachable repo with no sessions in scope is listed with nothing to open; an inaccessible one is not listed', async ({
    page,
  }) => {
    // Claude Code only: kelvin/notes-cli has Codex sessions alone, so it has none left.
    const api = await openUsage(page, 1280, { search: '?provider=claude' });
    const groups = await groupsOf(api, '?provider=claude');
    const empty = groups.find((group) => group.sessions === 0)!;
    expect(empty.label).toBe('kelvin/notes-cli');
    await expect(groupToggle(page, empty.label!)).toHaveCount(0);
    await expect(treeTable(page).getByRole('row').filter({ hasText: empty.label! })).toContainText(
      '0 roots · 0 sessions',
    );
    // kelvin/archive-private is tracked but GitHub no longer grants access, and none of its sessions are in scope: Sources
    // says so, and the tree does not carry a row of zeros for it (the D7 prototype lists only the repos it can reach).
    expect(groups.map((group) => group.label)).not.toContain('kelvin/archive-private');
    await expect(treeTable(page)).not.toContainText('kelvin/archive-private');
  });

  test('reads a group’s sessions only when it is opened, then shows roots newest first with their identity', async ({
    page,
  }) => {
    const api = await openUsage(page, 1280);
    await expect(treeTable(page)).toBeVisible();
    expect(api.requests.filter((path) => path.includes('/roots'))).toEqual([]);

    await groupToggle(page, 'kelvin/atlas-api').click();
    await expect(groupToggle(page, 'kelvin/atlas-api', true)).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    const roots = await rootsOf(api, 'kelvin/atlas-api');
    const asked = api.requests.filter((path) => path.includes('/roots'));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('/api/usage/groups/kelvin%2Fatlas-api/roots');

    // The roots arrive as the server ordered them, and the first (newest) is a Claude Code planner.
    const first = roots.roots![0]!;
    const row = rowOf(page, first.id);
    await expect(row).toBeVisible();
    await expect(row.getByRole('cell').nth(1)).toHaveText('Claude Code');
    await expect(row.getByRole('cell').nth(2)).toHaveText(first.model!);
    // 2026-11-02T18:51Z is 10:51 AM in the report timezone (America/Los_Angeles, PST).
    await expect(row.getByRole('cell').nth(3)).toHaveText('Nov 2, 10:51 AM');
    await expect(row.getByRole('cell').nth(3).locator('time')).toHaveAttribute(
      'datetime',
      first.startedAt,
    );
    await expect(row.getByRole('cell').nth(4)).toHaveText('3.25M'); // 3,254,917 tokens
    // Identity: the recorded name, the relationship and children, the technical id, labelled for screen readers.
    const identity = row.getByRole('cell').first();
    await expect(identity).toContainText('planner');
    await expect(identity).toContainText('Root session · Paseo');
    await expect(identity).toContainText('3 children');
    await expect(identity).toContainText(`Session ID: ${first.providerSessionRef}`);
    // The desktop identity does not repeat what its own columns say.
    await expect(identity).not.toContainText('Started');
  });

  test('a root’s children open and close from the keyboard, named by the session and its id', async ({
    page,
  }) => {
    const api = await openUsage(page, 1280);
    await groupToggle(page, 'kelvin/atlas-api').click();
    const root = (await rootsOf(api, 'kelvin/atlas-api')).roots![0]!;
    const kids = root.children!;
    expect(kids).toHaveLength(3);

    const toggle = page.getByRole('button', {
      name: `Show 3 child agents of planner, ${root.providerSessionRef}`,
    });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(rowOf(page, kids[0]!.id)).toHaveCount(0);

    await toggle.focus();
    await page.keyboard.press('Enter');
    const open = page.getByRole('button', {
      name: `Hide 3 child agents of planner, ${root.providerSessionRef}`,
    });
    await expect(open).toHaveAttribute('aria-expanded', 'true');
    await expect(open).toBeFocused(); // the same button keeps focus
    for (const kid of kids) await expect(rowOf(page, kid.id)).toBeVisible();

    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    for (const kid of kids) await expect(rowOf(page, kid.id)).toHaveCount(0);
  });

  test('sessions whose parent was never recorded are listed apart, never as roots or children', async ({
    page,
  }) => {
    const api = await openUsage(page, 1280);
    await groupToggle(page, 'kelvin/atlas-api').click();
    const unknown = (await rootsOf(api, 'kelvin/atlas-api')).unknownRelationship![0]!;
    await expect(rowOf(page, unknown.id)).toHaveCount(0);

    await page.getByRole('button', { name: 'Show sessions with unknown relationship' }).click();
    const row = rowOf(page, unknown.id);
    await expect(row).toBeVisible();
    await expect(row.getByRole('cell').first()).toContainText(unknown.nameLead);
    await expect(row.getByRole('cell').first()).toContainText('Unknown relationship');
    await expect(
      page.getByText('Parent not recorded, so these aren’t counted as roots or children'),
    ).toBeVisible();
  });

  test('each evidence level looks as designed: tinted, outlined, dashed or quiet (D7, D9), not only in words', async ({
    page,
  }) => {
    await openUsage(page, 1280);
    await expandEverything(page);
    // Read from the rendered page, because the stylesheet decides which of two border colours wins, not the markup.
    const look = (label: string) =>
      page
        .getByRole('table', { name: /^Sessions grouped by repository/ })
        .getByText(label, { exact: true })
        .first()
        .evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            border: style.borderTopStyle,
            width: style.borderTopWidth,
            colour: style.borderTopColor,
            fill: style.backgroundColor,
            ink: style.color,
          };
        });
    const evidence = await look('Evidence link');
    const owner = await look('Owner-confirmed');
    const suggested = await look('Suggested');
    const unlinked = await look('Unlinked');
    const clear = 'rgba(0, 0, 0, 0)';
    // Evidence link (D9): a grape-tint fill with grape text and no outline; it is not the outlined, the dashed or the quiet look.
    expect(evidence.fill).not.toBe(clear);
    expect(evidence.colour).toBe(clear);
    expect(evidence.ink).not.toBe(owner.ink);
    // Owner-confirmed: a solid outline in the label's own ink, on the surface fill, not the evidence tint.
    expect(owner).toMatchObject({ border: 'solid', width: '1px' });
    expect(owner.colour).not.toBe(clear);
    expect(owner.colour).toBe(owner.ink);
    expect(owner.fill).not.toBe(evidence.fill);
    // Suggested: a dashed outline in the control border colour, never the clear border it would have if another rule won.
    expect(suggested).toMatchObject({ border: 'dashed', width: '1px' });
    expect(suggested.colour).not.toBe(clear);
    // Unlinked: a quiet fill and no visible outline.
    expect(unlinked.colour).toBe(clear);
    expect(unlinked.fill).not.toBe(clear);
  });

  test('Linked PRs: every link names its evidence level; Unlinked only where a check could happen', async ({
    page,
  }) => {
    const api = await openUsage(page, 1280);
    await expandEverything(page);
    const cell = (sessionId: number) => rowOf(page, sessionId).getByRole('cell').nth(5);
    const all = async (key: string) => {
      const found = await rootsOf(api, key);
      return [...found.roots!, ...found.orphans!, ...found.unknownRelationship!];
    };
    const pick = async (key: string, status: string, linkClass?: string) =>
      (await all(key)).find(
        (s) => s.linkStatus === status && (!linkClass || s.linkedPrs[0]?.class === linkClass),
      )!;

    const evidence = await pick('kelvin/atlas-api', 'linked', 'evidence');
    const owner = await pick('kelvin/atlas-web', 'linked', 'owner');
    const suggested = await pick('kelvin/notes-cli', 'linked', 'suggested');
    const unlinked = await pick('kelvin/atlas-api', 'unlinked');
    const untracked = await pick('__untracked', 'repo_not_tracked');
    const unknown = await pick('__unknown', 'repo_unknown');

    // `#number`, a link, then Delivery's badge, in that order.
    for (const [session, badge] of [
      [evidence, 'Evidence link'],
      [owner, 'Owner-confirmed'],
      [suggested, 'Suggested'],
    ] as const) {
      const link = session.linkedPrs[0]!;
      const target = cell(session.id);
      await expect(
        target.getByRole('link', { name: `#${link.number} in ${link.repo}` }),
      ).toBeVisible();
      const text = (await target.innerText()).replace(/\s+/g, ' ');
      expect(text, `session ${session.id}`).toMatch(
        new RegExp(`^#${link.number} in ${link.repo.replace('/', '\\/')} ${badge}$`),
      );
    }
    await expect(cell(unlinked.id)).toHaveText('Unlinked');
    // Not checked: words, and never "Unlinked".
    const notTracked = cell(untracked.id);
    await expect(notTracked).toHaveText('Repo not tracked, so PRs not checked');
    await expect(notTracked).not.toContainText('Unlinked');
    const noRepo = cell(unknown.id);
    await expect(noRepo).toHaveText('No repo recorded, so PRs not checked');
    await expect(noRepo).not.toContainText('Unlinked');
  });

  test('"Show more roots" reads the next page, and focus is never lost when the last page lands', async ({
    page,
  }) => {
    // atlas-web has 8 roots; pages of 3 make it three pages.
    const api = await openUsage(page, 1280, { mount: { rootsLimit: 3 } });
    await groupToggle(page, 'kelvin/atlas-web').click();
    const table = treeTable(page);
    const rows = table.locator('tr[data-session-id]');
    await expect(rows).toHaveCount(3);
    await expect(table.getByText('5 not shown')).toBeVisible();

    // The button names how many roots remain, up to the 15 a page holds; this spec makes pages of 3.
    await table.getByRole('button', { name: 'Show 5 more roots' }).click();
    await expect(rows).toHaveCount(6);
    await expect(table.getByText('2 not shown')).toBeVisible();

    await table.getByRole('button', { name: 'Show 2 more roots' }).click();
    // 8 roots, plus the group's 2 unknown-relationship sessions that are only listed once they are opened.
    await expect(rows).toHaveCount(8);
    await expect(table.getByRole('button', { name: /more root/ })).toHaveCount(0);
    // The button that was pressed is gone; focus moves to the group's own toggle, not to the top of the page.
    await expect(groupToggle(page, 'kelvin/atlas-web', true)).toBeFocused();

    const roots = api.requests.filter((path) => path.includes('/roots'));
    expect(roots).toHaveLength(3);
    expect(roots[0]).not.toContain('cursor=');
    expect(roots[1]).toContain('cursor=');
  });

  test('the Provider filter limits the group totals to that provider', async ({ page }) => {
    const api = await openUsage(page, 1280, { search: '?provider=codex' });
    const groups = await groupsOf(api, '?provider=codex');
    expect(groups.every((group) => group.tokens?.claude === undefined)).toBe(true);
    const row = treeTable(page).getByRole('row').filter({ hasText: 'kelvin/atlas-api' });
    await expect(row).toContainText('Codex');
    await expect(row).not.toContainText('Claude Code');
  });

  test('a failed group read says so beside that group and Retry reads it again', async ({
    page,
  }) => {
    await openUsage(page, 1280, { mount: { failFirstRoots: true } });
    await groupToggle(page, 'kelvin/atlas-api').click();
    const table = treeTable(page);
    await expect(table.getByRole('alert')).toContainText('Couldn’t load these sessions.');
    await table.getByRole('button', { name: 'Retry' }).click();
    await expect(table.getByRole('alert')).toHaveCount(0);
    await expect(table.locator('tr[data-session-id]').first()).toBeVisible();
  });
});

// ============================================================================================================================
// The table's scroller and its cells (D7)
// ============================================================================================================================

test.describe('table columns and scroller', () => {
  for (const width of [1280, 1024, 720, 640]) {
    test(
      `${width}px: Provider, Model and Started cells never wrap`,
      { tag: '@responsive' },
      async ({ page }) => {
        await openUsage(page, width);
        await expandEverything(page);
        const report = await findWrappedCells(treeTable(page), ['Provider', 'Model', 'Started']);
        // Not vacuous: sessions of both providers, each with all three cells.
        expect(report.checked).toBeGreaterThanOrEqual(3 * 20);
        expect(report.wrapped).toEqual([]);
      },
    );
  }

  test(
    'the Session column takes the spare width at 1280px',
    { tag: '@responsive' },
    async ({ page }) => {
      await openUsage(page, 1280);
      await expect(treeTable(page)).toBeVisible(); // evaluateAll does not wait for the table to render
      const widths = await treeTable(page)
        .getByRole('columnheader')
        .evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect().width));
      const [session, ...rest] = widths;
      expect(session).toBeGreaterThan(Math.max(...rest));
      // The table fits: nothing scrolls sideways at this width.
      const overflow = await scroller(page).evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    },
  );

  test(
    'never overrides table display: the table, its rows and its cells keep their own display at every width of the table',
    { tag: '@responsive' },
    async ({ page }) => {
      for (const width of [1280, 640]) {
        await openUsage(page, width);
        await expandEverything(page);
        const displays = await treeTable(page).evaluate((table) => {
          const of = (selector: string) => [
            ...new Set(
              Array.from(table.querySelectorAll(selector)).map(
                (el) => getComputedStyle(el).display,
              ),
            ),
          ];
          return {
            table: getComputedStyle(table).display,
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
      await openUsage(page, 640);
      const region = scroller(page);
      const sizes = await region.evaluate((el) => ({
        scroll: el.scrollWidth,
        client: el.clientWidth,
      }));
      expect(sizes.scroll).toBeGreaterThan(sizes.client);
      const page_ = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(page_).toBeLessThanOrEqual(0);
    },
  );

  test(
    'the scroller is reachable by keyboard, shows a focus ring, and scrolls with the arrow keys',
    { tag: '@a11y' },
    async ({ page }) => {
      await openUsage(page, 640);
      const region = scroller(page);
      const sizes = await region.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(
        sizes,
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
    },
  );
});

// ============================================================================================================================
// The phone list (below 640px)
// ============================================================================================================================

test.describe('phone list', () => {
  test(
    'below 640px the tree is a list; at 640px it is a table: one switch, exactly at the breakpoint',
    { tag: '@responsive' },
    async ({ page }) => {
      await openUsage(page, 639);
      await expect(treeList(page)).toBeVisible();
      await expect(treeTable(page)).toHaveCount(0);
      await expect(scroller(page)).toHaveCount(0);

      // Cross the breakpoint in the same page: the other renderer takes over without a reload.
      await page.setViewportSize({ width: 640, height: 900 });
      await expect(treeTable(page)).toBeVisible();
      await expect(treeList(page)).toHaveCount(0);
      await page.setViewportSize({ width: 639, height: 900 });
      await expect(treeList(page)).toBeVisible();
      await expect(treeTable(page)).toHaveCount(0);
    },
  );

  for (const width of [390, 320]) {
    test(
      `${width}px: each session card shows provider, model and Started exactly once`,
      { tag: '@responsive' },
      async ({ page }) => {
        const api = await openUsage(page, width);
        await expandEverything(page);

        const sessions = new Map<number, { provider: string; model: string; startedAt: string }>();
        for (const group of await groupsOf(api)) {
          const found = await rootsOf(api, group.key!);
          for (const root of found.roots ?? []) {
            sessions.set(root.id, root as never);
            for (const child of root.children ?? []) sessions.set(child.id, child as never);
          }
          for (const s of [...(found.orphans ?? []), ...(found.unknownRelationship ?? [])]) {
            sessions.set(s.id, s as never);
          }
        }
        const cards = treeList(page).locator('[data-session-id]');
        await expect(cards).toHaveCount(sessions.size);
        expect(sessions.size).toBeGreaterThan(30);

        const names: Record<string, string> = { codex: 'Codex', claude: 'Claude Code' };
        const counts = await cards.evaluateAll((nodes) =>
          nodes.map((node) => ({
            id: Number((node as HTMLElement).dataset['sessionId']),
            text: (node as HTMLElement).innerText,
          })),
        );
        const occurrences = (text: string, needle: string) => text.split(needle).length - 1;
        for (const { id, text } of counts) {
          const session = sessions.get(id)!;
          const provider = names[session.provider]!;
          expect(occurrences(text, provider), `session ${id}: provider "${provider}"`).toBe(1);
          expect(occurrences(text, session.model), `session ${id}: model "${session.model}"`).toBe(
            1,
          );
          expect(occurrences(text, 'Started'), `session ${id}: "Started"`).toBe(1);
        }
        // And one time element for each card in the whole list, so nothing is hidden or drawn twice.
        await expect(treeList(page).locator('time')).toHaveCount(sessions.size);
        // No <table> and no table-ish display anywhere in the tree.
        expect(
          await treeCard(page).evaluate(
            (card) =>
              Array.from(card.querySelectorAll('*')).filter((el) =>
                /^table/.test(getComputedStyle(el).display),
              ).length,
          ),
        ).toBe(0);
      },
    );
  }

  test(
    'a card says Tokens and Linked PRs on one labelled line',
    { tag: '@responsive' },
    async ({ page }) => {
      const api = await openUsage(page, 390);
      await groupToggle(page, 'kelvin/atlas-api').click();
      const root = (await rootsOf(api, 'kelvin/atlas-api')).roots![1]!; // the Codex planner with an Evidence link
      const card = rowOf(page, root.id);
      await expect(card.getByRole('term')).toHaveText(['Tokens', 'Linked PRs']);
      await expect(card.getByRole('definition').first()).toHaveText('1.19M'); // 1,189,699 tokens
      await expect(card.getByRole('definition').nth(1)).toContainText('Evidence link');
      const [tokens, links] = [
        await card.getByRole('term').nth(0).boundingBox(),
        await card.getByRole('term').nth(1).boundingBox(),
      ];
      expect(Math.abs(tokens!.y - links!.y)).toBeLessThanOrEqual(2); // the same line
      // The identity block is above it, across the full width, and states the meta line once.
      await expect(card).toContainText('Codex · gpt-5-codex · Started Nov 2, 9:13 AM');
    },
  );

  test(
    'a group is one line with its stacked totals, and its fill spans the row',
    { tag: '@responsive' },
    async ({ page }) => {
      await openUsage(page, 390);
      const list = treeList(page);
      const item = list.locator(':scope > li').filter({ hasText: 'kelvin/atlas-api' });
      const row = item.locator(':scope > div').first();
      await expect(row).toContainText('2 roots · 8 sessions');
      const [box, listBox] = [await row.boundingBox(), await list.boundingBox()];
      expect(box!.width).toBeCloseTo(listBox!.width, 0);
      expect(await row.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
        'rgb(251, 248, 243)', // --color-canvas
      );
      const lines = row.locator('span.flex-col').last().locator('> span');
      await expect(lines).toHaveCount(2);
    },
  );

  test(
    'rows open and close from the keyboard, and their toggles have 44px targets',
    { tag: '@a11y' },
    async ({ page }) => {
      await openUsage(page, 390);
      const toggle = groupToggle(page, 'kelvin/atlas-api');
      await toggle.focus();
      await page.keyboard.press('Enter');
      await expect(groupToggle(page, 'kelvin/atlas-api', true)).toBeFocused();
      await expect(treeList(page).locator('[data-session-id]').first()).toBeVisible();
      await page.keyboard.press('Space');
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(treeList(page).locator('[data-session-id]')).toHaveCount(0);

      // The toggle draws 24px; a pseudo-element grows its hit area to 44px (design-to-code "Touch targets").
      const target = await toggle.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const hit = getComputedStyle(el, '::before');
        return {
          w: box.width,
          h: box.height,
          hitW: parseFloat(hit.width),
          hitH: parseFloat(hit.height),
        };
      });
      expect(target).toEqual({ w: 24, h: 24, hitW: 44, hitH: 44 });
    },
  );
});

// ============================================================================================================================
// One expanded-set for both renderers
// ============================================================================================================================

test.describe('shared expanded-set', () => {
  test(
    'what is open stays open when the window crosses 640px, in both directions, with no new requests',
    { tag: '@responsive' },
    async ({ page }) => {
      const api = await openUsage(page, 1280);
      const root = (await rootsOf(api, 'kelvin/atlas-api')).roots![0]!;
      await groupToggle(page, 'kelvin/atlas-api').click();
      await page
        .getByRole('button', {
          name: new RegExp(`^Show 3 child agents of planner, ${root.providerSessionRef}`),
        })
        .click();
      await expect(rowOf(page, root.children![0]!.id)).toBeVisible();
      const reads = () => api.requests.filter((path) => path.includes('/roots')).length;
      expect(reads()).toBe(1);

      // Down to a phone: the list shows the same group and the same root open.
      await page.setViewportSize({ width: 390, height: 900 });
      await expect(treeList(page)).toBeVisible();
      await expect(groupToggle(page, 'kelvin/atlas-api', true)).toBeVisible();
      await expect(rowOf(page, root.id)).toBeVisible();
      await expect(rowOf(page, root.children![0]!.id)).toBeVisible();

      // Close the group on the phone, and open another one.
      await groupToggle(page, 'kelvin/atlas-api', true).click();
      await groupToggle(page, 'kelvin/notes-cli').click();
      await expect(rowOf(page, root.id)).toHaveCount(0);

      // Back up: the table agrees.
      await page.setViewportSize({ width: 1280, height: 900 });
      await expect(treeTable(page)).toBeVisible();
      await expect(groupToggle(page, 'kelvin/atlas-api')).toHaveAttribute('aria-expanded', 'false');
      await expect(groupToggle(page, 'kelvin/notes-cli', true)).toBeVisible();
      await expect(rowOf(page, root.id)).toHaveCount(0);

      // Re-opening the first group is served from what was already read.
      await groupToggle(page, 'kelvin/atlas-api').click();
      await expect(rowOf(page, root.id)).toBeVisible();
      expect(api.requests.filter((path) => path.includes('atlas-api')).length).toBe(1);
    },
  );
});

// ============================================================================================================================
// The coverage strip
// ============================================================================================================================

const coverage = (page: Page) => page.getByRole('region', { name: 'Source coverage' });
const activeRepos = (world: World): number =>
  (
    world.db.prepare("SELECT COUNT(*) AS n FROM repo WHERE tracking_state = 'active'").get() as {
      n: number;
    }
  ).n;

test.describe('coverage strip', () => {
  test('says which local sources were found and the tracked repos, from the database, with the last refresh', async ({
    page,
  }) => {
    const { world } = await openUsage(page, 1280);
    await expect(coverage(page)).toHaveCount(1);
    const strip = coverage(page);
    await expect(strip.getByText('This machine', { exact: true })).toBeVisible();
    await expect(strip).toContainText(/Codex\s+since [A-Z][a-z]{2} \d{1,2}, \d{4}/);
    await expect(strip).toContainText(/Claude Code\s+since [A-Z][a-z]{2} \d{1,2}, \d{4}/);
    await expect(strip).toContainText(/Paseo\s+partial · \d+ unreadable/);
    // The repo group comes from /api/repos: the active repos, and how many of them GitHub no longer grants.
    const inaccessible = (
      world.db
        .prepare(
          "SELECT COUNT(*) AS n FROM repo WHERE tracking_state = 'active' AND access_state = 'inaccessible'",
        )
        .get() as { n: number }
    ).n;
    await expect(strip).toContainText(
      `GitHub ${activeRepos(world)} repos tracked · ${inaccessible} inaccessible`,
    );
    await expect(strip).toContainText('Last successful refresh today, 9:42 AM');
    // No account state is claimed: accounts are not served yet.
    await expect(strip.getByText('Account reports')).toHaveCount(0);
  });

  test('while a refresh is failing the strip says so, and when the failing source last worked', async ({
    page,
  }) => {
    await openUsage(page, 1280, { world: { scenario: 'refresh-failed' } });
    const strip = coverage(page);
    await expect(strip).toContainText(/Codex\s+refresh failed/);
    await expect(strip).toContainText('Last successful refresh Nov 3, 6:12 PM');
    await expect(strip).toContainText('Latest attempt today, 9:42 AM');
    // "Manage sources" goes to Sources & repos.
    await strip.getByRole('link', { name: 'Manage sources' }).click();
    await expect(page).toHaveURL(`${ORIGIN}/sources`);
    await expect(page.getByRole('heading', { level: 1, name: 'Sources & repos' })).toBeVisible();
  });

  test('a source that was not found says so, and a source nobody has checked is not drawn as found', async ({
    page,
  }) => {
    await openUsage(page, 1280, { world: { scenario: 'account-only' } });
    await expect(coverage(page)).toContainText(/Codex\s+not found/);
    await expect(coverage(page)).toContainText(/Claude Code\s+not found/);
    await expect(coverage(page)).not.toContainText(/(?<!not )found|since/);

    // The empty world has no source rows at all: nothing is drawn for the machine, only the repos.
    await openUsage(page, 1280, { world: { scenario: 'empty' } });
    await expect(coverage(page).getByText('This machine', { exact: true })).toHaveCount(0);
    await expect(coverage(page)).not.toContainText(/Codex|Claude Code|Paseo/);
    await expect(coverage(page)).toContainText('0 repos tracked');
  });

  for (const [width, layout] of [
    [1280, 'flex'],
    [390, 'grid'],
    [320, 'grid'],
  ] as const) {
    test(`${width}px: one strip under the heading and above the ledgers, laid out as a ${layout === 'flex' ? 'capsule' : 'stack'}, and nothing spills @responsive`, async ({
      page,
    }) => {
      await openUsage(page, width);
      await expect(coverage(page)).toHaveCount(1);
      const toggle = coverage(page).getByRole('button', { name: /^Source coverage/ });
      if (width < 720) {
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(coverage(page).getByRole('link', { name: 'Manage sources' })).toBeHidden();
        await toggle.click();
        await expect(coverage(page).getByRole('link', { name: 'Manage sources' })).toBeVisible();
      } else {
        await expect(toggle).toBeHidden();
      }
      const [head, strip, ledger] = await Promise.all([
        page.getByRole('heading', { level: 1, name: 'Usage' }).boundingBox(),
        coverage(page).boundingBox(),
        page.getByRole('table', { name: 'Codex token categories' }).boundingBox(),
      ]);
      expect(strip!.y).toBeGreaterThan(head!.y);
      expect(strip!.y + strip!.height).toBeLessThanOrEqual(ledger!.y);
      expect(strip!.x + strip!.width).toBeLessThanOrEqual(width);
      // The container query decides: a capsule where the column is 900px or more, stacked groups below.
      expect(await coverage(page).evaluate((el) => getComputedStyle(el).display)).toBe(layout);
      expect(
        await coverage(page).evaluate((el) => el.scrollWidth <= el.clientWidth),
        'the strip’s content fits inside it',
      ).toBe(true);
      expect(failures(await measureContainment(page))).toEqual([]);
    });
  }

  test('the strip has no axe violations at 1280, 390 and 320px @a11y', async ({ page }) => {
    for (const width of [1280, 390, 320]) {
      await openUsage(page, width, { world: { scenario: 'refresh-failed' } });
      await expect(coverage(page)).toHaveCount(1);
      const results = await new AxeBuilder({ page })
        .include('[aria-label="Source coverage"]')
        .analyze();
      expect(results.violations, `${width}px`).toEqual([]);
    }
  });
});

// ============================================================================================================================
// Containment and accessibility with the tree open
// ============================================================================================================================

test.describe('containment and accessibility', () => {
  for (const width of [1280, 390, 320]) {
    test(
      `${width}px, tree fully open: the containment check finds no FAIL`,
      { tag: '@responsive' },
      async ({ page }) => {
        await openUsage(page, width);
        await expandEverything(page);
        const report = await measureContainment(page);
        expect(failures(report), JSON.stringify(report, null, 2)).toEqual([]);
        // The only deliberate sideways scroller on the page is the tree's own, and only where the table is on screen.
        if (width >= 640) expect(report.scrollers.length).toBeLessThanOrEqual(1);
        else expect(report.scrollers).toEqual([]);
      },
    );

    // The page-width check above cannot see a badge that leaves its own card but stays inside the window, so each linked PR's number
    // and badge are measured against the card line they sit in (the Tokens and Linked PRs line). A badge that does not fit beside its
    // number goes below it. The seeded world has an unnamed root linked to PR 236 with an Owner-confirmed badge, the widest of them.
    if (width < 640) {
      test(
        `${width}px, tree fully open: no linked PR number or badge leaves its session card`,
        { tag: '@responsive' },
        async ({ page }) => {
          await openUsage(page, width);
          await expandEverything(page);
          const measured = await page.evaluate(() => {
            const spills: string[] = [];
            let items = 0;
            let ownerConfirmed = 0;
            for (const line of document.querySelectorAll('dl')) {
              const card = line.getBoundingClientRect();
              for (const item of line.querySelectorAll('ul > li')) {
                items += 1;
                if ((item.textContent ?? '').includes('Owner-confirmed')) ownerConfirmed += 1;
                for (const part of [item, ...item.querySelectorAll('a, span')]) {
                  const box = part.getBoundingClientRect();
                  if (box.width > 0 && box.right > card.right + 0.5) {
                    const text = (part.textContent ?? '').trim().slice(0, 30);
                    spills.push(
                      `${text}: right edge ${box.right.toFixed(1)} past the card's ${card.right.toFixed(1)}`,
                    );
                  }
                }
              }
            }
            return { spills, items, ownerConfirmed };
          });
          expect(measured.items, 'the open tree lists linked PRs').toBeGreaterThan(0);
          expect(measured.ownerConfirmed, 'one of them is Owner-confirmed').toBeGreaterThan(0);
          expect(measured.spills).toEqual([]);
        },
      );
    }

    test(
      `${width}px, tree fully open: axe finds no violations`,
      { tag: '@a11y' },
      async ({ page }) => {
        await openUsage(page, width);
        await expandEverything(page);
        const { violations } = await new AxeBuilder({ page }).analyze();
        const summary = violations.map(
          (v) =>
            `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).join('\n    ')}`,
        );
        expect(summary, `axe found ${violations.length} violation(s)`).toEqual([]);
      },
    );
  }

  test(
    '640px, table scrolling: axe finds no violations (the scroller is focusable and named)',
    { tag: '@a11y' },
    async ({ page }) => {
      await openUsage(page, 640);
      await expandEverything(page);
      const sizes = await scroller(page).evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(sizes).toBeGreaterThan(0);
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(violations.map((v) => v.id)).toEqual([]);
    },
  );

  test('the page makes no request outside the origin, and the server logged no warning or error', async ({
    page,
  }) => {
    const outside: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith(ORIGIN)) outside.push(request.url());
    });
    const { world } = await openUsage(page, 1280);
    await expandEverything(page);
    expect(outside).toEqual([]);
    expect(world.logs).toEqual([]);
  });
});
