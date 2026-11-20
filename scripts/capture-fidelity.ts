// `node scripts/capture-fidelity.ts [--set m10|m9|m8|m7|m6|m4]`: the rendered comparison with the D7 prototype (M4: G4_11, M6: G6_8 to G6_10,
// M7: G7_10, M8: G8_6 and G8_7, M9: G9_9, M10: G10_10 and G10_1).
//
// The D7 prototype and the product are rendered in a real browser from the same synthetic world (fixed clock Wed Nov 4,
// 2026, 9:42 AM, America/Los_Angeles) at 1280, 390 and 320px wide. The default set is M6's; `--set m4` repeats M4's,
// `--set m7` is M7's, `--set m8` is M8's, `--set m9` is M9's and `--set m10` is M10's.
//   m10 setup-found / setup-accounts / setup-repos   first-launch Setup, its three steps, Codex and Claude Code found
//       setup-nothing-found / setup-denied           nothing found on the machine; a folder that cannot be read
//       recovery-database / -already-running / -disk-full   the three recovery pages (no D7 counterpart: its Sources page is the nearest part)
//       overview-retry-recovered                    the failed-refresh Overview after Retry worked: banner gone, recovered toast, issue count down
//       a sweep of every product route on the final tree with the containment helper (no picture), and an index of every earlier pair
//       (see docs/implementation/evidence/m10/README.md)
//   m9  overview-accounts      Overview with both account cards connected (ChatGPT by a scripted Codex read, Claude by a scripted plan check)
//       sources-accounts       Sources & repos with the Accounts section, both accounts connected
//       sources-claude-removal Claude legacy status-line removal preview
//       sources-chatgpt-signin the ChatGPT sign-in waiting panel (no designed screen; D7 shows its nearest part)
//       (see docs/implementation/evidence/m9/README.md)
//   m8  delivery-evidence    Delivery with a PR opened for each class: evidence, owner-confirmed, suggested, marked incorrect, unlinked
//       delivery-link-picker the unlinked PR with its "Link a session" form open
//       delivery-undo-toast  a suggestion confirmed, with its toast and Undo
//       usage-links          the Usage tree, every row open, each session's PR links and link status
//       overview-linked      Overview, with its Linked PRs tile
//       (see docs/implementation/evidence/m8/README.md)
//   m7  overview / overview-quiet / overview-history / overview-drawer / overview-refresh-failed / trends
//       (see docs/implementation/evidence/m7/README.md)
//   m6  delivery           Delivery: the table from 640px, cards below
//       delivery-evidence  the first PR opened: the "not collected yet" evidence panel (D7: its evidence items)
//       sources            Sources & repos with the GitHub connection and Tracked repositories
//       sources-confirm    Stop tracking, with its inline confirm panel
//       sources-stopped    after stopping: Previously tracked
//       sources-app-setup  gh signed out: the App setup guide (no designed screen; D7 shows its nearest part)
//       sources-device-code  the device-code panel (no designed screen; D7 shows its nearest part)
//   m4  usage / sources / failed-refresh (see docs/implementation/evidence/m4/README.md)
// Each pair is written as a full-page PNG under docs/implementation/evidence/<set>/, together with a README that links them and
// reports the layout containment check run on every PRODUCT page (the helper test/e2e/helpers/containment.ts, the port of the
// prototype's check) and, where a table is drawn, the no-wrapped-data-cell check on its data columns at 1280.
//
// It reads the screenshots of neither side: looking at each pair is the reviewer's job (see the README). It exits 1 when the
// product has a containment FAIL or a wrapped data cell, and 2 when it could not run (no browser, a page that did not settle).
// No server and no port: pages are served by request interception on a made-up origin, so it also runs where a process
// may not listen. Runs under Node's built-in TypeScript support: erasable syntax, explicit .ts import extensions.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Locator, type Page } from '@playwright/test';
import { Hono } from 'hono';
import { CONTEXT_OPTIONS, HEADLESS, LAUNCH_OPTIONS } from '../test/e2e/browser.ts';
import {
  failures,
  findWrappedCells,
  findWrappedPieces,
  measureContainment,
  type ContainmentReport,
} from '../test/e2e/helpers/containment.ts';
import { CAN_DENY } from '../test/e2e/helpers/homes.ts';
import { mountSetup, type Machine } from '../test/e2e/helpers/setupMachine.ts';
import { ORIGIN, serveBuild } from '../test/e2e/helpers/virtualOrigin.ts';
import { answerApi, createWorld, serveWorld, type World } from '../test/e2e/helpers/world.ts';
import { scriptedAdapter, succeeds } from '../test/fixtures/scripted-adapters/scripted.ts';
import { FIXED_NOW, FIXED_TIMEZONE } from '../test/fixtures/seed.ts';
import type { Scenario } from '../test/fixtures/world/write.ts';
import { createRunner } from '../src/server/collectors/runner.ts';
import { correlation, errorHandler, type HttpEnv } from '../src/server/http/errors.ts';
import { refreshRoutes } from '../src/server/http/routes/refresh.ts';
import { sourcesRoutes } from '../src/server/http/routes/sources.ts';
import { createLogger } from '../src/server/lib/logger.ts';
import {
  alreadyRunningPage,
  databaseRecoveryPage,
  diskFullPage,
} from '../src/server/http/recovery/index.ts';
import { ensureBuilt } from './lib/build.ts';

const ROOT = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const setAt = argv.indexOf('--set');
const SET_NAMES = ['m4', 'm6', 'm7', 'm8', 'm9', 'm10'] as const;
const asked = setAt >= 0 ? argv[setAt + 1] : undefined;
const SET: (typeof SET_NAMES)[number] = SET_NAMES.find((name) => name === asked) ?? 'm6';
const OUT = join(ROOT, `docs/implementation/evidence/${SET}`);
const PROTOTYPE = join(ROOT, 'docs/design/prototype');

const WIDTHS = [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
  { width: 320, height: 700 },
] as const;

interface Shot {
  id: string;
  title: string;
  scenario: Scenario;
  /** The product route and the prototype's hash route. */
  route: string;
  /** The product's own address when it is not `/<route>` (Overview is `/`; a date range is a query string). */
  productPath?: string;
  /** Opens every row of the Usage tree, on either side. */
  expandTree?: boolean;
  /** False starts the product with `gh` signed out (the one-time App setup). Default: signed in. */
  ghSignedIn?: boolean;
  /** What must be on the page before it is photographed, in the product. */
  settleProduct: (page: Page) => Promise<void>;
  /** What is done after the page settled and before the photograph: open a row, press a button. */
  actProduct?: (page: Page) => Promise<void>;
  actD7?: (page: Page) => Promise<void>;
  /** Only the product has this state; the prototype's picture is its nearest part, and the README says so. */
  nearest?: string;
  /** What is done to the world before the page loads (the product only): an owner decision made through the API. */
  prepareProduct?: (world: World) => Promise<void>;
  /** The prototype's own scenario id when it is not the world's (first-launch, nothing-found). */
  d7Scenario?: string;
  /** A brand-new install: the world is the empty one and setup is not finished, so the shell opens on /setup. */
  firstLaunch?: boolean;
  /** Mounts the real setup routes over the world with a scripted machine (after the world's own routes, so they answer first). */
  mountProduct?: (page: Page, world: World) => Promise<void>;
  /** The product's picture is this HTML (a recovery page), not a route of the app. */
  productHtml?: string;
  /** Containment is measured and nothing is photographed: a sweep of the final tree, not a comparison. */
  sweep?: boolean;
  /** The no-wrapped-data-cell check at 1280: the table and the columns whose cells must not wrap, and a stacked column whose pieces must not. */
  wrapCheck?: { table: RegExp; columns: string[]; stacked?: string };
}

const reposRegion = (page: Page): Locator =>
  page.getByRole('region', { name: 'Tracked repositories' });
const githubRegion = (page: Page): Locator =>
  page.getByRole('region', { name: 'GitHub', exact: true });
const settleSources = async (page: Page): Promise<void> => {
  await page
    .getByRole('region', { name: 'On this machine', exact: true })
    .getByRole('listitem')
    .first()
    .waitFor();
  await githubRegion(page).waitFor();
  await reposRegion(page).getByRole('listitem').first().waitFor();
};

