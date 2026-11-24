import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import type { Db } from '../../src/server/db/open.ts';
import { getRepo } from '../../src/server/db/queries/repos.ts';
import { FIXED_NOW } from '../fixtures/seed.ts';
import { expect, test } from './fixtures';
import { RETENTION_DAYS } from '../../src/shared/domain/coverage.ts';
import { cutLabels, failures, measureContainment } from './helpers/containment';
import { ORIGIN } from './helpers/virtualOrigin';

// Sources: tracked repositories and the GitHub connection (M6: G6_10, and the client half of G6_5), in the real build in a real
// browser over the real API and a seeded database. GitHub is the scripted double (test/fixtures/github): `gh` signed in as the
// seeded login, the seeded repos, `kelvin/archive-private` that nobody can read, and `kelvin/dotfiles` with three merged PRs that is
// not tracked yet. The Keychain is in memory. Nothing reaches the network, the real Keychain or `gh`.
//
// The clock is the seed's fixed one (Wed 2026-11-04 9:42 AM in America/Los_Angeles); the account card is cached for 10 seconds of
// that clock, so a change made behind the app's back (`world.github.signOutGh()`) is followed by `world.setNow(…)` before the page
// is read again. Anything done through the app's own routes shows at once.

const reposSection = (page: Page): Locator =>
  page.getByRole('region', { name: 'Tracked repositories' });
const githubSection = (page: Page): Locator =>
  page.getByRole('region', { name: 'GitHub', exact: true });
const repoRow = (page: Page, id: string): Locator =>
  reposSection(page).locator(':scope > ul > li, :scope > div > ul > li').filter({ hasText: id });
const repoPicker = (page: Page): Locator =>
  page.getByRole('dialog', { name: 'Add repository', exact: true });
const pickerTrigger = (page: Page): Locator =>
  reposSection(page).getByRole('button', { name: 'Add repository', exact: true });
const addField = (page: Page): Locator =>
  repoPicker(page).getByLabel(/^(Find a repository|Add a GitHub repository)$/);
const openPicker = (page: Page) => pickerTrigger(page).click();
const trackButton = (page: Page, name: string): Locator =>
  repoPicker(page).getByRole('button', { name, exact: true });
const clientIdField = (page: Page): Locator =>
  githubSection(page).getByLabel('GitHub App client ID');
const tagOf = (within: Locator, text: string): Locator => within.getByText(text, { exact: true });
/** A toast, found in the visible notifications (Astryx also repeats its words in a hidden live region for screen readers). */
const toastWith = (page: Page, text: string): Locator =>
  page.getByRole('region', { name: 'Notifications' }).getByText(text);

// `world` serves the production build and the real API over a seeded database on the page; a test that does not name it would
// otherwise get no server at all.
test.beforeEach(async ({ world }) => {
  void world;
});

/** How many merged PRs the database holds for a repo: what "retained" and "no duplicates" are measured against. */
function storedPrs(db: Db, repoId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM pull_request WHERE repo_id = ?')
    .get(repoId) as { n: number };
  return row.n;
}

function trackingState(db: Db, repoId: string): string | undefined {
  const row = db.prepare('SELECT tracking_state AS s FROM repo WHERE id = ?').get(repoId) as
    { s: string } | undefined;
  return row?.s;
}

/** The left edge of an element: used to say which of two buttons is on the left. */
async function leftOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('the element has no box, so it is not on screen');
  return box.x;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Tracked repositories
// ---------------------------------------------------------------------------------------------------------------------------

// D7 lists GitHub first in the Accounts card, then ChatGPT and Claude, in one card with one title. GitHub is still its own region (named
// GitHub, with its row's name as the heading that the "set up GitHub" link sends focus to), but it is not a card of its own.
test.describe('GitHub is the first row of the Accounts card', () => {
  test.beforeEach(async ({ world }) => {
    void world;
  });

  for (const width of [1280, 390, 320]) {
    test(`${width}px: Accounts lists GitHub, ChatGPT and Claude, and GitHub has no card of its own`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${ORIGIN}/sources`);
      const accounts = page.getByRole('region', { name: 'Accounts', exact: true });
      await expect(accounts).toBeVisible();
      const rows = accounts.locator(':scope > ul > li');
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0)).toContainText('GitHub');
      await expect(rows.nth(1)).toContainText('ChatGPT');
      await expect(rows.nth(2)).toContainText('Claude');
      // The GitHub region is inside the Accounts card, its name is a level-3 heading, and no level-2 heading says GitHub.
      await expect(accounts.getByRole('region', { name: 'GitHub', exact: true })).toHaveCount(1);
      await expect(
        page.getByRole('heading', { level: 3, name: 'GitHub', exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('heading', { level: 2, name: 'GitHub' })).toHaveCount(0);
      // What the old card's subtitle said now leads the row, as the other rows' descriptions do.
      await expect(rows.nth(0)).toContainText(
        'Needed for merged PR history and private repo access',
      );
    });
  }
});

// "Data kept on this machine" (D7; requirements P-29 to P-31) appears before the reset section. It states how long usage history is
// kept, what is never stored and which reads leave the machine, so it is held to the retention rule it describes.
test.describe('Data kept on this machine', () => {
  test.beforeEach(async ({ world }) => {
    void world;
  });

  for (const width of [1280, 390, 320]) {
    test(`${width}px: the data retention card describes what is kept and precedes reset`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${ORIGIN}/sources`);
      const card = page.getByRole('region', { name: 'Data kept on this machine' });
      await expect(card).toBeVisible();
      await expect(card).toContainText('Stored on this computer only');
      await expect(card).toContainText('kept for 12 months on this machine');
      await expect(card).toContainText(
        'HQ keeps raw prompts, responses, tool output and credentials out of dashboard history.',
      );
      await expect(card).toContainText(
        'sends selected session excerpts and pull request metadata to OpenAI for cloud processing.',
      );
      await expect(card).toContainText(
        'saves the generated notes, reviews and evidence links on this machine and protects the Work Review credentials in macOS Keychain.',
      );
      // The reset section follows the two sections it affects.
      const titles = await page
        .locator('main section[aria-labelledby] h2')
        .evaluateAll((all) => all.map((h) => h.textContent?.trim()));
      expect(titles.slice(-3)).toEqual([
        'Tracked repositories',
        'Data kept on this machine',
        'Reset Agent Productivity HQ',
      ]);
    });
  }

  // "12 months" is the card's wording for the retention horizon; if the horizon moves, the sentence has to be looked at.
  test('"12 months" is the retention horizon the importer keeps', () => {
    expect(RETENTION_DAYS).toBeGreaterThanOrEqual(365);
    expect(RETENTION_DAYS).toBeLessThanOrEqual(366);
  });
});