const M6_SHOTS: readonly Shot[] = [
  {
    id: 'delivery',
    title: 'Delivery, table and cards',
    scenario: 'typical',
    route: 'delivery',
    settleProduct: async (page) => {
      await page.locator('#dl-title').waitFor();
      await page.locator('[data-pr-id]').first().waitFor();
    },
    wrapCheck: {
      table: /^Merged pull requests/,
      columns: ['Merged', 'Author', 'Merged by', 'Link basis'],
      // Since M8 the cell is a stack by design (providers, then the count line): its pieces must not break, as in the m8 set.
      stacked: 'Linked sessions',
    },
  },
  {
    id: 'delivery-evidence',
    title: 'Delivery, the first PR opened (its link evidence)',
    scenario: 'typical',
    route: 'delivery',
    nearest:
      'Since M8 the product shows its real Link evidence panel for the first PR (the m8 set opens one PR of each class); D7 shows its evidence items.',
    settleProduct: async (page) => {
      await page.locator('[data-pr-id]').first().waitFor();
    },
    actProduct: async (page) => {
      await page.locator('[data-pr-id] button[aria-expanded="false"]').first().click();
      await page
        .getByText(/Basis:/)
        .first()
        .waitFor();
    },
    actD7: async (page) => {
      await page.locator('button.row-toggle[data-act="pr-toggle"]').first().click();
    },
  },
  {
    id: 'sources',
    title: 'Sources & repos, GitHub and tracked repositories',
    scenario: 'typical',
    route: 'sources',
    settleProduct: settleSources,
  },
  {
    id: 'sources-confirm',
    title: 'Stop tracking, confirm panel open',
    scenario: 'typical',
    route: 'sources',
    settleProduct: settleSources,
    actProduct: async (page) => {
      await reposRegion(page)
        .getByRole('button', { name: /^Stop tracking kelvin\// })
        .first()
        .click();
      await reposRegion(page)
        .getByRole('group', { name: /^Confirm stop tracking/ })
        .waitFor();
    },
    actD7: async (page) => {
      await page.locator('button[data-act="repo-remove"]').first().click();
    },
  },
  {
    id: 'sources-stopped',
    title: 'A repo stopped, under Previously tracked',
    scenario: 'typical',
    route: 'sources',
    settleProduct: settleSources,
    actProduct: async (page) => {
      await reposRegion(page)
        .getByRole('button', { name: /^Stop tracking kelvin\// })
        .first()
        .click();
      await reposRegion(page)
        .getByRole('group', { name: /^Confirm stop tracking/ })
        .getByRole('button', { name: 'Stop tracking', exact: true })
        .click();
      await reposRegion(page).getByRole('heading', { name: 'Previously tracked' }).waitFor();
    },
    actD7: async (page) => {
      await page.locator('button[data-act="repo-remove"]').first().click();
      await page.locator('button[data-act="repo-remove-confirm"]').first().click();
    },
  },
  {
    id: 'sources-app-setup',
    title: 'GitHub not signed in: the App setup guide',
    scenario: 'typical',
    route: 'sources',
    ghSignedIn: false,
    nearest:
      'The App guide, client-ID field and device-code panel have no designed screen. D7 shows its Sources page with the GitHub account row, the nearest part.',
    settleProduct: async (page) => {
      await githubRegion(page).getByLabel('GitHub App client ID').waitFor();
      await reposRegion(page).waitFor();
    },
  },
  {
    id: 'sources-device-code',
    title: 'The device-code panel while it waits',
    scenario: 'typical',
    route: 'sources',
    ghSignedIn: false,
    nearest:
      'The device-code panel has no designed screen. D7 shows its Sources page with the GitHub account row, the nearest part.',
    settleProduct: async (page) => {
      await githubRegion(page).getByLabel('GitHub App client ID').waitFor();
    },
    actProduct: async (page) => {
      await githubRegion(page).getByLabel('GitHub App client ID').fill('Iv1.preview');
      await githubRegion(page).getByRole('button', { name: 'Save' }).click();
      await githubRegion(page).getByRole('button', { name: 'Connect GitHub' }).click();
      await githubRegion(page).getByRole('group', { name: 'Enter this code on GitHub' }).waitFor();
    },
  },
];

const M4_SHOTS: readonly Shot[] = [
  {
    id: 'usage',
    title: 'Usage, every row open',
    scenario: 'typical',
    route: 'usage',
    expandTree: true,
    settleProduct: async (page) => {
      await page.getByRole('heading', { level: 2, name: 'Sessions by repository' }).waitFor();
      await page
        .locator('section[aria-labelledby="us-tree-title"] button[aria-expanded]')
        .first()
        .waitFor();
    },
  },
  {
    id: 'sources',
    title: 'Sources & repos',
    scenario: 'typical',
    route: 'sources',
    settleProduct: async (page) => {
      await page
        .getByRole('region', { name: 'On this machine', exact: true })
        .getByRole('listitem')
        .first()
        .waitFor();
    },
  },
  {
    id: 'failed-refresh',
    title: 'Refresh failed, with Retry',
    scenario: 'refresh-failed',
    route: 'sources',
    settleProduct: async (page) => {
      await page.getByRole('status').filter({ hasText: 'Showing cached data.' }).waitFor();
      await page
        .getByRole('region', { name: 'On this machine', exact: true })
        .getByRole('listitem')
        .first()
        .waitFor();
    },
  },
];

const overviewSettle = async (page: Page): Promise<void> => {
  await page.locator('#ov-recent-title').waitFor();
  await page.locator('svg [data-bucket-index]').first().waitFor();
  await page.waitForTimeout(300); // the skeletons are gone and the numbers have landed
};
const openOverviewDrawer = async (page: Page): Promise<void> => {
  await page.locator('svg [data-bucket-index="2"]').click();
  await page.getByRole('dialog').getByRole('heading', { level: 2 }).waitFor();
  await page.waitForTimeout(500); // the slide has finished
};

const M7_SHOTS: readonly Shot[] = [
  {
    id: 'overview',
    title: 'Overview, a typical week',
    scenario: 'typical',
    route: 'overview',
    productPath: '/',
    settleProduct: overviewSettle,
  },
  {
    id: 'overview-quiet',
    title: 'Overview, a covered day with nothing in it (the quiet true zero)',
    scenario: 'typical',
    route: 'overview',
    productPath: '/?start=2026-11-01&end=2026-11-01',
    nearest:
      'D7’s period presets cannot pick Nov 1 alone, so its picture is its Overview of the same week; the quiet panel itself is compared with D7’s own markup (docs/design/prototype/app.js, .quiet).',
    settleProduct: async (page) => {
      await page.getByRole('status').filter({ hasText: 'A quiet one.' }).waitFor();
      await overviewSettle(page);
    },
  },
  {
    id: 'overview-history',
    title: 'Overview, twelve months (history starts partway)',
    scenario: 'typical',
    route: 'overview',
    productPath: '/?start=2025-11-04&end=2026-11-04',
    settleProduct: overviewSettle,
    actD7: async (page) => {
      // On a phone the period lives in the Filters sheet; on a wide screen, behind Custom.
      const sheet = page.locator('[data-act="filters-open"]');
      if (await sheet.isVisible()) await sheet.click();
      const custom = page.locator('[data-fk="period-custom"]');
      if (await custom.isVisible()) await custom.click();
      await page.locator('[data-fk="preset-12m"]').first().click();
      const done = page.locator('[data-fk="fb-done"]');
      // The prototype's tab bar sits over this button on a phone, so the press is sent to the button itself.
      if (await done.isVisible()) await done.dispatchEvent('click');
      await page.locator('svg.achart').first().waitFor();
    },
  },
  {
    id: 'overview-drawer',
    title: 'Overview, the records drawer open on Wed, Nov 4',
    scenario: 'typical',
    route: 'overview',
    productPath: '/',
    settleProduct: overviewSettle,
    actProduct: openOverviewDrawer,
    actD7: async (page) => {
      await page.locator('svg.achart g[data-i="2"]').first().click();
      await page.locator('.drawer').waitFor();
      await page.waitForTimeout(500);
    },
  },
  {
    id: 'overview-refresh-failed',
    title: 'Overview, a refresh failed (cached data)',
    scenario: 'refresh-failed',
    route: 'overview',
    productPath: '/',
    settleProduct: async (page) => {
      await page.getByRole('status').filter({ hasText: 'Showing cached data.' }).waitFor();
      await overviewSettle(page);
    },
  },
  {
    id: 'trends',
    title: 'Trends: the chart, the year of merges and tokens by model',
    scenario: 'typical',
    route: 'trends',
    productPath: '/trends',
    settleProduct: async (page) => {
      await page.locator('svg [data-bucket-index]').first().waitFor();
      await page.getByRole('heading', { level: 2 }).nth(2).waitFor();
      await page.waitForTimeout(600);
    },
  },
];

// ---- M8: link evidence and the Usage link badges ---------------------------------------------------------------------------

/** The PRs of the seeded week that show each class (see test/e2e/links.spec.ts for how the seed is read). */
const TITLE = {
  evidence: 'Improve chart table alternative',
  owner: 'Add coverage rail to trends chart',
  suggested: 'Handle archived sessions in export',
  mixed: 'Split usage importer into provider adapters',
  unlinked: 'Retry GitHub sync on secondary rate limit',
} as const;

/** The row toggle of a PR: the same accessible name on both sides ("Show link evidence for <title>"). */
const toggleFor = (page: Page, title: string): Locator =>
  page.getByRole('button', { name: `Show link evidence for ${title}`, exact: true });

const settleDelivery = async (page: Page): Promise<void> => {
  await page.locator('#dl-title').waitFor();
  await page.locator('[data-pr-id]').first().waitFor();
};

const evidenceLoaded = async (page: Page): Promise<void> => {
  await page.getByText('Loading link evidence…').waitFor({ state: 'hidden' });
};

/** The mixed PR's first evidence link is marked incorrect through the API, so its panel shows the struck-through item. */
async function markFirstEvidenceIncorrect(world: World): Promise<void> {
  const read = async <T>(path: string): Promise<T> =>
    JSON.parse(
      (await answerApi(world.app, { method: 'GET', path, headers: {} })).body.toString('utf8'),
    ) as T;
  const prs = (await read<{ items: { id: string; title: string }[] }>('/api/prs')).items;
  const pr = prs.find((item) => item.title === TITLE.mixed);
  if (!pr) throw new Error('the seeded week has no mixed PR');
  // D7 marks the mixed PR's "planner" link incorrect, so the product marks the same session.
  const { evidence } = await read<{
    evidence: { effectiveClass: string; session: { id: number; nameLead: string } }[];
  }>(`/api/prs/${encodeURIComponent(pr.id)}`);
  const item =
    evidence.find((c) => c.effectiveClass === 'evidence' && c.session.nameLead === 'planner') ??
    evidence.find((c) => c.effectiveClass === 'evidence');
  if (!item) throw new Error('the mixed PR has no evidence link');
  const answer = await answerApi(world.app, {
    method: 'PUT',
    path: `/api/prs/${encodeURIComponent(pr.id)}/links/${item.session.id}`,
    headers: { 'x-agent-productivity-request': '1', 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ decision: 'rejected' })),
  });
  if (answer.status !== 200) throw new Error(`marking incorrect answered ${answer.status}`);
}

const NO_TOAST = '#toast-root { display: none !important; }';

const M8_SHOTS: readonly Shot[] = [
  {
    id: 'delivery-evidence',
    title: 'Delivery, a PR opened for each link class',
    scenario: 'typical',
    route: 'delivery',
    nearest:
      'D7 draws "Marked incorrect" by clicking Mark incorrect on the first evidence link of the mixed PR; the product starts from the same decision made through the API, so no toast is on screen in either picture.',
    prepareProduct: markFirstEvidenceIncorrect,
    settleProduct: settleDelivery,
    wrapCheck: {
      table: /^Merged pull requests/,
      columns: ['Merged', 'Author', 'Merged by', 'Link basis'],
      stacked: 'Linked sessions',
    },
    actProduct: async (page) => {
      for (const title of Object.values(TITLE)) await toggleFor(page, title).click();
      await evidenceLoaded(page);
      await page.getByText('Basis:').first().waitFor();
    },
    actD7: async (page) => {
      await page.addStyleTag({ content: NO_TOAST });
      await toggleFor(page, TITLE.mixed).click();
      await page
        .locator('tr.pr-row')
        .filter({ hasText: TITLE.mixed })
        .locator('xpath=following-sibling::tr[1]')
        .locator('[data-act="link-reject"]')
        .first()
        .click();
      for (const title of [TITLE.evidence, TITLE.owner, TITLE.suggested, TITLE.unlinked]) {
        await toggleFor(page, title).click();
      }
    },
  },
  {
    id: 'delivery-link-picker',
    title: 'Delivery, an unlinked PR with the Link a session form open',
    scenario: 'typical',
    route: 'delivery',
    settleProduct: settleDelivery,
    actProduct: async (page) => {
      await toggleFor(page, TITLE.unlinked).click();
      await evidenceLoaded(page);
      await page.getByRole('button', { name: 'Link a session' }).click();
      await page.getByRole('combobox').waitFor();
    },
    actD7: async (page) => {
      await toggleFor(page, TITLE.unlinked).click();
      await page.locator('[data-act="link-add-open"]').first().click();
      await page.locator('select[data-input="addlink"]').waitFor();
    },
  },
  {
    id: 'delivery-undo-toast',
    title: 'Delivery, a suggestion confirmed, with its toast and Undo',
    scenario: 'typical',
    route: 'delivery',
    nearest:
      'D7 draws the Undo toast over the page; the product’s is Astryx’s own toast in its corner (a Design question since M7), so the two differ in placement.',
    settleProduct: settleDelivery,
    actProduct: async (page) => {
      await toggleFor(page, TITLE.suggested).click();
      await evidenceLoaded(page);
      await page.getByRole('button', { name: /^Confirm link/ }).click();
      await page
        .getByRole('region', { name: 'Notifications' })
        .getByText('Link confirmed and labeled Owner-confirmed.')
        .waitFor();
    },
    actD7: async (page) => {
      await toggleFor(page, TITLE.suggested).click();
      await page.locator('[data-act="link-confirm"]').first().click();
      await page.locator('.toast').first().waitFor();
    },
  },
  {
    id: 'usage-links',
    title: 'Usage, every row open, with each session’s PR links',
    scenario: 'typical',
    route: 'usage',
    expandTree: true,
    settleProduct: async (page) => {
      await page.getByRole('heading', { level: 2, name: 'Sessions by repository' }).waitFor();
      await page
        .locator('section[aria-labelledby="us-tree-title"] button[aria-expanded]')
        .first()
        .waitFor();
    },
    wrapCheck: { table: /^Sessions grouped by/, columns: ['Provider', 'Model', 'Started'] },
  },
  {
    id: 'overview-linked',
    title: 'Overview, with the Linked PRs tile',
    scenario: 'typical',
    route: 'overview',
    productPath: '/',
    settleProduct: overviewSettle,
  },
];

/** Both account reports come from the real app over the synthetic Codex and Claude providers. */
async function readBothAccounts(world: World): Promise<void> {
  await world.chatgpt.read();
  await world.claude.check();
}

const accountsRegion = (page: Page): Locator =>
  page.getByRole('region', { name: 'Accounts', exact: true });
const settleAccounts = async (page: Page): Promise<void> => {
  await settleSources(page);
  await accountsRegion(page).locator(':scope > ul > li').first().waitFor();
  await page.waitForTimeout(300);
};

const M9_SHOTS: readonly Shot[] = [
  {
    id: 'overview-accounts',
    title: 'Overview, both account reports available',
    scenario: 'typical',
    route: 'overview',
    productPath: '/',
    prepareProduct: readBothAccounts,
    settleProduct: async (page) => {
      await overviewSettle(page);
      await page
        .getByRole('region', { name: 'Account-reported usage', exact: true })
        .getByText('of weekly usage limit used')
        .waitFor();
    },
  },
  {
    id: 'sources-accounts',
    title: 'Sources & repos, both account reports available',
    scenario: 'typical',
    route: 'sources',
    nearest:
      'D7 lists GitHub, ChatGPT and Claude as three rows of one Accounts card; the product keeps GitHub in its own card (M6) and lists ChatGPT and Claude in Accounts, with the on-demand plan check in the Claude row.',
    prepareProduct: readBothAccounts,
    settleProduct: settleAccounts,
  },
  {
    id: 'sources-claude-removal',
    title: 'Sources & repos, Claude legacy status-line removal preview',
    scenario: 'typical',
    route: 'sources',
    nearest:
      'The D7 Sources page shows its original Connect button. The product opens a preview for manual removal of the recorded legacy hook.',
    prepareProduct: async (world) => {
      await world.claude.seedLegacyHook({ theme: 'dark' });
    },
    settleProduct: settleAccounts,
    actProduct: async (page) => {
      await accountsRegion(page).getByRole('button', { name: 'Remove old status line' }).click();
      await page.getByLabel('Status line now').waitFor();
    },
  },
  {
    id: 'sources-chatgpt-signin',
    title: 'Sources & repos, the ChatGPT sign-in waiting panel',
    scenario: 'typical',
    route: 'sources',
    nearest:
      'The sign-in waiting panel is not designed yet; D7 starts a simulated sign-in from the ChatGPT row, so its picture is the Sources page before it.',
    prepareProduct: async (world) => {
      world.chatgpt.useScenario('login-ok');
    },
    settleProduct: settleAccounts,
    actProduct: async (page) => {
      // Nothing opens a real tab, and the sign-in stays pending so the panel can be photographed.
      await page.evaluate(() => {
        window.open = () => null;
      });
      await page.route(/\/api\/accounts\/chatgpt\/connect\/[^/]+$/, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ state: 'pending' }),
        });
      });
      await accountsRegion(page).getByRole('button', { name: 'Connect ChatGPT' }).click();
      await page.getByRole('group', { name: 'Finish signing in to ChatGPT' }).waitFor();
    },
  },
];