for (const width of [1280, 320]) {
  test(`${width}px: repository dropdown scrolls without expanding the card and restores focus @responsive @a11y`, async ({
    page,
    world,
  }) => {
    for (let i = 0; i < 30; i += 1) {
      world.github.addRepo({
        fullName: `team/repository-with-a-long-unbroken-name-${i}`,
        nodeId: `dropdown-${i}`,
        pushedAt: new Date(FIXED_NOW).toISOString(),
      });
    }
    await page.setViewportSize({ width, height: 700 });
    await page.goto(`${ORIGIN}/sources`);
    const card = reposSection(page);
    await expect(repoRow(page, 'kelvin/notes-cli')).toBeVisible();
    const before = (await card.boundingBox())!.height;
    const trigger = pickerTrigger(page);
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dropdown = repoPicker(page);
    const search = dropdown.getByRole('searchbox', { name: 'Find a repository' });
    await expect(search).toBeFocused();
    const results = dropdown.getByRole('region', { name: 'Recently pushed repositories' });
    await expect(results.getByRole('listitem')).toHaveCount(30);
    expect((await card.boundingBox())!.height).toBeCloseTo(before);
    const box = (await dropdown.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(701);
    await results.focus();
    await page.keyboard.press('PageDown');
    await expect.poll(() => results.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await expect(dropdown).toBeHidden();
    await expect(trigger).toBeFocused();
  });
}

test.describe('adding a repository', () => {
  test('searches later GitHub pages, ranks an exact name first, and retries only the failed row', async ({
    page,
    world,
  }) => {
    const pushedAt = new Date(FIXED_NOW).toISOString();
    for (let i = 0; i < 32; i += 1) {
      world.github.addRepo({
        fullName: `team/telescope-${i}`,
        nodeId: `first-page-${i}`,
        pushedAt,
      });
    }
    world.github.addRepo({ fullName: 'Team/Telescope', nodeId: 'exact-later-page' });
    await page.goto(`${ORIGIN}/sources`);
    await expect(addField(page)).toHaveCount(0);
    await openPicker(page);
    const initial = page
      .getByRole('region', { name: 'Recently pushed repositories' })
      .getByRole('list');
    await expect(initial.getByRole('listitem')).toHaveCount(30);
    expect(world.github.requests.filter((request) => request.path === '/user/repos')).toHaveLength(
      1,
    );

    await addField(page).fill('TELESCOPE');
    const matches = page.getByRole('region', { name: 'Matching repositories' }).getByRole('list');
    const first = matches.getByRole('listitem').first();
    await expect(first.getByText('Team/Telescope', { exact: true })).toBeVisible();
    await expect(first.getByText('public', { exact: true })).toBeVisible();
    expect(trackingState(world.db, 'team/telescope')).toBeUndefined();
    expect(world.github.requests.filter((request) => request.path === '/user/repos')).toHaveLength(
      2,
    );

    world.github.failNext({
      status: 500,
      match: (request) => request.path.toLowerCase() === '/repos/team/telescope',
    });
    const track = first.getByRole('button', { name: 'Track Team/Telescope', exact: true });
    await track.click();
    await expect(first.getByRole('alert')).toBeVisible();
    await expect(
      matches.getByRole('button', { name: 'Track team/telescope-0', exact: true }),
    ).toBeEnabled();
    await track.click();
    await expect(
      first.getByRole('button', { name: 'Tracking Team/Telescope', exact: true }),
    ).toBeVisible();
    await expect(first.getByRole('alert')).toHaveCount(0);
    await expect(addField(page)).toHaveValue('TELESCOPE');
    expect(trackingState(world.db, 'team/telescope')).toBe('active');
  });

  test('pressing Enter tracks a direct GitHub address when discovery has no matching row', async ({
    page,
    world,
  }) => {
    await page.goto(`${ORIGIN}/sources`);
    await expect(repoRow(page, 'kelvin/atlas-api')).toBeVisible();
    await expect(repoRow(page, 'kelvin/dotfiles')).toHaveCount(0);

    world.github.failNext({
      status: 200,
      body: [],
      match: (request) => request.path === '/user/repos',
    });
    await openPicker(page);
    await expect(repoPicker(page).getByText('GitHub returned no repositories.')).toBeVisible();
    await addField(page).fill('https://github.com/Kelvin/dotfiles/pulls');
    await expect(trackButton(page, 'Track Kelvin/dotfiles directly')).toBeVisible();
    await addField(page).press('Enter');

    await expect(toastWith(page, 'Tracking kelvin/dotfiles · importing merged PRs')).toBeVisible();
    const row = repoRow(page, 'kelvin/dotfiles');
    await expect(row).toBeVisible();
    await expect(tagOf(row, 'Collecting')).toBeVisible();
    await expect(addField(page)).toHaveValue('https://github.com/Kelvin/dotfiles/pulls');
    expect(trackingState(world.db, 'kelvin/dotfiles')).toBe('active');

    // The first read of merged PRs runs in the background; the row follows it without a reload.
    await world.githubIdle();
    await expect(row.getByText('3 merged PRs in the last 12 months')).toBeVisible({
      timeout: 15_000,
    });
    expect(storedPrs(world.db, 'kelvin/dotfiles')).toBe(3);
  });

  test('searching and pressing Enter leaves tracking to the explicit row action', async ({
    page,
    world,
  }) => {
    await page.goto(`${ORIGIN}/sources`);
    await openPicker(page);
    await addField(page).fill('kelvin/dotfiles');
    await expect(trackButton(page, 'Track kelvin/dotfiles')).toBeVisible();
    await addField(page).press('Enter');
    expect(trackingState(world.db, 'kelvin/dotfiles')).toBeUndefined();
    await trackButton(page, 'Track kelvin/dotfiles').click();
    await expect(repoRow(page, 'kelvin/dotfiles')).toBeVisible();
    await world.githubIdle();
  });

  test('keeps what was typed and says why when the repo cannot be read', async ({
    page,
    world,
  }) => {
    await page.goto(`${ORIGIN}/sources`);
    await openPicker(page);
    await addField(page).fill('kelvin/no-such-repo');
    await trackButton(page, 'Track kelvin/no-such-repo directly').click();

    const alert = repoPicker(page).getByRole('alert');
    await expect(alert).toContainText(
      'GitHub didn’t grant access to kelvin/no-such-repo. Check the name, or that your GitHub connection can read this repository, then try again.',
    );
    // P-16: the input stays, is marked invalid, is described by the error and has the focus; nothing was stored.
    await expect(addField(page)).toHaveValue('kelvin/no-such-repo');
    await expect(addField(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(addField(page)).toBeFocused();
    await expect(addField(page)).toHaveAccessibleDescription(/GitHub didn’t grant access/);
    await expect(repoRow(page, 'kelvin/no-such-repo')).toHaveCount(0);
    expect(trackingState(world.db, 'kelvin/no-such-repo')).toBeUndefined();

    // A second attempt starts from what is there; fixing the name and adding again works and clears the error.
    await addField(page).fill('kelvin/dotfiles');
    await trackButton(page, 'Track kelvin/dotfiles').click();
    await expect(repoRow(page, 'kelvin/dotfiles')).toBeVisible();
    await expect(repoPicker(page).getByRole('alert')).toHaveCount(0);
    await world.githubIdle();
  });

  // M6_AUTH_RATE_LIMIT (G6_7): GitHub's secondary limit can reach the sign-in check as a bare 403 that says so only in words (no
  // retry-after, quota left). The form says when to try again, as it does for any other limit, keeps what was typed, and a later
  // attempt works. Clock: 9:42 AM, and GitHub gave no time, so the app's default minute.
  test('says when GitHub is limiting requests when a bare 403 on the sign-in check is the only sign, and keeps what was typed', async ({
    page,
    world,
  }) => {
    await page.goto(`${ORIGIN}/sources`);
    await expect(reposSection(page)).toBeVisible();
    await openPicker(page);
    await expect(trackButton(page, 'Track kelvin/dotfiles')).toBeVisible();
    world.github.failNext({
      status: 403,
      headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999' },
      body: {
        message:
          'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
      },
      match: (r) => r.path === '/user',
    });
    await addField(page).fill('kelvin/dotfiles');
    await trackButton(page, 'Track kelvin/dotfiles').click();

    const alert = repoPicker(page).getByRole('alert');
    await expect(alert).toContainText('GitHub is limiting requests until 9:43 AM. Try again then.');
    await expect(alert).not.toContainText(/couldn’t be reached|Reconnect/);
    await expect(addField(page)).toHaveValue('kelvin/dotfiles');
    await expect(trackButton(page, 'Track kelvin/dotfiles')).toBeVisible();
    await expect(repoRow(page, 'kelvin/dotfiles')).toHaveCount(0);
    expect(trackingState(world.db, 'kelvin/dotfiles')).toBeUndefined();

    // the limit passes and the same row can be retried
    await trackButton(page, 'Track kelvin/dotfiles').click();
    await expect(repoRow(page, 'kelvin/dotfiles')).toBeVisible();
    await expect(repoPicker(page).getByRole('alert')).toHaveCount(0);
    await world.githubIdle();
  });

  test('keeps a malformed address and shows an already tracked repository as Tracking', async ({
    page,
  }) => {
    await page.goto(`${ORIGIN}/sources`);
    await openPicker(page);
    await expect(trackButton(page, 'Tracking kelvin/atlas-api')).toBeVisible();

    await addField(page).fill('kelvin/not a repository');
    await trackButton(page, 'Track by name or URL').click();
    await expect(repoPicker(page).getByRole('alert')).toContainText(
      'That doesn’t look like a GitHub repository. Use owner/name, for example kelvin/atlas-api.',
    );
    await expect(addField(page)).toHaveValue('kelvin/not a repository');

    await addField(page).fill('KELVIN/ATLAS-API');
    await expect(trackButton(page, 'Tracking kelvin/atlas-api')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(trackButton(page, 'Track KELVIN/ATLAS-API directly')).toHaveCount(0);
    await expect(repoRow(page, 'kelvin/atlas-api')).toHaveCount(1);
  });

  test('says the GitHub App is not installed on the owner, with the page to install it', async ({
    page,
    world,
  }) => {
    // Connected through the App (not `gh`): a user token sees a repo only where the App is installed, so a 404 means "install it".
    await page.goto(`${ORIGIN}/sources`);
    world.github.signOutGh();
    world.github.validClientId = 'Iv1.scripted';
    world.github.device = { interval: 5, pendingPolls: 0, outcome: 'approve' };
    world.setNow(FIXED_NOW + 11_000);
    await page.reload();
    await clientIdField(page).fill('Iv1.scripted');
    await githubSection(page).getByRole('button', { name: 'Save' }).click();
    await githubSection(page).getByRole('button', { name: 'Connect GitHub' }).click();
    await world.stepDeviceFlow();
    await expect(tagOf(githubSection(page), 'Connected')).toBeVisible();

    await openPicker(page);
    await addField(page).fill('kelvin/dotfiles');
    await trackButton(page, 'Track kelvin/dotfiles directly').click();
    await expect(repoPicker(page).getByRole('alert')).toContainText(
      'Install your Agent Productivity HQ GitHub App on kelvin and give it this repository, then check again.',
    );
    const install = repoPicker(page).getByRole('link', {
      name: 'Open your GitHub App installations',
    });
    await expect(install).toHaveAttribute('href', 'https://github.com/settings/installations');
    await expect(install).toHaveAttribute('target', '_blank');
    await expect(addField(page)).toHaveValue('kelvin/dotfiles');
  });
});

test.describe('a repository GitHub no longer grants', () => {
  test('shows Inaccessible with the reason, and Check again finds it readable once access is back', async ({
    page,
    world,
  }) => {
    await page.goto(`${ORIGIN}/sources`);
    const row = repoRow(page, 'kelvin/archive-private');
    await expect(tagOf(row, 'Inaccessible')).toBeVisible();
    await expect(row).toContainText(
      'GitHub no longer grants your connection access to this repository. Its earlier history is kept.',
    );

    await row.getByRole('button', { name: /^Check again/ }).click();
    await expect(
      toastWith(
        page,
        'Still no access to kelvin/archive-private. Its retained history stays readable.',
      ),
    ).toBeVisible();
    await expect(tagOf(row, 'Inaccessible')).toBeVisible();

    // Access comes back (the owner fixes it on GitHub): Check again reads the repo and the row says so.
    const archive = getRepo(world.db, 'kelvin/archive-private');
    expect(archive?.nodeId).toBeTruthy();
    world.github.addRepo({ fullName: 'kelvin/archive-private', nodeId: archive!.nodeId! });
    await row.getByRole('button', { name: /^Check again/ }).click();
    await expect(
      toastWith(page, 'kelvin/archive-private is readable again · importing merged PRs.'),
    ).toBeVisible();
    await expect(tagOf(row, 'Collecting')).toBeVisible();
    await expect(row.getByRole('button', { name: /^Check again/ })).toHaveCount(0);
    await world.githubIdle();
  });
});

test.describe('stop tracking', () => {
  test('asks first in a panel inside the row, with Cancel on the left and Stop tracking on the right', async ({
    page,
    world,
  }) => {
    await page.goto(`${ORIGIN}/sources`);
    const row = repoRow(page, 'kelvin/notes-cli');
    await row.getByRole('button', { name: 'Stop tracking kelvin/notes-cli' }).click();

    const panel = row.getByRole('group', { name: 'Confirm stop tracking kelvin/notes-cli' });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Stop tracking kelvin/notes-cli?');
    await expect(panel).toContainText(
      'Collection stops and it leaves the overview. Imported history stays on this machine for 12 months, so tracking it again restores it.',
    );
    // Nothing happened yet; focus is on the safe answer.
    expect(trackingState(world.db, 'kelvin/notes-cli')).toBe('active');
    const cancel = panel.getByRole('button', { name: 'Cancel' });
    const stop = panel.getByRole('button', { name: 'Stop tracking' });
    await expect(cancel).toBeFocused();
    expect(await leftOf(cancel)).toBeLessThan(await leftOf(stop));
    // The keyboard order is the visual order.
    await page.keyboard.press('Tab');
    await expect(stop).toBeFocused();
  });

  test('Cancel and Escape close the panel and put focus back on the row’s button', async ({
    page,
    world,
  }) => {
    await page.goto(`${ORIGIN}/sources`);
    const row = repoRow(page, 'kelvin/notes-cli');
    const opener = row.getByRole('button', { name: 'Stop tracking kelvin/notes-cli' });
    const panel = row.getByRole('group', { name: 'Confirm stop tracking kelvin/notes-cli' });

    await opener.click();
    await panel.getByRole('button', { name: 'Cancel' }).click();
    await expect(panel).toHaveCount(0);
    await expect(opener).toBeFocused();

    await opener.click();
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(trackingState(world.db, 'kelvin/notes-cli')).toBe('active');
  });

  test('stops tracking, keeps the history under Previously tracked, and Track again restores it without duplicates', async ({
    page,
    world,
  }) => {
    await page.goto(`${ORIGIN}/sources`);
    const row = repoRow(page, 'kelvin/notes-cli');
    const merged = (await row.innerText()).match(/(\d+) merged PRs? in the last 12 months/);
    expect(merged).not.toBeNull();
    const before = storedPrs(world.db, 'kelvin/notes-cli');
    expect(before).toBeGreaterThan(0);

    await row.getByRole('button', { name: 'Stop tracking kelvin/notes-cli' }).click();
    await row
      .getByRole('group', { name: 'Confirm stop tracking kelvin/notes-cli' })
      .getByRole('button', { name: 'Stop tracking' })
      .click();

    await expect(
      toastWith(page, 'Stopped tracking kelvin/notes-cli. History kept on this machine.'),
    ).toBeVisible();
    expect(trackingState(world.db, 'kelvin/notes-cli')).toBe('stopped');
    // The history stays on this machine.
    expect(storedPrs(world.db, 'kelvin/notes-cli')).toBe(before);
    // The row left the list; the next thing to do is usually another add, so focus is on the field.
    await expect(
      reposSection(page).getByRole('list').first().getByText('kelvin/notes-cli'),
    ).toHaveCount(0);
    await expect(pickerTrigger(page)).toBeFocused();

    const stopped = reposSection(page).getByRole('list').last().getByRole('listitem');
    await expect(
      reposSection(page).getByRole('heading', { name: 'Previously tracked' }),
    ).toBeVisible();
    await expect(
      reposSection(page).getByText('History is kept on this machine within the 12-month window.'),
    ).toBeVisible();
    await expect(stopped).toContainText('kelvin/notes-cli');
    await expect(tagOf(stopped, 'Not tracked')).toBeVisible();
    await expect(stopped).toContainText(
      new RegExp(`${merged?.[1] ?? '0'} merged PRs? retained · stopped today, 9:42 AM`),
    );

    await stopped.getByRole('button', { name: 'Track again kelvin/notes-cli' }).click();
    await expect(
      toastWith(
        page,
        'Tracking kelvin/notes-cli again · retained history restored without duplicates.',
      ),
    ).toBeVisible();
    await expect(repoRow(page, 'kelvin/notes-cli')).toBeVisible();
    await expect(
      reposSection(page).getByRole('heading', { name: 'Previously tracked' }),
    ).toHaveCount(0);
    expect(trackingState(world.db, 'kelvin/notes-cli')).toBe('active');
    expect(storedPrs(world.db, 'kelvin/notes-cli')).toBe(before);
    await world.githubIdle();
  });

  test('the Stop tracking toast carries an Undo that tracks the repo again, with its history, once', async ({
    page,
    world,
  }) => {
    await page.goto(`${ORIGIN}/sources`);
    const row = repoRow(page, 'kelvin/notes-cli');
    const before = storedPrs(world.db, 'kelvin/notes-cli');
    await row.getByRole('button', { name: 'Stop tracking kelvin/notes-cli' }).click();
    await row.getByRole('button', { name: 'Stop tracking', exact: true }).click();
    const stopped = toastWith(
      page,
      'Stopped tracking kelvin/notes-cli. History kept on this machine.',
    );
    await expect(stopped).toBeVisible();
    expect(trackingState(world.db, 'kelvin/notes-cli')).toBe('stopped');

    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(
      toastWith(
        page,
        'Tracking kelvin/notes-cli again · retained history restored without duplicates.',
      ),
    ).toBeVisible();
    await expect(repoRow(page, 'kelvin/notes-cli')).toBeVisible();
    await expect(
      reposSection(page).getByRole('heading', { name: 'Previously tracked' }),
    ).toHaveCount(0);
    expect(trackingState(world.db, 'kelvin/notes-cli')).toBe('active');
    expect(storedPrs(world.db, 'kelvin/notes-cli')).toBe(before);
    await world.githubIdle();
  });

  test('an Undo that GitHub no longer allows says so and leaves the repo stopped', async ({
    page,
    world,
  }) => {
    await page.goto(`${ORIGIN}/sources`);
    const row = repoRow(page, 'kelvin/notes-cli');
    await row.getByRole('button', { name: 'Stop tracking kelvin/notes-cli' }).click();
    await row.getByRole('button', { name: 'Stop tracking', exact: true }).click();
    await expect(toastWith(page, 'Stopped tracking kelvin/notes-cli.')).toBeVisible();

    world.github.failNext({ status: 404, match: (r) => r.path.startsWith('/repos/') });
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(toastWith(page, 'Couldn’t track it again.')).toBeVisible();
    expect(trackingState(world.db, 'kelvin/notes-cli')).toBe('stopped');
    await expect(
      reposSection(page).getByRole('heading', { name: 'Previously tracked' }),
    ).toBeVisible();
  });

  test('typing the stopped repo into the add field brings it back too', async ({ page, world }) => {
    await page.goto(`${ORIGIN}/sources`);
    const row = repoRow(page, 'kelvin/notes-cli');
    await row.getByRole('button', { name: 'Stop tracking kelvin/notes-cli' }).click();
    await row.getByRole('button', { name: 'Stop tracking', exact: true }).click();
    await expect(toastWith(page, 'Stopped tracking kelvin/notes-cli.')).toBeVisible();

    await openPicker(page);
    await addField(page).fill('kelvin/notes-cli');
    await trackButton(page, 'Track again kelvin/notes-cli').click();
    await expect(
      toastWith(
        page,
        'Tracking kelvin/notes-cli again · retained history restored without duplicates.',
      ),
    ).toBeVisible();
    await expect(
      reposSection(page).getByRole('heading', { name: 'Previously tracked' }),
    ).toHaveCount(0);
    await world.githubIdle();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// The GitHub connection
// ---------------------------------------------------------------------------------------------------------------------------

test.describe('GitHub with `gh` signed in', () => {
  test('says which sign-in is in use, who it is, and has no client-ID field', async ({ page }) => {
    await page.goto(`${ORIGIN}/sources`);
    const github = githubSection(page);
    await expect(tagOf(github, 'Using your existing sign-in')).toBeVisible();
    await expect(github).toContainText('Using your GitHub CLI sign-in');
    await expect(github).toContainText('Identity: kelvin (used for “Authored by you”)');
    await expect(github).toContainText('Needed for merged PR history and private repo access');
    // The App setup is for the case where gh is not signed in: nothing of it is here.
    await expect(clientIdField(page)).toHaveCount(0);
    await expect(github.getByText('Register your GitHub App')).toHaveCount(0);
    await expect(github.getByRole('button', { name: 'Disconnect' })).toBeVisible();
    await expect(github.getByRole('button', { name: 'Connect GitHub' })).toHaveCount(0);
  });

  test('Disconnect stops reading gh, and Connect puts it back in use', async ({ page }) => {
    await page.goto(`${ORIGIN}/sources`);
    const github = githubSection(page);
    await github.getByRole('button', { name: 'Disconnect' }).click();
    await expect(
      toastWith(page, 'GitHub disconnected. Imported history stays on this machine.'),
    ).toBeVisible();
    await expect(tagOf(github, 'Setup needed')).toBeVisible();
    // Focus went to the button that replaced Disconnect, not to the top of the page.
    const connect = github.getByRole('button', { name: 'Connect GitHub' });
    await expect(connect).toBeFocused();

    await connect.click();
    await expect(toastWith(page, 'Using your existing GitHub sign-in.')).toBeVisible();
    await expect(tagOf(github, 'Using your existing sign-in')).toBeVisible();
  });

  test('shows the client-ID field once gh is no longer signed in', async ({ page, world }) => {
    await page.goto(`${ORIGIN}/sources`);
    await expect(tagOf(githubSection(page), 'Using your existing sign-in')).toBeVisible();
    await expect(clientIdField(page)).toHaveCount(0);

    // gh signs out behind the app's back; the card is cached for 10 seconds of the app's clock.
    world.github.signOutGh();
    world.setNow(FIXED_NOW + 11_000);
    await page.reload();
    await expect(tagOf(githubSection(page), 'Setup needed')).toBeVisible();
    await expect(clientIdField(page)).toBeVisible();
  });
});

test.describe('GitHub with gh signed out', () => {
  test.use({ worldOptions: { ghSignedIn: false } });

  test('shows the App registration guide and the client-ID field', async ({ page }) => {
    await page.goto(`${ORIGIN}/sources`);
    const github = githubSection(page);
    // Not connected, and why: there is no `gh` sign-in and no App yet. "Not connected" is for once a client ID is saved.
    await expect(tagOf(github, 'Setup needed')).toBeVisible();
    await expect(tagOf(github, 'Not connected')).toHaveCount(0);
    await expect(github).toContainText('Set up your GitHub App to connect');

    const guide = github.getByRole('list').filter({ hasText: 'Enable Device Flow.' });
    await expect(guide).toBeVisible();
    await expect(github).not.toContainText('Not yet designed');
    await expect(guide.getByRole('listitem')).toHaveCount(5);
    await expect(guide).toContainText('Tick Enable Device Flow.');
    // G6_10 (owner-approved amendment, X6_1): Pull requests and Metadata read are named as the minimum the app asks for, and the
    // step does not tell the owner that nothing else may be granted.
    const permissions = guide.getByRole('listitem').nth(2);
    await expect(permissions).toContainText('set Pull requests to Read-only');
    await expect(permissions).toContainText('Metadata: Read-only');
    await expect(permissions).toContainText('minimum');
    await expect(permissions).not.toContainText(/nothing else|only these|no other permission/i);
    await expect(guide.getByRole('link', { name: 'github.com/settings/apps/new' })).toHaveAttribute(
      'href',
      'https://github.com/settings/apps/new',
    );
    // A setting, not a secret: a plain text field, never a password field, and it says no secret is wanted.
    await expect(clientIdField(page)).toHaveAttribute('type', 'text');
    await expect(github).toContainText('Never paste a client secret here');
    await expect(github.getByRole('button', { name: 'Save' })).toBeVisible();
  });

  test('saves the client ID, keeps a wrong one in the field with the reason, and then offers Connect', async ({
    page,
  }) => {
    await page.goto(`${ORIGIN}/sources`);
    const github = githubSection(page);

    await github.getByRole('button', { name: 'Save' }).click();
    await expect(github.getByRole('alert')).toHaveText(
      'Paste the Client ID from your GitHub App’s settings page.',
    );

    await clientIdField(page).fill('not a client id!');
    await github.getByRole('button', { name: 'Save' }).click();
    await expect(github.getByRole('alert')).toContainText('That doesn’t look like a client ID.');
    await expect(clientIdField(page)).toHaveValue('not a client id!');
    await expect(clientIdField(page)).toHaveAttribute('aria-invalid', 'true');

    await clientIdField(page).fill('Iv1.0123456789abcdef');
    await github.getByRole('button', { name: 'Save' }).click();
    await expect(tagOf(github, 'Client ID saved')).toBeVisible();
    await expect(tagOf(github, 'Not connected')).toBeVisible();
    await expect(tagOf(github, 'Setup needed')).toHaveCount(0);
    await expect(github.getByRole('button', { name: 'Connect GitHub' })).toBeVisible();
    // The field is still there (and still has focus) so a wrong ID can be replaced; the steps fold away.
    await expect(clientIdField(page)).toHaveValue('');
    await expect(github.getByRole('button', { name: 'Save' })).toBeFocused();
    await expect(github.getByText('Tick Enable Device Flow.')).toBeHidden();
    // The ID is stored by the server as a setting; the page never shows it back.
    await expect(github).not.toContainText('Iv1.0123456789abcdef');
  });

  test('adding a repo before GitHub is set up says so and points to the setup steps', async ({
    page,
  }) => {
    await page.goto(`${ORIGIN}/sources`);
    await openPicker(page);
    await addField(page).fill('kelvin/dotfiles');
    await trackButton(page, 'Add repository').click();
    const alert = repoPicker(page).getByRole('alert');
    await expect(alert).toContainText('Set up your GitHub App to connect GitHub.');
    await expect(addField(page)).toHaveValue('kelvin/dotfiles');

    await alert.getByRole('button', { name: 'Open the GitHub setup steps' }).click();
    await expect(
      page.getByRole('heading', { level: 3, name: 'GitHub', exact: true }),
    ).toBeFocused();
  });

  // The design's .field-row has the button next to the field and, when the row wraps on a phone, under it at the left. The product
  // pushed it to the right edge there (`ml-auto`).
  for (const [width, under] of [
    [1280, false],
    [390, true],
    [320, true],
  ] as const) {
    test(`${width}px: Add repository is ${under ? 'under its field, at the left' : 'beside its field'}, as in the design`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${ORIGIN}/sources`);
      await openPicker(page);
      await expect(trackButton(page, 'Add repository')).toBeVisible();
      const field = (await addField(page).boundingBox())!;
      const add = (await trackButton(page, 'Add repository').boundingBox())!;
      if (under) {
        expect(add.y).toBeGreaterThanOrEqual(field.y + field.height - 1);
        expect(Math.abs(add.x - field.x)).toBeLessThanOrEqual(1);
      } else {
        expect(add.x).toBeGreaterThanOrEqual(field.x + field.width - 1);
        expect(Math.abs(add.y + add.height / 2 - (field.y + field.height / 2))).toBeLessThanOrEqual(
          field.height,
        );
      }
    });
  }

  test('at 320px the device-code link shows its whole label, wrapped, at least 44px tall', async ({
    page,
    world,
  }) => {
    world.github.device = { interval: 5, pendingPolls: 0, outcome: 'approve' };
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(`${ORIGIN}/sources`);
    const github = githubSection(page);
    await clientIdField(page).fill('Iv1.0123456789abcdef');
    await github.getByRole('button', { name: 'Save' }).click();
    await expect(tagOf(github, 'Client ID saved')).toBeVisible();
    await github.getByRole('button', { name: 'Connect GitHub' }).click();
    const open = github
      .getByRole('group', { name: 'Enter this code on GitHub' })
      .getByRole('link', { name: 'Open github.com/login/device' });
    await expect(open).toBeVisible();
    expect(await cutLabels(open)).toEqual([]);
    expect((await open.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  });

  test('signs in with a device code: the code in mono, Cancel on the left, Open github.com/login/device on the right', async ({
    page,
    world,
  }) => {
    world.github.device = { interval: 5, pendingPolls: 0, outcome: 'approve' };
    await page.goto(`${ORIGIN}/sources`);
    const github = githubSection(page);
    await clientIdField(page).fill('Iv1.0123456789abcdef');
    await github.getByRole('button', { name: 'Save' }).click();
    await expect(tagOf(github, 'Client ID saved')).toBeVisible();
    await github.getByRole('button', { name: 'Connect GitHub' }).click();

    const panel = github.getByRole('group', { name: 'Enter this code on GitHub' });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Enter this code on GitHub' })).toBeFocused();
    const code = panel.locator('code');
    await expect(code).toHaveText('WXYZ-0000');
    expect(await code.evaluate((element) => getComputedStyle(element).fontFamily)).toMatch(
      /mono|menlo|consolas|courier/i,
    );
    const open = panel.getByRole('link', { name: 'Open github.com/login/device' });
    await expect(open).toHaveAttribute('href', 'https://github.com/login/device');
    await expect(open).toHaveAttribute('target', '_blank');
    expect(await leftOf(panel.getByRole('button', { name: 'Cancel' }))).toBeLessThan(
      await leftOf(open),
    );
    await expect(panel).toContainText('Waiting for you to enter the code on GitHub…');
    await expect(panel).toContainText('The code expires today, 9:57 AM.');
    await expect(tagOf(github, 'Waiting for sign-in…')).toBeVisible();
    // While a code is on screen the setup is out of the way and Connect is not offered a second time.
    await expect(clientIdField(page)).toHaveCount(0);
    await expect(github.getByRole('button', { name: 'Connect GitHub' })).toHaveCount(0);

    // The owner enters the code on github.com; the server's next poll gets the token, stores it in the Keychain and says so.
    await world.stepDeviceFlow();
    await expect(toastWith(page, 'GitHub connected as kelvin.')).toBeVisible();
    await expect(tagOf(github, 'Connected')).toBeVisible();
    await expect(github).toContainText('Connected through your Agent Productivity HQ GitHub App');
    await expect(github).toContainText('Identity: kelvin');
    await expect(panel).toHaveCount(0);
    await expect(github.getByRole('button', { name: 'Disconnect' })).toBeVisible();
    await expect(clientIdField(page)).toHaveCount(0);

    // The token is in the Keychain and nowhere else: not in the page, which only ever heard "connected".
    expect(world.keyring.snapshot()).toHaveLength(1);
    const html = await page.content();
    for (const token of world.github.tokens) expect(html).not.toContain(token);
    expect(world.logs.join('\n')).toBe('');

    // Now a repo can be added through the App route, when the App is installed on its owner.
    world.github.installApp('kelvin');
    await openPicker(page);
    await addField(page).fill('kelvin/dotfiles');
    await trackButton(page, 'Track kelvin/dotfiles').click();
    await expect(repoRow(page, 'kelvin/dotfiles')).toBeVisible();
    await world.githubIdle();
  });

  test('Cancel stops the sign-in on the server and puts focus back on Connect GitHub', async ({
    page,
  }) => {
    await page.goto(`${ORIGIN}/sources`);
    const github = githubSection(page);
    await clientIdField(page).fill('Iv1.0123456789abcdef');
    await github.getByRole('button', { name: 'Save' }).click();
    const started = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/accounts/github/connect') &&
        response.request().method() === 'POST',
    );
    await github.getByRole('button', { name: 'Connect GitHub' }).click();
    const { loginId } = (await (await started).json()) as { loginId: string };
    const panel = github.getByRole('group', { name: 'Enter this code on GitHub' });
    await expect(panel).toBeVisible();

    await panel.getByRole('button', { name: 'Cancel' }).click();
    await expect(panel).toHaveCount(0);
    await expect(tagOf(github, 'Not connected')).toBeVisible();
    await expect(github.getByRole('button', { name: 'Connect GitHub' })).toBeFocused();
    // The server says the sign-in was cancelled, not that it is still waiting.
    const poll = await page.evaluate(
      async (id) =>
        (await (await fetch(`/api/accounts/github/connect/${id}`)).json()) as { state: string },
      loginId,
    );
    expect(poll.state).toBe('cancelled');
  });

  test('a wrong client ID is explained, and the field is there to fix it', async ({
    page,
    world,
  }) => {
    world.github.validClientId = 'Iv1.theRightOne';
    await page.goto(`${ORIGIN}/sources`);
    const github = githubSection(page);
    await clientIdField(page).fill('Iv1.theWrongOne');
    await github.getByRole('button', { name: 'Save' }).click();
    await github.getByRole('button', { name: 'Connect GitHub' }).click();
    await expect(github.getByRole('alert')).toContainText(
      'GitHub doesn’t recognise this client ID.',
    );
    await expect(github.getByRole('group', { name: 'Enter this code on GitHub' })).toHaveCount(0);

    // Fixing the ID and connecting again works.
    world.github.device = { interval: 5, pendingPolls: 0, outcome: 'approve' };
    await clientIdField(page).fill('Iv1.theRightOne');
    await github.getByRole('button', { name: 'Save' }).click();
    await github.getByRole('button', { name: 'Connect GitHub' }).click();
    await expect(github.getByRole('group', { name: 'Enter this code on GitHub' })).toBeVisible();
    await expect(github.getByRole('alert')).toHaveCount(0);
    await world.stepDeviceFlow();
    await expect(tagOf(github, 'Connected')).toBeVisible();
  });

  test('a sign-in the owner refuses on GitHub ends with the reason and a way to start again', async ({
    page,
    world,
  }) => {
    world.github.device = { interval: 5, pendingPolls: 0, outcome: 'deny' };
    await page.goto(`${ORIGIN}/sources`);
    const github = githubSection(page);
    await clientIdField(page).fill('Iv1.0123456789abcdef');
    await github.getByRole('button', { name: 'Save' }).click();
    await github.getByRole('button', { name: 'Connect GitHub' }).click();
    await expect(github.getByRole('group', { name: 'Enter this code on GitHub' })).toBeVisible();

    await world.stepDeviceFlow();
    await expect(github.getByRole('alert')).toHaveText('Sign-in was cancelled');
    await expect(github.getByRole('group', { name: 'Enter this code on GitHub' })).toHaveCount(0);
    await expect(tagOf(github, 'Not connected')).toBeVisible();
    await expect(github.getByRole('button', { name: 'Connect GitHub' })).toBeVisible();
    expect(world.keyring.snapshot()).toHaveLength(0);
  });

  test('after a reload mid-sign-in, says the code is no longer on this page and offers Cancel or a new code', async ({
    page,
    world,
  }) => {
    await page.goto(`${ORIGIN}/sources`);
    const github = githubSection(page);
    await clientIdField(page).fill('Iv1.0123456789abcdef');
    await github.getByRole('button', { name: 'Save' }).click();
    await github.getByRole('button', { name: 'Connect GitHub' }).click();
    await expect(github.getByRole('group', { name: 'Enter this code on GitHub' })).toBeVisible();

    await page.reload();
    const lost = github.getByRole('group', { name: 'Waiting for sign-in…' });
    await expect(lost).toContainText('this page no longer has its code');
    expect(await leftOf(lost.getByRole('button', { name: 'Cancel' }))).toBeLessThan(
      await leftOf(lost.getByRole('button', { name: 'Start again' })),
    );

    // Start again asks GitHub for a new code (the server drops the old sign-in) and the panel is back.
    world.github.device = { interval: 5, pendingPolls: 0, outcome: 'approve' };
    await lost.getByRole('button', { name: 'Start again' }).click();
    await expect(github.getByRole('group', { name: 'Enter this code on GitHub' })).toBeVisible();
    // The sign-in that Start again cancelled has left the queue, so this lets the new one's poll go.
    await world.stepDeviceFlow();
    await expect(tagOf(github, 'Connected')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Layout and accessibility, with the busiest states open
// ---------------------------------------------------------------------------------------------------------------------------

for (const width of [1280, 390, 320]) {
  test.describe(`at ${width}px`, () => {
    test(`repository dropdown errors and the Stop tracking panel fit with no axe violation @a11y`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${ORIGIN}/sources`);
      await expect(repoRow(page, 'kelvin/archive-private')).toBeVisible();
      await openPicker(page);
      await addField(page).fill(
        'kelvin/no-such-repo-with-a-rather-long-name-that-has-no-breakpoints',
      );
      await trackButton(
        page,
        'Track kelvin/no-such-repo-with-a-rather-long-name-that-has-no-breakpoints directly',
      ).click();
      await expect(repoPicker(page).getByRole('alert')).toBeVisible();
      expect(failures(await measureContainment(page))).toEqual([]);
      expect(
        (await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations,
      ).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(repoPicker(page)).toBeHidden();
      await repoRow(page, 'kelvin/notes-cli')
        .getByRole('button', { name: 'Stop tracking kelvin/notes-cli' })
        .click();
      await expect(
        page.getByRole('group', { name: 'Confirm stop tracking kelvin/notes-cli' }),
      ).toBeVisible();

      expect(failures(await measureContainment(page))).toEqual([]);
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(
        violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
      ).toEqual([]);
    });
  });
}

test.describe('the App setup and the device code, at every width', () => {
  test.use({ worldOptions: { ghSignedIn: false } });

  for (const width of [1280, 390, 320]) {
    test(`have no layout FAIL and no axe violation at ${width}px @a11y`, async ({
      page,
      world,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${ORIGIN}/sources`);
      const github = githubSection(page);
      await expect(github.getByText('Tick Enable Device Flow.')).toBeVisible();
      expect(failures(await measureContainment(page))).toEqual([]);
      let { violations } = await new AxeBuilder({ page }).analyze();
      expect(
        violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
      ).toEqual([]);

      world.github.device = { interval: 5, pendingPolls: 0, outcome: 'approve' };
      await clientIdField(page).fill('Iv1.0123456789abcdef');
      await github.getByRole('button', { name: 'Save' }).click();
      await github.getByRole('button', { name: 'Connect GitHub' }).click();
      await expect(github.getByRole('group', { name: 'Enter this code on GitHub' })).toBeVisible();
      expect(failures(await measureContainment(page))).toEqual([]);
      ({ violations } = await new AxeBuilder({ page }).analyze());
      expect(
        violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
      ).toEqual([]);
    });
  }
});

// The GitHub sync reports through the same source row as the local sources (SourceStatus.id has `github`), so the failed-refresh
// banner and the issue count name it. It is not a source "on this machine", so that list never shows it.
test.describe('a failed GitHub sync', () => {
  test.beforeEach(async ({ world }) => {
    world.db
      .prepare(
        `INSERT OR REPLACE INTO source_state (source_id, status, location, oldest_event_at, last_success_at, last_attempt_at, last_attempt_result,
           consecutive_failures, error_code, error_detail, unreadable_count, unsupported_count, adapter_version, extra_json)
         VALUES ('github', 'failed', NULL, NULL, ?, ?, 'failed', 1, 'unreachable', 'GitHub couldn’t be reached. Try again in a moment.', 0, 0, 'github-graphql/1', NULL)`,
      )
      .run(FIXED_NOW - 15 * 3_600_000, FIXED_NOW - 2 * 60_000);
  });

  test('is named by the banner in merged-PR words, counted as an issue, and kept out of On this machine', async ({
    page,
  }) => {
    await page.goto(`${ORIGIN}/sources`);
    const banner = page.getByRole('status').filter({ hasText: 'Refresh failed.' });
    await expect(banner).toContainText('GitHub refresh failed');
    await expect(banner).toContainText('Merged PRs since then aren’t collected yet');
    await expect(banner).not.toContainText('GitHub usage');
    // the seeded world already has one issue (the repo GitHub no longer grants); the failed sync is the second
    const nav = page.getByRole('navigation', { name: 'Sections' });
    await expect(nav.getByRole('link', { name: /^Sources & repos\s*, 2 issues$/ })).toBeVisible();
    const local = page.getByRole('region', { name: 'On this machine', exact: true });
    await expect(local).toBeVisible();
    await expect(local.getByRole('listitem').filter({ hasText: 'GitHub' })).toHaveCount(0);
  });

  test('has its Retry in the banner, and a retry runs the GitHub sync alone', async ({
    page,
    world,
  }) => {
    await page.goto(`${ORIGIN}/sources`);
    const banner = page.getByRole('status').filter({ hasText: 'Refresh failed.' });
    // the world's own runner has no adapters, so the request is the only thing observed: it names GitHub alone
    const asked = page.waitForRequest(
      (request) => request.url().endsWith('/api/refresh') && request.method() === 'POST',
    );
    await banner.getByRole('button', { name: 'Retry' }).click();
    expect(JSON.parse((await asked).postData() ?? '{}')).toEqual({ sources: ['github'] });
    await world.githubIdle();
  });
});