// A full-page picture draws a sticky or fixed bar at the scroll position the page was left at. Pressing a button below the fold
// (Setup's Continue on a phone) scrolls the page, so the bar would be drawn part-way down the picture, over the text, on one side
// only. Both sides are taken from the top, so the two pictures of a pair are made under the same conditions.
const fromTheTop = async (page: Page): Promise<void> => {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(50);
};

// ---- M10: first-launch Setup and the recovery pages (G10_10, G10_1) ----

const setupHeading = (page: Page): Locator =>
  page.getByRole('heading', { level: 1, name: 'Setup' });
const lookDone = async (page: Page): Promise<void> => {
  await setupHeading(page).waitFor();
  await page.waitForFunction(() => !document.body.innerText.includes('Looking…'));
  await page.waitForTimeout(150);
};
const productContinue = async (page: Page, nextHeading: string): Promise<void> => {
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('heading', { level: 2, name: nextHeading }).waitFor();
};
const d7Discovered = async (page: Page): Promise<void> => {
  await page.locator('[data-act="setup-next"]:not([disabled])').waitFor({ timeout: 15000 });
};
const d7Continue = async (page: Page, times: number): Promise<void> => {
  for (let step = 0; step < times; step += 1) {
    await d7Discovered(page);
    await page.locator('[data-act="setup-next"]').click();
    await page.waitForTimeout(150);
  }
};
const mountMachine = (machine: Machine) => async (page: Page, world: World) => {
  await mountSetup(page, world, { hold: false, ...machine });
};
/** Paseo asks for a password and both providers are found: D7's first launch (Codex and Claude Code found, Paseo needs a password). */
const FOUND: Machine = { paseo: 'password' };

const RECOVERY_NEAREST =
  'No recovery page is designed (the three are plain pages from the technical document), so D7 shows its Sources & repos page, its nearest part: a page about the state of the data, with the same headings and cards.';
const RECOVERY_WIDTHS_NOTE = {
  scenario: 'typical' as const,
  route: 'sources',
  nearest: RECOVERY_NEAREST,
};

const M10_SHOTS: readonly Shot[] = [
  {
    id: 'setup-found',
    title: 'Setup, step 1: Codex and Claude Code found',
    scenario: 'empty',
    d7Scenario: 'first-launch',
    route: 'setup',
    productPath: '/',
    firstLaunch: true,
    mountProduct: mountMachine(FOUND),
    settleProduct: lookDone,
    actD7: d7Discovered,
  },
  {
    id: 'setup-accounts',
    title: 'Setup, step 2: connect accounts',
    scenario: 'empty',
    d7Scenario: 'first-launch',
    route: 'setup',
    productPath: '/',
    firstLaunch: true,
    mountProduct: mountMachine(FOUND),
    settleProduct: lookDone,
    actProduct: (page) => productContinue(page, 'Connect accounts'),
    actD7: (page) => d7Continue(page, 1),
  },
  {
    id: 'setup-repos',
    title: 'Setup, step 3: choose repositories',
    scenario: 'empty',
    d7Scenario: 'first-launch',
    route: 'setup',
    productPath: '/',
    firstLaunch: true,
    mountProduct: mountMachine(FOUND),
    settleProduct: lookDone,
    actProduct: async (page) => {
      await productContinue(page, 'Connect accounts');
      await productContinue(page, 'Choose repositories to track');
    },
    actD7: (page) => d7Continue(page, 2),
  },
  {
    id: 'setup-nothing-found',
    title: 'Setup, step 1: nothing found on this machine',
    scenario: 'empty',
    d7Scenario: 'nothing-found',
    route: 'setup',
    productPath: '/',
    firstLaunch: true,
    mountProduct: mountMachine({
      paseo: 'down',
      homeOptions: { claude: 'absent', codex: 'absent' },
    }),
    settleProduct: lookDone,
    actD7: d7Discovered,
  },
  {
    id: 'setup-denied',
    title: 'Setup, step 1: a folder that cannot be read',
    scenario: 'empty',
    d7Scenario: 'first-launch',
    route: 'setup',
    productPath: '/',
    firstLaunch: true,
    nearest:
      'D7 draws "Needs a password" for Paseo only (its first-launch scenario); the product picture has Claude Code’s folder unreadable (macOS without Files and Folders access) and Paseo asking for a password.',
    mountProduct: mountMachine({ paseo: 'password', homeOptions: { claude: 'denied' } }),
    settleProduct: lookDone,
    actD7: d7Discovered,
  },
  {
    id: 'recovery-database',
    title: 'Recovery page: the database can’t be read',
    ...RECOVERY_WIDTHS_NOTE,
    productHtml: databaseRecoveryPage({
      reason: 'corrupt',
      dbPath: '/Users/example/.agent-productivity/agent-productivity.db',
      detail: 'SQLite reports the file is damaged or is not a database.',
    }),
    settleProduct: async (page) => {
      await page.getByRole('heading', { level: 1 }).waitFor();
    },
  },
  {
    id: 'recovery-already-running',
    title: 'Recovery page: already running',
    ...RECOVERY_WIDTHS_NOTE,
    productHtml: alreadyRunningPage({
      url: 'http://127.0.0.1:4317',
      lockPath: '/Users/example/.agent-productivity/agent-productivity.lock',
      pid: 4242,
    }),
    settleProduct: async (page) => {
      await page.getByRole('heading', { level: 1 }).waitFor();
    },
  },
  {
    id: 'recovery-disk-full',
    title: 'Recovery page: not enough disk space',
    ...RECOVERY_WIDTHS_NOTE,
    productHtml: diskFullPage({
      dataDir: '/Users/example/.agent-productivity',
      detail: 'The disk has no room left for the database.',
    }),
    settleProduct: async (page) => {
      await page.getByRole('heading', { level: 1 }).waitFor();
    },
  },
  {
    id: 'overview-retry-recovered',
    title: 'Overview after Retry: the refresh worked, the banner is gone',
    scenario: 'refresh-failed',
    route: 'overview',
    productPath: '/',
    // The real refresh runner over the world's database, with Codex answering (4 new sessions), so Retry does what it does in use.
    mountProduct: async (page, world) => {
      const logger = createLogger({ sink: () => undefined, level: 'warn', now: () => FIXED_NOW });
      const runner = createRunner({
        db: world.db,
        now: () => FIXED_NOW,
        logger,
        adapters: [scriptedAdapter('codex', [succeeds({ imported: 4 })])],
      });
      const api = new Hono<HttpEnv>();
      api.use('*', correlation());
      api.onError(errorHandler(logger));
      api.route('/', sourcesRoutes({ db: world.db, timezone: FIXED_TIMEZONE }));
      api.route('/', refreshRoutes({ db: world.db, runner }));
      await page.route(
        (url) => url.origin === ORIGIN && /^\/api\/(sources|refresh)(\/|$)/.test(url.pathname),
        async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          const answer = await answerApi(api, {
            method: request.method(),
            path: url.pathname + url.search,
            headers: request.headers(),
            body: request.postDataBuffer(),
          });
          await route.fulfill({
            status: answer.status,
            headers: answer.headers,
            body: answer.body,
          });
        },
      );
    },
    settleProduct: async (page) => {
      await page.getByRole('status').filter({ hasText: 'Showing cached data.' }).waitFor();
      await overviewSettle(page);
    },
    actProduct: async (page) => {
      const banner = page.getByRole('status').filter({ hasText: 'Showing cached data.' });
      await banner.getByRole('button', { name: 'Retry' }).click();
      await banner.waitFor({ state: 'detached' });
      await page
        .getByRole('region', { name: 'Notifications' })
        .getByText('Codex refreshed', { exact: false })
        .first()
        .waitFor();
    },
    actD7: async (page) => {
      await page.locator('[data-fk="banner-retry"]').click();
      await page.locator('.banner').waitFor({ state: 'detached' });
      await page.waitForTimeout(150);
    },
  },
];

/** Every product route on the final tree, measured with the containment helper (and Usage's and Delivery's data cells), not photographed. */
const sweepOf = (shot: Shot | undefined): Shot[] =>
  shot
    ? [
        {
          ...shot,
          id: `sweep-${shot.id}`,
          title: `Sweep: ${shot.title}`,
          sweep: true,
          actProduct: undefined,
          actD7: undefined,
          nearest: undefined,
          expandTree: undefined,
        },
      ]
    : [];
const SWEEP_SHOTS: readonly Shot[] = [
  ...sweepOf(M7_SHOTS.find((shot) => shot.id === 'overview')),
  ...sweepOf(M7_SHOTS.find((shot) => shot.id === 'trends')),
  // Delivery's Linked sessions cell is a stack since M8 (providers, then the count): its pieces must not break, the other columns must not wrap.
  ...sweepOf(M6_SHOTS.find((shot) => shot.id === 'delivery')).map((shot) => ({
    ...shot,
    wrapCheck: {
      table: /^Merged pull requests/,
      columns: ['Merged', 'Author', 'Merged by', 'Link basis'],
      stacked: 'Linked sessions',
    },
  })),
  ...sweepOf(M4_SHOTS.find((shot) => shot.id === 'usage')),
  ...sweepOf(M6_SHOTS.find((shot) => shot.id === 'sources')),
  {
    id: 'sweep-not-found',
    title: 'Sweep: a page that does not exist',
    scenario: 'typical',
    route: 'nowhere',
    sweep: true,
    settleProduct: async (page) => {
      await page.getByRole('heading', { level: 1 }).waitFor();
    },
  },
];

const SHOTS =
  SET === 'm10'
    ? // A folder that cannot be read needs a user that chmod 000 keeps out; root reads anything, so that one picture is left out there.
      [...M10_SHOTS.filter((shot) => shot.id !== 'setup-denied' || CAN_DENY), ...SWEEP_SHOTS]
    : SET === 'm4'
      ? M4_SHOTS
      : SET === 'm7'
        ? M7_SHOTS
        : SET === 'm8'
          ? M8_SHOTS
          : SET === 'm9'
            ? M9_SHOTS
            : M6_SHOTS;

const name = (shot: Shot, side: 'product' | 'd7', width: number) =>
  `${shot.id}-${side}-${width}.png`;

async function withPage<T>(
  width: number,
  height: number,
  run: (page: Page) => Promise<T>,
): Promise<T> {
  // A fresh browser each time: the headless shell runs in one process here, and a shared one crashes on its second context.
  const browser = await chromium.launch({ ...LAUNCH_OPTIONS, headless: HEADLESS });
  try {
    const context = await browser.newContext({ ...CONTEXT_OPTIONS, viewport: { width, height } });
    return await run(await context.newPage());
  } finally {
    await browser.close();
  }
}

/** Presses every closed toggle in `rows` until none is left and nothing is still loading. */
async function openEverything(page: Page, closed: Locator, loading: Locator): Promise<void> {
  for (let step = 0; step < 300; step += 1) {
    if ((await closed.count()) > 0) {
      await closed.first().click();
      await page.waitForTimeout(40);
      continue;
    }
    await page.waitForTimeout(120);
    if ((await closed.count()) === 0 && (await loading.count()) === 0) return;
  }
  throw new Error('the tree kept opening: more than 300 toggles');
}

interface Result {
  shot: Shot;
  width: number;
  report: ContainmentReport;
  problems: string[];
  /** Usage at 1280 only: how many data cells were checked. */
  wrappedChecked: number | null;
}

async function captureProduct(shot: Shot, width: number, height: number): Promise<Result> {
  const world = createWorld({
    scenario: shot.scenario,
    ...(shot.ghSignedIn === undefined ? {} : { ghSignedIn: shot.ghSignedIn }),
    ...(shot.firstLaunch ? { firstLaunch: true } : {}),
  });
  try {
    await shot.prepareProduct?.(world);
    return await withPage(width, height, async (page) => {
      await serveWorld(page, world);
      await shot.mountProduct?.(page, world);
      // Overview greets by the part of the day on the browser's clock; the world's clock is 9:42 AM Pacific, so the browser's is too.
      if (SET === 'm7' || SET === 'm8' || SET === 'm9' || SET === 'm10') {
        await page.clock.setFixedTime(new Date('2026-11-04T17:42:00Z'));
      }
      if (shot.productHtml !== undefined) await page.setContent(shot.productHtml);
      else await page.goto(`${ORIGIN}${shot.productPath ?? `/${shot.route}`}`);
      await shot.settleProduct(page);
      if (shot.expandTree) {
        const tree = page.locator('section[aria-labelledby="us-tree-title"]');
        await openEverything(
          page,
          tree.locator('button[aria-expanded="false"]'),
          tree.getByText('Loading sessions…'),
        );
      }
      if (shot.actProduct) await shot.actProduct(page);
      await page.waitForTimeout(250); // toggles turn, fonts settle
      // A recovery page is a plain document with no #root: its main landmark is the page.
      const report = await measureContainment(
        page,
        shot.productHtml === undefined ? {} : { root: 'main' },
      );
      const problems = failures(report);
      let wrappedChecked: number | null = null;
      const wrapCheck =
        shot.wrapCheck ??
        (shot.id === 'usage'
          ? { table: /^Sessions grouped by/, columns: ['Provider', 'Model', 'Started'] }
          : undefined);
      if (wrapCheck && width === 1280) {
        const table = page.getByRole('table', { name: wrapCheck.table });
        const wrapped = await findWrappedCells(table, wrapCheck.columns);
        wrappedChecked = wrapped.checked;
        if (wrapped.checked === 0) {
          problems.push(`no ${wrapCheck.columns.join(', ')} cell was checked`);
        }
        problems.push(...wrapped.wrapped.map((cell) => `a data cell can wrap: ${cell}`));
        if (wrapCheck.stacked !== undefined) {
          // A stacked cell (providers, then the count) has several lines by design; none of its pieces may break across lines.
          const pieces = await findWrappedPieces(table, wrapCheck.stacked);
          wrappedChecked += pieces.checked;
          if (pieces.checked === 0) problems.push(`no ${wrapCheck.stacked} piece was checked`);
          problems.push(...pieces.wrapped.map((piece) => `a data cell can wrap: ${piece}`));
        }
      }
      if (!shot.sweep) {
        await fromTheTop(page);
        await page.screenshot({ path: join(OUT, name(shot, 'product', width)), fullPage: true });
      }
      return { shot, width, report, problems, wrappedChecked };
    });
  } finally {
    world.close();
  }
}

async function captureD7(shot: Shot, width: number, height: number): Promise<void> {
  await withPage(width, height, async (page) => {
    await serveBuild(page, PROTOTYPE);
    await page.goto(`${ORIGIN}/index.html#/${shot.route}`);
    await page.locator('#main h1, main h1, h1').first().waitFor();
    const d7Scenario = shot.d7Scenario ?? shot.scenario;
    if (d7Scenario !== 'typical') {
      // The scenario is chosen in the prototype's own review panel.
      await page.locator('.proto-toggle').click();
      await page.locator(`input[name="scenario"][value="${d7Scenario}"]`).check({ force: true });
      await page.locator('.proto-toggle').click();
      await page.locator('h1').first().waitFor();
    }
    // The review panel is a tool of the prototype, not part of the design being compared.
    await page.addStyleTag({ content: '#proto-root { display: none !important; }' });
    if (shot.expandTree) {
      await openEverything(
        page,
        page.locator('button.row-toggle[aria-expanded="false"]'),
        page.locator('.never-matches'),
      );
    }
    if (shot.actD7) await shot.actD7(page);
    await page.waitForTimeout(250);
    await fromTheTop(page);
    await page.screenshot({ path: join(OUT, name(shot, 'd7', width)), fullPage: true });
  });
}

/**
 * What was seen by eye on each pair, fixed or listed with its reason (M9, G9_9). Written here because the script does not judge
 * pictures: this is the reviewer's reading, kept beside the pictures it is about.
 */
const M9_NOTES: readonly string[] = [
  '## Current account scenarios',
  '',
  'The Claude report uses a scripted plan check. The legacy removal scenario uses temporary Claude Code settings.',
  '',
  '## Historical M9 comparison',
  '',
  'Looked at by eye in Chromium only (no Safari or WebKit): the 1280px pairs of Overview and of Sources with the accounts connected, the',
  'product pictures of the Claude preview at 1280 and of the ChatGPT sign-in panel and Overview at 390. The other pictures (every 320px',
  'pair, and the prototype side at 390) were measured (the containment column above, and accounts.spec.ts at 1280, 390 and 320) but not',
  'read pair by pair. The page order, the Account-reported usage card beside the chart, each account’s name, plan and status tag, the',
  'large figure with its unit, the date and reset chips, the "Shown separately, not added together" line, the footnote, and on Sources the',
  'Accounts card with Connect or Disconnect at the right of each row match the prototype in structure and spacing.',
  '',
  'Fixed during this comparison:',
  '- With both cards connected, the Account-reported usage card is taller than the chart, and the chart’s card stopped at its own height',
  '  where D7’s two cards fill the row together. Both cards now fill the row.',
  '',
  'Listed, with the reason:',
  '- The Claude and ChatGPT figures in the product pictures are not D7’s (900 tokens against 80.4M). A connected product account comes from a',
  '  read, and the picture’s read is the scripted Codex used by the specs (seven small daily totals), not D7’s invented 30-day total.',
  '- The ChatGPT chip names the dates the figure covers inside the selected period ("Nov 2 – Nov 4, 2026"; the selection counts only up to',
  '  today); D7 says "Oct 5 – Nov 3, 2026 · Rolling 30 days". The strip says the same dates. D7’s yellow "Reporting window differs" panel',
  '  is therefore not in the product picture, because here the dates match; accounts.spec.ts asserts it for a period that starts before the data.',
  '- A card says "As of today, 9:42 AM" where D7 says "Updated Today, 9:42 AM"; accounts.spec.ts asserts the product’s wording.',
  '- Each card carries its own "Not filtered by repo" chip (G9_9 names it as a scope chip); D7 draws it once in the section head and',
  '  an "Account-wide" chip on the Claude card. The Claude card also has the smaller 5-hour line and a "Plan-wide · only Claude Code sessions',
  '  that use the status line" caption, which D7 does not draw (the first is the small extension TECH names; Design has been told).',
  '- An account that uses an existing sign-in reads "Using your existing sign-in" in its tag and then "Using your existing Codex sign-in"',
  '  under it, because the tag is short words and the server’s sentence says which sign-in. D7 has the one long sentence. Listed for Design.',
  '- On Sources the ChatGPT row has no "Usage report: tokens · …" or "Last report" line, which D7 draws: the Sources response carries no',
  '  report details (they come with the Overview). The Claude row has its own report and last-update lines. Listed for Design and a later milestone.',
  '- GitHub keeps its own card above Tracked repositories (M6), where D7 lists it as the first row of Accounts; the Claude row has the',
  '  switch and its health lines, which D7 does not have.',
  '- The Claude preview panel and the ChatGPT sign-in waiting panel are not designed, so the prototype’s pair is its Sources page. Both are',
  '  built from the sunken panel the GitHub device-code panel uses, with Cancel on the left and the primary action on the right.',
  '- In the preview panel the hook command is a long line that wraps inside its box; it is the exact text that would be written.',
  '- Carried from earlier milestones and unchanged: "Good morning" for "Morning, Kelvin", the Sources badge count (1 against D7’s 2), and',
  '  the strip’s GitHub counts.',
  '- In the full-page pictures both sides draw their fixed bars (app bar, tab bar) once in the middle of the page; that is how a full-page',
  '  photograph of a fixed element looks, not part of either design.',
  '- Not photographed: each Claude health state (waiting, no limits, idle, replaced, node missing, settings unreadable), the capture refusals,',
  '  a failed sign-in and a reset window. They are asserted in accounts.spec.ts (axe and containment at 1280, 390 and 320 on the preview and cards).',
  '',
];

/**
 * What was seen by eye on each pair, fixed or listed with its reason (M10, G10_10 and G10_1). Written here because the script does not
 * judge pictures: this is the reviewer's reading, kept beside the pictures it is about.
 */
const M10_NOTES: readonly string[] = [
  '## What was compared, and what differs',
  '',
  'Looked at by eye in Chromium only (no Safari or WebKit). Every pair of this set was read at 1280, 390 and 320px on the pictures in this',
  'folder as they are now (the seven pairs that had been read before the Setup spacing fix were read again), and what was seen is recorded',
  'in docs/implementation/evidence/pair-reading.md. Both sides of every picture are taken from the top of the page, so a sticky bar is drawn',
  "at the top of both. Setup's folders in the product pictures are a",
  "temporary home made for the picture, so their paths are temporary folders, not anyone's own.",
  '',
  'Fixed during this comparison:',
  '- The Setup step indicator (SETUP_STEPPER_MAPPING, seventh correction). The product drew the Astryx Stepper, a connected progress track that stood',
  "  in one column on a phone. It now draws D7's three pills (`SetupProgress`, a product-owned ordered list): one wrapping row at every width, so",
  '  at 390 and 320px Local sources and Accounts share a line and Repositories wraps under them, as in D7. The current step, the check on each',
  '  passed step and the full labels were read on all nine Setup pairs; `setup.spec.ts` measures the same geometry on every step.',
  '- The product drew "Setup" as a large visible heading above D7\'s heading ("Let\'s find your agents"), which it had made a smaller line. The',
  '  heading is now D7\'s, and "Setup: " is read only by assistive technology (the tab title and the heading\'s name still start with Setup).',
  '- On a first launch the redirect to Setup put the keyboard focus on that heading, which drew a focus ring around it in the first picture.',
  "  Arriving at Setup no longer takes focus (Finish still lands focus on the new page's heading).",
  '- The app bar on Setup carried the source-issue chip and Refresh, where D7 draws "Step N of 3". Setup now draws that caption, and no',
  '  Refresh: nothing is imported before Finish. Removing the chip left nothing watching the bootstrap answer, so Finish sent the owner',
  '  straight back to Setup (setup.spec.ts caught it, three tests); Finish now reads the bootstrap again whether or not anything watches it,',
  '  with a unit test that fails without it.',
  '',
  'Listed, with the reason:',
  '- Location lines. The product prints the folder it found ("Location /…/.codex/sessions · found automatically"); D7 prints "Sessions from Feb 2,',
  '  2026 · ~/.codex/sessions". The date needs the history read, which discovery never does before Finish, and "~" for the home is a Design call.',
  '- Skip. Each step has "Skip this step" beside Continue (TECH J1: each step is skippable); D7 has Back and Continue only.',
  '- Step 2 lists GitHub and ChatGPT; D7 also lists Claude. Claude plan limits can be checked on demand in Sources & repos.',
  '- Paseo\'s two states. The accepted Design revision (D8) now reads "Needs a password" and "Not running", with the product\'s helper sentences, so',
  '  no difference remains there (a Paseo that is not running is "Not running" on both sides, not "Not found").',
  "- The unreadable-folder picture (Claude Code's folder, macOS without Files and Folders access) has no D7 counterpart: D7's first-launch scenario",
  '  is its nearest part.',
  '- The three recovery pages have no designed screen. They are plain documents (system font, white page, no app bar, no product art) because',
  "  they must render when the app cannot start; D7's Sources & repos page is the nearest part. Listed for Design: whether they should look like the product.",
  '- Retry aftermath (overview-retry-recovered, the state after pressing Retry on a failed refresh). The banner is gone in both, the strip reads',
  '  Codex as recovered, the issue chip is one lower and a recovered toast shows. Listed: the toast is a centred dark pill in D7 and Astryx\u2019s own,',
  '  bottom right with a close button, in the product; the sessions counted (D7 3, the product 4) and the product\u2019s Recorded local tokens come from the two',
  '  seeded worlds. The product side runs the real refresh runner with a scripted Codex that succeeds.',
  '- Not photographed: Setup with GitHub signed out (the App guide and the client-ID field), the device-code panel inside Setup, a failed Finish, and',
  '  Finish landing on Overview with skeletons. They are asserted in setup.spec.ts (axe and containment at 1280, 390 and 320).',
  '- In the full-page pictures both sides draw their fixed bars once at the top; that is how a full-page photograph looks, not part of either design.',
  '',
];

const M8_NOTES: readonly string[] = [
  '## What was compared, and what differs',
  '',
  'Looked at by eye in Chromium only (no Safari or WebKit). Every pair of this set was read at 1280, 390 and 320px after this README was',
  'first written, and what was seen is recorded in docs/implementation/evidence/pair-reading.md.',
  'The page order, the PR rows with their Linked sessions and Link basis cells, the opened row (evidence cards, Link a session, the',
  'footnote), the Link a session form (label, select, Cancel on the left, Add link on the right), the Usage tree with its Linked PRs',
  'column and "not checked" words, and the Overview Linked PRs tile ("5 of 8", "1 with suggestions only") match the prototype in',
  'structure, words and spacing.',
  '',
  'Fixed during this comparison:',
  '- The evidence panel was capped at 48rem, so on a wide screen its cards stopped short of the table’s right edge, where D7’s span the',
  '  row. The cap is removed.',
  '- A Usage `#number` link opened Delivery on the current week, so for any PR merged earlier it showed no row. It now opens Delivery on the',
  '  PR’s merge day, for every author, with the search for that PR (the prototype’s `gotoPr` widens the period and the author the same',
  '  way). Found in the crew review rather than in a picture; a unit test and a browser spec hold it.',
  '',
  'Listed, with the reason:',
  '- An evidence card stacks the session’s identity lines (name, relationship, id, then provider · model · Started), because it reuses the',
  '  shared SessionIdentity from the Usage tree; D7 runs them on two lines and puts a provider chip after the name. The words are the same and',
  '  the card is taller. Listed for Design.',
  '- A ghost button (Mark incorrect) is drawn in the action purple in D7 and in ink in the product: the Astryx ghost variant. Listed for Design.',
  '- An owner-confirmed link’s basis keeps what the source claimed ("Confirmed by you (was suggested: Same repo · active within 48 h before',
  '  merge)"); D7 says only "Confirmed by you". The words come from the server (TECH keeps the source claim).',
  '- The cards of one PR are ordered evidence, owner, suggested, then marked incorrect (the server’s order, the T5 interim choice); D7 keeps',
  '  its data order, so its struck-through card comes first.',
  '- Restore has an Undo, and an Undo says "Change undone."; D7 has neither. TECH says every change can be undone.',
  '- The struck-through card is not drawn at 0.75 opacity as in D7: the muted text on it would likely fail AA contrast (reasoned from the',
  '  numbers, not measured). The struck badge and the Restore button carry the state.',
  '- The Undo toast is Astryx’s own, bottom right, with a close button and a wrapped sentence; D7 draws a centred dark pill. A Design question',
  '  since M7 (the toast placement).',
  '- After a suggestion is confirmed the product offers no Link a session on that PR (the server has no other candidate in range); D7',
  '  still offers one.',
  '- The Usage `#number` link lands on the PR’s row but does not open it or move focus to its toggle, as D7’s `gotoPr` does.',
  '- The Usage page keeps the coverage strip decided in M4; D7 has none. Siblings that started in the same minute can sit in another',
  '  order, and some Started times differ from D7 by a minute (the seeded world keeps seconds, the prototype rounds); neither is a product rule.',
  '- Carried from M7 and unchanged: "Good morning" for "Morning, Kelvin", account cards "Not connected" until M9, the Sources badge count',
  '  (1 against D7’s 2), and the by-repository table’s order.',
  '- At 320px the prototype’s own Delivery overflows (its picker line and evidence text are cut at the right edge); the product contains at',
  '  every width.',
  '- In the full-page pictures both sides draw their fixed bars (app bar, tab bar) once in the middle of the page; that is how a full-page',
  '  photograph of a fixed element looks, not part of either design.',
  '- Not photographed: the loading, error and failed-save states of the evidence panel and the Usage tree. They are asserted in links.spec.ts',
  '  (a failed change leaves the item as it was and says "Couldn’t save your change"; keyboard-only journey; axe at 1280, 390 and 320).',
  '',
];

/**
 * What was seen by eye on each pair, fixed or listed with its reason (M7, G7_10). Written here, not in the table, because the
 * script does not judge pictures: this is the reviewer's reading, kept beside the pictures it is about.
 */
const M7_NOTES: readonly string[] = [
  '## What was compared, and what differs',
  '',
  'Looked at by eye, pair by pair, in Chromium only (no Safari or WebKit). The page order, the five tiles, the aligned chart with its',
  'coverage rail and hatching, the by-repository table (cards on a phone), recently merged, the Trends year grid and tokens by model, the',
  'drawer (inset panel, tabs, footer actions) and the failed-refresh banner match the prototype in structure and spacing at 1280, 390 and 320.',
  '',
  'Fixed during this comparison:',
  '- By repository listed the repo GitHub no longer grants first (the API sends rows by name); D7 lists readable repos first and the lost',
  '  one after them. The table now orders readable repos by merged PRs, then the lost repo, then the usage-only groups (overview.spec.ts pins it).',
  '- On a phone the segmented controls (Chart/Table, the Delivery link filter) and the two links under the strip and the recent list were',
  '  under 44px. Their tap area is now 44px by a pseudo-element, drawn size unchanged (responsive.spec.ts asserts none is left).',
  '- The capture used the real clock, so the greeting read "Good afternoon"; the product shots now run on the world clock (9:42 AM Pacific).',
  '',
  'Listed, with the reason:',
  '- Account-reported usage reads "Not connected" for ChatGPT and "Not checked" for Claude. D7 draws connected sample accounts.',
  '  Real account cards arrive with M9 (an allowed stub).',
  '- The greeting is "Good morning" where D7 says "Morning, Kelvin": the name is a fixture in the prototype; the product adds a first name',
  '  only when the profile has one, and the seeded world has none.',
  '- The strip and the Sources badge count differently from D7 on the seeded world: "5 repos tracked · 1 inaccessible" and "1 source issue",',
  '  against D7’s "4 repos tracked · 1 inaccessible" and "2 source issues". The product counts a repo GitHub no longer grants as still',
  '  tracked (docs/tech/local-api.md, `github.tracked`) and takes the issue count from the Sources service (M4/M6), not from the prototype’s fixture.',
  '- Trends has no inline "Period records" card. The same lists open in the records drawer from a chart bucket or a day of the year grid,',
  '  as on Overview (the milestone brief: records in the drawer, not inline).',
  '- The drawer’s tab counts are plain text ("Merged PRs 2"); D7 draws a muted count chip. Astryx segment labels are strings, so a chip is',
  '  a Design decision (Delivery’s filter does the same). Listed for Design.',
  '- A repo GitHub no longer grants shows its local token and session figures (0 here) with "—" for the PR figures; D7 shows "—" throughout.',
  '  Local usage is measured whatever GitHub says (local-api M7 delta).',
  '- PR titles in Recently merged and the drawer are dark with an external-link mark, where D7 draws blue underlined links: the shared',
  '  title component from M6, not changed here.',
  '- On a phone the Delivery search box is 44px high (it was 32px) so it is a 44px target; D7 draws it smaller. Listed for Design.',
  '- The quiet true-zero state cannot be reached in D7 with a single-day range, so its picture is D7’s Overview of the same week and the',
  '  quiet panel is compared with D7’s own markup (`.quiet` in docs/design/prototype/app.js): same words, same art, same dashed panel.',
  '- Not photographed because neither side draws a fixed picture of them: chart and drawer loading and error panels, Show more, the',
  '  toast. They are asserted in overview.spec.ts, trends.spec.ts, drawer.spec.ts and responsive.spec.ts instead.',
  '- At 320px the prototype\u2019s own Overview does not fit: its page renders 366px wide and scrolls sideways, so the five Overview',
  '  pictures of D7 at 320 (overview, quiet, history, drawer, refresh-failed) are 366px wide where the product\u2019s are 320px, and D7\u2019s Trends',
  '  picture is 320px. The product contains at every width (the containment column above); the prototype is the thing that overflows.',
  '- Delivery still reports every PR as unlinked until M8 while Overview and the drawer read effective link classes; on the seeded',
  '  preview the two can differ (decision D8).',
  '',
];

/**
 * Keep the existing historical index, including links to identical images retained under other names.
 * Build it from the capture folders only when generating the first M10 report.
 */
function earlierIndex(): string[] {
  const heading = '## Every earlier screen, with its pair at each width';
  const report = join(OUT, 'README.md');
  if (existsSync(report)) {
    const lines = readFileSync(report, 'utf8').split('\n');
    const start = lines.indexOf(heading);
    if (start !== -1) {
      const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
      return [
        ...lines
          .slice(start, end === -1 ? undefined : end)
          .join('\n')
          .trimEnd()
          .split('\n'),
        '',
      ];
    }
  }
  const widths = WIDTHS.map((entry) => entry.width);
  const rows: string[] = [];
  let screens = 0;
  let complete = 0;
  for (const set of ['m4', 'm6', 'm7', 'm8', 'm9'] as const) {
    const dir = join(ROOT, `docs/implementation/evidence/${set}`);
    if (!existsSync(dir)) continue;
    const files = new Set(readdirSync(dir));
    const ids = new Set(
      [...files].flatMap((file) => {
        const match = /^(.+)-product-(?:1280|390|320)\.png$/.exec(file);
        return match ? [match[1]!] : [];
      }),
    );
    for (const id of [...ids].sort()) {
      screens += 1;
      const cells = widths.map((width) => {
        const d7 = `${id}-d7-${width}.png`;
        const product = `${id}-product-${width}.png`;
        return files.has(d7) && files.has(product)
          ? `[D7](../${set}/${d7}) · [product](../${set}/${product})`
          : 'missing';
      });
      if (cells.every((cell) => cell !== 'missing')) complete += 1;
      rows.push(`| ${set.toUpperCase()} | ${id} | ${cells.join(' | ')} |`);
    }
  }
  return [
    heading,
    '',
    `Read from \`docs/implementation/evidence/\` when this set was written: ${screens} screens, ${complete} with a prototype picture and a product picture at all three widths.`,
    '',
    '| Set | Screen | 1280 | 390 | 320 |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ];
}

function readme(results: readonly Result[]): string {
  const lines = [
    `# ${SET.toUpperCase()} rendered comparison with the D7 prototype`,
    '',
    'Written by `node scripts/capture-fidelity.ts`. The D7 prototype (`docs/design/prototype/`) and the product were rendered in',
    "Playwright's headless Chromium from the same synthetic world (fixed clock Wed Nov 4, 2026, 9:42 AM, America/Los_Angeles) at",
    `1280, 390 and 320px wide, on Node ${process.version}. Pages are full-page screenshots; the prototype's review panel is hidden.`,
    "The prototype's Refresh failed scenario is chosen in its own panel; the product's is the seed's `refresh-failed` world.",
    '',
    'The script does not judge the pictures. It measures the PRODUCT pages with the containment helper (`test/e2e/helpers/containment.ts`,',
    "the port of the prototype's containment check) and, where a table is drawn (Usage, Delivery) at 1280, checks that no data cell of its",
    'data columns can wrap.',
    'Historical visual comparison notes and their limits are summarized in',
    '`docs/implementation/evidence/pair-reading.md`.',
    '',
    '| State | Width | D7 prototype | Product | Containment FAIL | CHECK | Local scrollers | Wrapped-cell check |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const { shot, width, report, problems, wrappedChecked } of results) {
    const pictures = shot.sweep
      ? 'not photographed | not photographed'
      : `[${name(shot, 'd7', width)}](${name(shot, 'd7', width)}) | [${name(shot, 'product', width)}](${name(shot, 'product', width)})`;
    lines.push(
      `| ${shot.title} | ${width} | ${pictures} | ${
        problems.filter((p) => !p.startsWith('a data cell') && !p.startsWith('no ')).length
      } | ${report.spill.length} | ${report.scrollers.length} | ${
        wrappedChecked === null
          ? 'n/a'
          : `${wrappedChecked} cells checked, ${problems.filter((p) => p.startsWith('a data cell')).length} can wrap`
      } |`,
    );
  }
  const nearest = [...new Map(results.map((r) => [r.shot.id, r.shot])).values()].filter(
    (shot) => shot.nearest !== undefined,
  );
  if (nearest.length > 0) {
    lines.push(
      '',
      'Compared only with the nearest part of the prototype (no designed screen exists for these states):',
      ...nearest.map((shot) => `- ${shot.title}: ${shot.nearest}`),
    );
  }
  const found = results.flatMap((r) =>
    r.problems.map((p) => `- ${r.shot.title} at ${r.width}px: ${p}`),
  );
  lines.push(
    '',
    found.length === 0 ? 'No containment FAIL and no wrapped data cell.' : 'Problems found:',
    ...found,
    '',
  );
  // The same CHECK repeats for every row (a row toggle's phone hit area is drawn outside its 24px box), so count them.
  const checks = new Map<string, number>();
  for (const r of results) {
    for (const item of r.report.spill) {
      const key = `${r.shot.title} at ${r.width}px: ${item}`;
      checks.set(key, (checks.get(key) ?? 0) + 1);
    }
  }
  if (checks.size > 0) {
    lines.push(
      'CHECK items (content wider than its own box; reported, not failures). `button.relative.inline-flex` is a row toggle:',
      'on a phone its 44px touch target is drawn around the 24px button, which the check reads as content wider than the box.',
      ...[...checks].map(([item, times]) => `- ${item}${times > 1 ? ` (×${times})` : ''}`),
      '',
    );
  }
  if (SET === 'm10') lines.push(...earlierIndex(), ...M10_NOTES);
  if (SET === 'm7') lines.push(...M7_NOTES);
  if (SET === 'm8') lines.push(...M8_NOTES);
  if (SET === 'm9') lines.push(...M9_NOTES);
  return lines.join('\n');
}

try {
  await ensureBuilt(ROOT, console.log);
  mkdirSync(OUT, { recursive: true });
  const results: Result[] = [];
  for (const shot of SHOTS) {
    for (const { width, height } of WIDTHS) {
      console.log(`${shot.title} at ${width}px…`);
      if (!shot.sweep) await captureD7(shot, width, height);
      results.push(await captureProduct(shot, width, height));
    }
  }
  writeFileSync(join(OUT, 'README.md'), readme(results));
  const problems = results.flatMap((r) =>
    r.problems.map((p) => `${r.shot.title} at ${r.width}px: ${p}`),
  );
  console.log(
    `Wrote ${results.filter((r) => !r.shot.sweep).length * 2} screenshots and README.md to docs/implementation/evidence/${SET}/.`,
  );
  if (problems.length > 0) {
    console.error(
      `The product has ${problems.length} layout problem(s):\n  ${problems.join('\n  ')}`,
    );
    process.exit(1);
  }
  console.log('No containment FAIL and no wrapped data cell in the product.');
} catch (error) {
  console.error(
    `The comparison could not run: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
}
