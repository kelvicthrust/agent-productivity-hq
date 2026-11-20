import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { upsertPullRequests } from '../../src/server/db/queries/prs.ts';
import { PrDetailResponse, PrsResponse } from '../../src/shared/contracts/prs.ts';
import { expect, test } from './fixtures';
import { failures, measureContainment } from './helpers/containment';
import { ORIGIN } from './helpers/virtualOrigin';
import { answerApi, openWorld, type World } from './helpers/world';

// Delivery's link evidence and the Usage tree's link badges (M8: A31; G8_6 and G8_7), in a real browser against the real API and
// the seeded world. Every number and every word the page should show is read from the same API, so the spec cannot agree with
// a page that is wrong in the same way.
//
// What is covered, from the assignment's goals:
//   - an opened PR lists its links: evidence, owner, suggested, then marked incorrect struck through, each with its basis text
//     and the actions the server allows (Confirm link, Dismiss, Mark incorrect, Restore, Remove link, Link a session)
//   - a keyboard-only journey through those actions, their toasts and their Undo, with focus back on the row toggle each time
//   - nothing is optimistic: a request that fails leaves the item as it was and says "Couldn’t save your change"
//   - every change has an Undo that sends the inverse request and puts the pair back (read from the API, not from the page)
//   - the badge text in the Usage tree equals Delivery's for the same link; a link marked incorrect is hidden in the Usage tree
//     and struck through in Delivery (the T5 interim choice, which Design may still change)
//   - containment, touch targets and axe with the panel open at 1280, 390 and 320px
//
// The seeded world's week (Mon Nov 2 to Sun Nov 8, fixed clock): 8 merged PRs, 4 Evidence, 1 Owner-confirmed, 1 Suggested only and
// 2 Unlinked. PR #311 has two evidence links and a suggestion, #315 one of each, #236 an owner link, #106 a suggestion only,
// and #316 nothing at all but eight sessions it could be linked to.

// ---- the API, for what the page should show and for changes made before it loads ----------------------------------------------

const JSON_HEADERS = { 'x-agent-productivity-request': '1', 'content-type': 'application/json' };

async function read(world: World, path: string): Promise<unknown> {
  const answer = await answerApi(world.app, { method: 'GET', path, headers: {} });
  return JSON.parse(answer.body.toString('utf8')) as unknown;
}

const prsOf = async (world: World) => PrsResponse.parse(await read(world, '/api/prs')).items ?? [];
const detailOf = async (world: World, prId: string) =>
  PrDetailResponse.parse(await read(world, `/api/prs/${encodeURIComponent(prId)}`));

/** The PR with this number in this repo, from the list the page shows. */
async function prOf(world: World, number: number) {
  const pr = (await prsOf(world)).find((candidate) => candidate.number === number);
  if (!pr) throw new Error(`the seeded week has no PR #${number}`);
  return pr;
}

/** An owner decision made before the page loads (the same request the page sends). */
async function decide(
  world: World,
  prId: string,
  sessionId: number,
  decision: 'confirmed' | 'rejected' | 'dismissed',
): Promise<void> {
  const answer = await answerApi(world.app, {
    method: 'PUT',
    path: `/api/prs/${encodeURIComponent(prId)}/links/${sessionId}`,
    headers: JSON_HEADERS,
    body: new TextEncoder().encode(JSON.stringify({ decision })),
  });
  expect(answer.status, `PUT ${decision} for session ${sessionId}`).toBe(200);
}

/** The state of one pair as the API holds it: the item's class, or null when the PR does not list the session. */
async function classOf(world: World, prId: string, sessionId: number): Promise<string | null> {
  const found = (await detailOf(world, prId)).evidence?.find(
    (item) => item.session.id === sessionId,
  );
  return found?.effectiveClass ?? null;
}

// ---- the page ---------------------------------------------------------------------------------------------------------------

async function openDelivery(page: Page, width: number, search = ''): Promise<World> {
  await page.setViewportSize({ width, height: 900 });
  const world = await openWorld(page);
  await page.goto(`${ORIGIN}/delivery${search}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Delivery' })).toBeVisible();
  return world;
}

/** The row toggle of a PR, whether it is a table row or a phone card. */
const toggleOf = (page: Page, pr: { id: string }) =>
  page.locator(`[data-pr-id="${pr.id}"] button[aria-expanded]`);
const panelOf = (page: Page, pr: { id: string }) => page.locator(`[id="pr-evidence-${pr.id}"]`);
const itemsOf = (panel: Locator) => panel.locator('li[data-evidence-session]');
const itemFor = (panel: Locator, sessionId: number) =>
  panel.locator(`li[data-evidence-session="${sessionId}"]`);

/** Opens a PR's evidence and waits for its items (or its words, when it has none). */
async function openPr(page: Page, pr: { id: string }): Promise<Locator> {
  const toggle = toggleOf(page, pr);
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  const panel = panelOf(page, pr);
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Loading link evidence…')).toHaveCount(0);
  return panel;
}

/** The badge words of an item or a cell: the one element that says the link's class. */
const BADGE = /^(Evidence link|Owner-confirmed|Suggested|Unlinked|Marked incorrect)$/;
const badgeOf = (within: Locator) => within.getByText(BADGE);

/** A toast, found in the visible notifications (Astryx repeats its words in a hidden live region for screen readers). */
const notifications = (page: Page) => page.getByRole('region', { name: 'Notifications' });
const toastWith = (page: Page, text: string) => notifications(page).getByText(text);
const undoButton = (page: Page) =>
  notifications(page).getByRole('button', { name: 'Undo', exact: true });

const SAVE_FAILED = 'Couldn’t save your change';

/** The words of each action, as the design has them. */
const ACTION_WORDS = {
  evidence: ['Mark incorrect'],
  suggested: ['Dismiss', 'Confirm link'],
  owner: ['Remove link'],
  rejected: ['Restore'],
} as const;
const LABEL = {
  evidence: 'Evidence link',
  owner: 'Owner-confirmed',
  suggested: 'Suggested',
  rejected: 'Marked incorrect',
} as const;

/** The visible text of the buttons of an item, left to right. */
const actionWords = (item: Locator) =>
  item
    .getByRole('button')
    .evaluateAll((buttons) => buttons.map((button) => (button.textContent ?? '').trim()));

/** Every link-writing request the page sends, as "PUT confirmed" or "DELETE", in order. */
function recordWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (!/\/api\/prs\/[^/]+\/links\/\d+$/.test(new URL(request.url()).pathname)) return;
    const body = request.postData();
    const decision = body ? (JSON.parse(body) as { decision?: string }).decision : undefined;
    writes.push(decision ? `${request.method()} ${decision}` : request.method());
  });
  return writes;
}

/** Makes every link write answer with a server error (once `gate` opens, when one is given), so nothing reaches the database. */
async function failWrites(page: Page, gate?: Promise<void>): Promise<void> {
  await page.route(`${ORIGIN}/api/prs/*/links/*`, async (route) => {
    if (route.request().method() === 'GET') return route.fallback();
    if (gate) await gate;
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'internal', message: 'Something went wrong.', retryable: false },
      }),
    });
  });
}

// ============================================================================================================================
// The evidence items
// ============================================================================================================================

test.describe('evidence items', () => {
  test('an opened PR lists its links strongest first, each with its basis and the actions the server allows', async ({
    page,
  }) => {
    const world = await openDelivery(page, 1280);
    const pr = await prOf(world, 311);
    const detail = await detailOf(world, pr.id);
    const panel = await openPr(page, pr);

    expect(detail.evidence!.map((item) => item.effectiveClass)).toEqual([
      'evidence',
      'evidence',
      'suggested',
    ]);
    const items = itemsOf(panel);
    await expect(items).toHaveCount(3);
    for (const [index, item] of detail.evidence!.entries()) {
      const row = items.nth(index);
      await expect(row).toHaveAttribute('data-evidence-session', String(item.session.id));
      await expect(badgeOf(row)).toHaveText(LABEL[item.effectiveClass]);
      await expect(row).toContainText(`Basis: ${item.basisText}`);
      await expect(row).toContainText(item.session.nameLead);
      await expect(row).toContainText(item.session.providerSessionRef);
      // "Started", the one word for a session's time, as everywhere else.
      await expect(row).toContainText(/Started [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M/);
      expect(await actionWords(row)).toEqual([...ACTION_WORDS[item.effectiveClass]]);
    }
    // The footnote says what a link is, once.
    await expect(
      panel.getByText(/^A linked session is recorded evidence of involvement, not proof/),
    ).toHaveCount(1);
    await expect(panel.getByRole('button', { name: 'Link a session' })).toBeVisible();
  });

  test('an owner link offers Remove link, a suggestion offers Dismiss and Confirm link with the primary on the right', async ({
    page,
  }) => {
    const world = await openDelivery(page, 1280);
    const owner = await prOf(world, 236);
    const suggested = await prOf(world, 106);

    const ownerPanel = await openPr(page, owner);
    const ownerItem = itemsOf(ownerPanel).first();
    await expect(badgeOf(ownerItem)).toHaveText('Owner-confirmed');
    expect(await actionWords(ownerItem)).toEqual(['Remove link']);

    const suggestedPanel = await openPr(page, suggested);
    const item = itemsOf(suggestedPanel).first();
    await expect(badgeOf(item)).toHaveText('Suggested');
    const dismiss = await item.getByRole('button', { name: /^Dismiss/ }).boundingBox();
    const confirm = await item.getByRole('button', { name: /^Confirm link/ }).boundingBox();
    expect(dismiss!.x).toBeLessThan(confirm!.x);
    // A suggestion is dashed, as the badge is.
    await expect(item).toHaveCSS('border-top-style', 'dashed');
    // This PR has no session to offer, so there is nothing to open.
    await expect(suggestedPanel.getByRole('button', { name: 'Link a session' })).toHaveCount(0);
  });

  test('a button’s name starts with its words and says which session it is for', async ({
    page,
  }) => {
    const world = await openDelivery(page, 1280);
    const pr = await prOf(world, 311);
    const detail = await detailOf(world, pr.id);
    const panel = await openPr(page, pr);
    const evidence = detail.evidence!.filter((item) => item.effectiveClass === 'evidence');
    expect(evidence).toHaveLength(2);
    // Two items, two buttons with the same words: the names tell them apart.
    const names = await panel
      .getByRole('button', { name: /^Mark incorrect/ })
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    for (const [index, item] of evidence.entries()) {
      expect(names[index]).toBe(
        `Mark incorrect: ${item.session.nameLead} (${item.session.providerSessionRef})`,
      );
    }
  });

  test('a PR with nothing linked says so, and offers the sessions it could be linked to', async ({
    page,
  }) => {
    const world = await openDelivery(page, 1280);
    const pr = await prOf(world, 316);
    const detail = await detailOf(world, pr.id);
    expect(detail.evidence).toEqual([]);
    expect(detail.candidates!.length).toBeGreaterThan(0);
    const panel = await openPr(page, pr);
    await expect(itemsOf(panel)).toHaveCount(0);
    await expect(
      panel.getByText('No session evidence found for this PR. You can link a session yourself.'),
    ).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Link a session' })).toBeVisible();
  });

  test('a PR somebody else wrote says so instead of suggesting you link it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const world = await openWorld(page);
    upsertPullRequests(world.db, [
      {
        nodeId: 'PR_kwDOtidy-the-docs',
        repoId: 'kelvin/atlas-api',
        number: 999,
        title: 'Tidy the contributor docs',
        url: 'https://github.com/kelvin/atlas-api/pull/999',
        authorLogin: 'priya-s',
        mergedByLogin: 'priya-s',
        mergedAt: Date.parse('2026-11-04T20:00:00Z'),
        headRef: null,
        baseRef: null,
        mergeCommitSha: null,
        commits: [],
        commitsComplete: true,
      },
    ]);
    await page.goto(`${ORIGIN}/delivery?author=all`);
    await expect(page.getByRole('heading', { level: 1, name: 'Delivery' })).toBeVisible();
    const panel = await openPr(page, { id: 'PR_kwDOtidy-the-docs' });
    await expect(
      panel.getByText('Authored by priya-s. No sessions from this machine are linked.'),
    ).toBeVisible();
  });

  test('evidence that cannot be loaded says so and Retry asks again', async ({ page }) => {
    const world = await openDelivery(page, 1280);
    const pr = await prOf(world, 311);
    let failed = false;
    await page.route(`${ORIGIN}/api/prs/${encodeURIComponent(pr.id)}`, async (route) => {
      if (failed) return route.fallback();
      failed = true;
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'internal', message: 'Something went wrong.', retryable: false },
        }),
      });
    });
    await toggleOf(page, pr).click();
    const panel = panelOf(page, pr);
    await expect(panel.getByRole('alert')).toHaveText(/Couldn’t load link evidence\./);
    await panel.getByRole('button', { name: 'Retry' }).click();
    await expect(itemsOf(panel)).toHaveCount(3);
  });
});

// ============================================================================================================================
// Changes, their toasts and their Undo
// ============================================================================================================================

interface Change {
  name: string;
  pr: number;
  /** The session to act on, chosen from what the API says; null for a session offered from the candidates. */
  pick: (detail: Awaited<ReturnType<typeof detailOf>>) => number;
  /** Before the page loads: put the pair in the state the action starts from. */
  before?: (world: World, prId: string, sessionId: number) => Promise<void>;
  button: RegExp | 'Link a session';
  toast: string;
  /** The pair after the change, and after its Undo. */
  after: string | null;
  undone: string | null;
  /** The requests the page sends: the change, then the inverse. */
  writes: [string, string];
}

const bySuggested = (detail: Awaited<ReturnType<typeof detailOf>>) =>
  detail.evidence!.find((item) => item.effectiveClass === 'suggested')!.session.id;
const byEvidence = (detail: Awaited<ReturnType<typeof detailOf>>) =>
  detail.evidence!.find((item) => item.effectiveClass === 'evidence')!.session.id;

const CHANGES: Change[] = [
  {
    name: 'Confirm link',
    pr: 311,
    pick: bySuggested,
    button: /^Confirm link/,
    toast: 'Link confirmed and labeled Owner-confirmed.',
    after: 'owner',
    undone: 'suggested',
    writes: ['PUT confirmed', 'DELETE'],
  },
  {
    name: 'Dismiss',
    pr: 311,
    pick: bySuggested,
    button: /^Dismiss/,
    toast: 'Suggestion dismissed.',
    after: null,
    undone: 'suggested',
    writes: ['PUT dismissed', 'DELETE'],
  },
  {
    name: 'Mark incorrect',
    pr: 311,
    pick: byEvidence,
    button: /^Mark incorrect/,
    toast: 'Marked incorrect. The source’s claim is kept but not counted.',
    after: 'rejected',
    undone: 'evidence',
    writes: ['PUT rejected', 'DELETE'],
  },
  {
    name: 'Restore',
    pr: 311,
    pick: byEvidence,
    before: (world, prId, sessionId) => decide(world, prId, sessionId, 'rejected'),
    button: /^Restore/,
    toast: 'Evidence link restored.',
    after: 'evidence',
    undone: 'rejected',
    writes: ['DELETE', 'PUT rejected'],
  },
  {
    name: 'Remove link',
    pr: 236,
    pick: (detail) => detail.evidence![0]!.session.id,
    button: /^Remove link/,
    toast: 'Your link was removed.',
    // The seeded owner link was a suggestion first: without the owner's say, the suggestion shows again.
    after: 'suggested',
    undone: 'owner',
    writes: ['DELETE', 'PUT confirmed'],
  },
  {
    name: 'Link a session',
    pr: 316,
    pick: (detail) => detail.candidates![1]!.id,
    button: 'Link a session',
    toast: 'Session linked and labeled Owner-confirmed.',
    after: 'owner',
    undone: null,
    writes: ['PUT confirmed', 'DELETE'],
  },
];

test.describe('changes and Undo', () => {
  for (const change of CHANGES) {
    test(`${change.name}: saves, says so with an Undo, and Undo puts the pair back`, async ({
      page,
    }) => {
      const probe = await openWorld(page);
      const pr = await prOf(probe, change.pr);
      const detail = await detailOf(probe, pr.id);
      const sessionId = change.pick(detail);
      if (change.before) await change.before(probe, pr.id, sessionId);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${ORIGIN}/delivery`);
      await expect(page.getByRole('heading', { level: 1, name: 'Delivery' })).toBeVisible();
      const writes = recordWrites(page);
      const panel = await openPr(page, pr);
      const start = await classOf(probe, pr.id, sessionId);

      if (change.button === 'Link a session') {
        await panel.getByRole('button', { name: change.button }).click();
        await panel.getByRole('combobox').selectOption(String(sessionId));
        await panel.getByRole('button', { name: 'Add link' }).click();
      } else {
        await itemFor(panel, sessionId).getByRole('button', { name: change.button }).click();
      }

      // The change is the server's, and the toast and the page show it.
      await expect(toastWith(page, change.toast)).toBeVisible();
      await expect(undoButton(page)).toBeVisible();
      await expect(toggleOf(page, pr)).toBeFocused();
      expect(await classOf(probe, pr.id, sessionId)).toBe(change.after);
      if (change.after === null) await expect(itemFor(panel, sessionId)).toHaveCount(0);
      else
        await expect(badgeOf(itemFor(panel, sessionId))).toHaveText(
          LABEL[change.after as keyof typeof LABEL],
        );

      // Undo sends the inverse request, and the pair is as it was.
      await undoButton(page).click();
      await expect(toastWith(page, 'Change undone.')).toBeVisible();
      await expect(toggleOf(page, pr)).toBeFocused();
      expect(writes).toEqual(change.writes);
      expect(await classOf(probe, pr.id, sessionId)).toBe(change.undone ?? start);
      if (change.undone === null) await expect(itemFor(panel, sessionId)).toHaveCount(0);
      else
        await expect(badgeOf(itemFor(panel, sessionId))).toHaveText(
          LABEL[change.undone as keyof typeof LABEL],
        );
    });
  }
});

test.describe('nothing is optimistic', () => {
  test('a change that fails leaves the item as it was, says so, and writes nothing', async ({
    page,
  }) => {
    const world = await openDelivery(page, 1280);
    const pr = await prOf(world, 311);
    const detail = await detailOf(world, pr.id);
    const sessionId = bySuggested(detail);
    const panel = await openPr(page, pr);
    const before = await toggleOf(page, pr).evaluate(
      (toggle) => toggle.closest('tr')?.textContent ?? '',
    );

    let release!: () => void;
    await failWrites(page, new Promise<void>((resolve) => (release = resolve)));
    const item = itemFor(panel, sessionId);
    const confirm = item.getByRole('button', { name: /^Confirm link/ });
    await confirm.click();

    // While the request is out nothing has changed: no Owner-confirmed badge, no toast, no new Remove link.
    await expect(confirm).toHaveAttribute('aria-busy', 'true');
    await expect(badgeOf(item)).toHaveText('Suggested');
    await expect(notifications(page).getByRole('button', { name: 'Undo' })).toHaveCount(0);
    release();

    await expect(toastWith(page, SAVE_FAILED)).toBeVisible();
    // The item is as it was, its button works again, and there is no Undo for a change that was not made.
    await expect(badgeOf(item)).toHaveText('Suggested');
    expect(await actionWords(item)).toEqual(['Dismiss', 'Confirm link']);
    await expect(confirm).not.toHaveAttribute('aria-busy', 'true');
    await expect(undoButton(page)).toHaveCount(0);
    // Focus stays on the button that was pressed, so it can be pressed again.
    await expect(confirm).toBeFocused();
    expect(await classOf(world, pr.id, sessionId)).toBe('suggested');
    // The row did not move either.
    expect(
      await toggleOf(page, pr).evaluate((toggle) => toggle.closest('tr')?.textContent ?? ''),
    ).toBe(before);
  });

  test('every kind of change that fails says the same thing and changes nothing', async ({
    page,
  }) => {
    const world = await openDelivery(page, 1280);
    const pr = await prOf(world, 311);
    const detail = await detailOf(world, pr.id);
    const panel = await openPr(page, pr);
    await failWrites(page);
    const writes = recordWrites(page);
    const snapshot = async () => (await detailOf(world, pr.id)).evidence;

    const start = await snapshot();
    for (const [index, [session, name]] of (
      [
        [bySuggested(detail), /^Dismiss/],
        [byEvidence(detail), /^Mark incorrect/],
      ] as const
    ).entries()) {
      await itemFor(panel, session).getByRole('button', { name }).click();
      await expect.poll(() => writes.length).toBe(index + 1);
      await expect(toastWith(page, SAVE_FAILED)).toBeVisible();
      await expect(itemsOf(panel)).toHaveCount(3);
    }
    await panel.getByRole('button', { name: 'Link a session' }).click();
    await panel.getByRole('button', { name: 'Add link' }).click();
    await expect.poll(() => writes.length).toBe(3);
    await expect(toastWith(page, SAVE_FAILED)).toBeVisible();
    // The form stays open with its choice, and the list is the same three.
    await expect(panel.getByRole('combobox')).toBeVisible();
    await expect(itemsOf(panel)).toHaveCount(3);
    expect(await snapshot()).toEqual(start);
  });

  test('an Undo that fails says so and leaves the change in place', async ({ page }) => {
    const world = await openDelivery(page, 1280);
    const pr = await prOf(world, 311);
    const sessionId = bySuggested(await detailOf(world, pr.id));
    const panel = await openPr(page, pr);
    await itemFor(panel, sessionId)
      .getByRole('button', { name: /^Confirm link/ })
      .click();
    await expect(toastWith(page, 'Link confirmed and labeled Owner-confirmed.')).toBeVisible();

    await failWrites(page);
    await undoButton(page).click();
    await expect(toastWith(page, SAVE_FAILED)).toBeVisible();
    // The confirmation stands, on the page and on the server.
    await expect(badgeOf(itemFor(panel, sessionId))).toHaveText('Owner-confirmed');
    expect(await classOf(world, pr.id, sessionId)).toBe('owner');
    await expect(toggleOf(page, pr)).toBeFocused();
  });

  test('a change that takes the PR out of its tab still says so with an Undo, and focus is not lost', async ({
    page,
  }) => {
    const world = await openDelivery(page, 1280, '?linkClass=suggested');
    const pr = await prOf(world, 106);
    const sessionId = bySuggested(await detailOf(world, pr.id));
    const panel = await openPr(page, pr);
    await itemFor(panel, sessionId)
      .getByRole('button', { name: /^Confirm link/ })
      .click();

    // The PR is Owner-confirmed now, so the Suggested tab no longer lists it.
    await expect(toastWith(page, 'Link confirmed and labeled Owner-confirmed.')).toBeVisible();
    await expect(page.getByText('No PRs match these filters.')).toBeVisible();
    await expect(page.locator(`[data-pr-id="${pr.id}"]`)).toHaveCount(0);
    // The row toggle went with it, so focus goes to the page heading rather than to the page.
    await expect(page.getByRole('heading', { level: 1, name: 'Delivery' })).toBeFocused();

    await undoButton(page).click();
    await expect(page.locator(`[data-pr-id="${pr.id}"]`)).toHaveCount(1);
    expect(await classOf(world, pr.id, sessionId)).toBe('suggested');
  });
});

// ============================================================================================================================
// The keyboard
// ============================================================================================================================

/** Presses Tab until the focused element's name starts with `name`; false if it never does within `limit` presses. */
async function tabTo(page: Page, name: RegExp, limit = 12): Promise<boolean> {
  for (let press = 0; press < limit; press += 1) {
    await page.keyboard.press('Tab');
    const label = await page.evaluate(
      () =>
        document.activeElement?.getAttribute('aria-label') ??
        document.activeElement?.textContent ??
        '',
    );
    if (name.test(label.trim())) return true;
  }
  return false;
}

test.describe('keyboard only', () => {
  test(
    'a PR is opened, a suggestion confirmed, undone, and a session linked, without a pointer',
    { tag: '@a11y' },
    async ({ page }) => {
      const world = await openDelivery(page, 1280);
      const pr = await prOf(world, 315);
      const detail = await detailOf(world, pr.id);
      const suggestedId = bySuggested(detail);
      const toggle = toggleOf(page, pr);

      // Open it with the keyboard: Enter on the row toggle.
      await toggle.focus();
      await page.keyboard.press('Enter');
      const panel = panelOf(page, pr);
      await expect(itemsOf(panel)).toHaveCount(2);
      await expect(toggle).toBeFocused();

      // Tab to Confirm link and press Enter: saved, said in a toast, and focus is back on the toggle.
      expect(await tabTo(page, /^Confirm link/)).toBe(true);
      await page.keyboard.press('Enter');
      await expect(toastWith(page, 'Link confirmed and labeled Owner-confirmed.')).toBeVisible();
      await expect(toggle).toBeFocused();
      await expect(badgeOf(itemFor(panel, suggestedId))).toHaveText('Owner-confirmed');

      // F6 moves into the toast; Enter on Undo puts it back; focus is on the toggle again.
      await page.keyboard.press('F6');
      await expect(undoButton(page)).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(badgeOf(itemFor(panel, suggestedId))).toHaveText('Suggested');
      await expect(toggle).toBeFocused();
      expect(await classOf(world, pr.id, suggestedId)).toBe('suggested');

      // Link a session: Enter opens it with the list focused, Tab reaches Cancel and then Add link (primary, on the right), and Cancel
      // gives focus back to the button that opened it.
      expect(await tabTo(page, /^Link a session/)).toBe(true);
      await page.keyboard.press('Enter');
      const select = panel.getByRole('combobox');
      await expect(select).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(panel.getByRole('button', { name: 'Cancel' })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(panel.getByRole('button', { name: 'Link a session' })).toBeFocused();

      await page.keyboard.press('Enter');
      await expect(select).toBeFocused();
      await page.keyboard.press('ArrowDown');
      const chosen = Number(await select.inputValue());
      expect(chosen).toBeGreaterThan(0);
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await expect(panel.getByRole('button', { name: 'Add link' })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(toastWith(page, 'Session linked and labeled Owner-confirmed.')).toBeVisible();
      await expect(toggle).toBeFocused();
      await expect(badgeOf(itemFor(panel, chosen))).toHaveText('Owner-confirmed');
      expect(await classOf(world, pr.id, chosen)).toBe('owner');

      // Close it from the keyboard.
      await page.keyboard.press('Space');
      await expect(panel).toHaveCount(0);
      await expect(toggle).toBeFocused();
    },
  );
});

// ============================================================================================================================
// Usage and Delivery say the same thing
// ============================================================================================================================

/** "pr-id|session-id" to the badge words, for every link Delivery lists, with each PR's evidence opened. */
async function deliveryBadges(page: Page, world: World): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const pr of await prsOf(world)) {
    const panel = await openPr(page, pr);
    for (const item of await itemsOf(panel).all()) {
      const sessionId = await item.getAttribute('data-evidence-session');
      found.set(`${pr.id}|${sessionId}`, (await badgeOf(item).innerText()).trim());
    }
  }
  return found;
}

/** Opens the Usage tree with a year's worth of weeks (a linked session can have been active before the week its PR merged in). */
async function openUsage(page: Page): Promise<void> {
  await page.goto(`${ORIGIN}/usage?start=2026-05-01&end=2026-11-08`);
  await expect(page.getByRole('heading', { level: 1, name: 'Usage' })).toBeVisible();
}

/** The Usage tree on screen, opened all the way down: every session row's Linked PRs cell, one entry per `#number` link. */
async function usageBadges(page: Page, world: World): Promise<Map<string, string>> {
  const card = page.getByRole('region', { name: 'Sessions by repository' });
  await expect(card.locator('button[aria-expanded]').first()).toBeVisible();
  for (let guard = 0; guard < 80; guard += 1) {
    await expect(card.getByText('Loading sessions…')).toHaveCount(0);
    const closed = card.locator('button[aria-expanded="false"]');
    if ((await closed.count()) === 0) break;
    await closed.first().click();
  }
  const prs = await prsOf(world);
  const found = new Map<string, string>();
  const rows = await card.locator('[data-session-id]').all();
  for (const row of rows) {
    const sessionId = await row.getAttribute('data-session-id');
    for (const link of await row.getByRole('link', { name: /^#\d+ in / }).all()) {
      const name = ((await link.textContent()) ?? '').replace(/\s+/g, ' ').trim();
      const match = /^#(\d+) in (\S+)/.exec(name);
      const pr = prs.find(
        (candidate) => candidate.number === Number(match?.[1]) && candidate.repo === match?.[2],
      );
      // A session in the wider range can link to a PR from before the week Delivery shows.
      if (!pr) continue;
      // The badge is in the same list item as the link.
      const badge = await link.locator('xpath=ancestor::li[1]').getByText(BADGE).innerText();
      found.set(`${pr.id}|${sessionId}`, badge.trim());
    }
  }
  return found;
}

/** The Usage tree, freshly loaded. */
async function loadUsageBadges(page: Page, world: World): Promise<Map<string, string>> {
  await openUsage(page);
  return usageBadges(page, world);
}

test.describe('Usage and Delivery', () => {
  test('the badge words of every link are the same in the Usage tree and in Delivery', async ({
    page,
  }) => {
    const world = await openDelivery(page, 1280);
    const delivery = await deliveryBadges(page, world);
    expect(delivery.size).toBeGreaterThanOrEqual(8);
    expect(new Set(delivery.values())).toEqual(
      new Set(['Evidence link', 'Owner-confirmed', 'Suggested']),
    );

    const usage = await loadUsageBadges(page, world);
    // Every link Delivery lists, and no other, with the same words.
    expect([...usage.entries()].sort()).toEqual([...delivery.entries()].sort());
  });

  test('a link marked incorrect is struck through in Delivery and hidden in the Usage tree, and Restore brings it back', async ({
    page,
  }) => {
    const world = await openDelivery(page, 1280);
    const pr = await prOf(world, 311);
    const detail = await detailOf(world, pr.id);
    const sessionId = byEvidence(detail);
    const evidenceItem = detail.evidence!.find((item) => item.session.id === sessionId)!;
    const panel = await openPr(page, pr);
    const key = `${pr.id}|${sessionId}`;

    await itemFor(panel, sessionId)
      .getByRole('button', { name: /^Mark incorrect/ })
      .click();
    await expect(
      toastWith(page, 'Marked incorrect. The source’s claim is kept but not counted.'),
    ).toBeVisible();

    // Delivery: last, struck through, the source's claim kept in the words, and a Restore.
    const items = itemsOf(panel);
    await expect(items).toHaveCount(3);
    const last = items.nth(2);
    await expect(last).toHaveAttribute('data-evidence-session', String(sessionId));
    const badge = badgeOf(last);
    await expect(badge).toHaveText('Marked incorrect');
    expect(await badge.evaluate((node) => getComputedStyle(node).textDecorationLine)).toBe(
      'line-through',
    );
    await expect(last).toContainText(
      `Basis: Source claim kept: ${evidenceItem.basisText}. You marked it incorrect, so it isn’t counted as linked.`,
    );
    expect(await actionWords(last)).toEqual(['Restore']);
    // The PR no longer counts it.
    await expect(
      page.locator(`[data-pr-id="${pr.id}"]`).getByText('1 session · +1 suggested'),
    ).toBeVisible();

    // Usage: not listed at all.
    const hidden = await loadUsageBadges(page, world);
    expect(hidden.has(key)).toBe(false);

    // Restore it: back among the evidence in Delivery and in Usage.
    await page.goto(`${ORIGIN}/delivery`);
    await expect(page.getByRole('heading', { level: 1, name: 'Delivery' })).toBeVisible();
    const again = await openPr(page, pr);
    await itemFor(again, sessionId)
      .getByRole('button', { name: /^Restore/ })
      .click();
    await expect(toastWith(page, 'Evidence link restored.')).toBeVisible();
    await expect(badgeOf(itemFor(again, sessionId))).toHaveText('Evidence link');
    expect((await loadUsageBadges(page, world)).get(key)).toBe('Evidence link');
  });

  test('a change in Delivery shows in the Usage tree with the same words', async ({ page }) => {
    const world = await openDelivery(page, 1280);
    const pr = await prOf(world, 311);
    const sessionId = bySuggested(await detailOf(world, pr.id));
    const key = `${pr.id}|${sessionId}`;
    expect((await loadUsageBadges(page, world)).get(key)).toBe('Suggested');

    await page.goto(`${ORIGIN}/delivery`);
    const panel = await openPr(page, pr);
    await itemFor(panel, sessionId)
      .getByRole('button', { name: /^Confirm link/ })
      .click();
    await expect(toastWith(page, 'Link confirmed and labeled Owner-confirmed.')).toBeVisible();
    const words = (await badgeOf(itemFor(panel, sessionId)).innerText()).trim();
    expect(words).toBe('Owner-confirmed');
    expect((await loadUsageBadges(page, world)).get(key)).toBe(words);
  });

  test('moving between the screens shows the change without a reload (the Usage tree was already read once)', async ({
    page,
  }) => {
    const world = await openWorld(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    const pr = await prOf(world, 311);
    const sessionId = bySuggested(await detailOf(world, pr.id));
    const key = `${pr.id}|${sessionId}`;
    const nav = page.getByRole('navigation').first();

    await openUsage(page);
    expect((await usageBadges(page, world)).get(key)).toBe('Suggested');

    // Client-side navigation only from here: the page is never reloaded, so what Usage shows is the cache's.
    await nav.getByRole('link', { name: 'Delivery' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Delivery' })).toBeVisible();
    const panel = await openPr(page, pr);
    await itemFor(panel, sessionId)
      .getByRole('button', { name: /^Confirm link/ })
      .click();
    await expect(toastWith(page, 'Link confirmed and labeled Owner-confirmed.')).toBeVisible();

    await nav.getByRole('link', { name: 'Usage' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Usage' })).toBeVisible();
    expect((await usageBadges(page, world)).get(key)).toBe('Owner-confirmed');
  });

  test('a #number in the Usage tree leads to that PR in Delivery', async ({ page }) => {
    const world = await openWorld(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    const pr = await prOf(world, 311);
    const sessionId = bySuggested(await detailOf(world, pr.id));
    await openUsage(page);
    await usageBadges(page, world);
    const row = page.locator(`[data-session-id="${sessionId}"]`);
    await row.getByRole('link', { name: `#${pr.number} in ${pr.repo}` }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Delivery' })).toBeVisible();
    // The search is the link's own, and the PR it names is listed.
    await expect(page.getByRole('searchbox', { name: 'Search pull requests' })).toHaveValue(
      `${pr.repo}#${pr.number}`,
    );
    await expect(page.locator(`[data-pr-id="${pr.id}"]`)).toHaveCount(1);
  });

  test('a #number for a PR that merged before this week still lands on that PR, on its own day and for every author', async ({
    page,
  }) => {
    const world = await openWorld(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    const thisWeek = await prsOf(world);
    await openUsage(page);
    const card = page.getByRole('region', { name: 'Sessions by repository' });
    await expect(card.locator('button[aria-expanded]').first()).toBeVisible();
    for (let guard = 0; guard < 80; guard += 1) {
      await expect(card.getByText('Loading sessions…')).toHaveCount(0);
      const closed = card.locator('button[aria-expanded="false"]');
      if ((await closed.count()) === 0) break;
      await closed.first().click();
    }
    // A link in the wider range whose PR the default week of Delivery does not list: before this fix it opened an empty page.
    let older: { number: string; repo: string; link: Locator } | null = null;
    for (const link of await card.getByRole('link', { name: /^#\d+ in / }).all()) {
      const match = /^#(\d+) in (\S+)/.exec(
        ((await link.textContent()) ?? '').replace(/\s+/g, ' ').trim(),
      );
      if (!match) continue;
      const listed = thisWeek.some((pr) => pr.number === Number(match[1]) && pr.repo === match[2]);
      if (!listed) {
        older = { number: match[1]!, repo: match[2]!, link };
        break;
      }
    }
    expect(older, 'the seeded Usage range links a PR from before this week').not.toBeNull();
    await older!.link.click();

    await expect(page.getByRole('heading', { level: 1, name: 'Delivery' })).toBeVisible();
    await expect(page.getByRole('searchbox', { name: 'Search pull requests' })).toHaveValue(
      `${older!.repo}#${older!.number}`,
    );
    // The link names the PR's own day and every author, so the one PR is listed (the default week would show none).
    const url = new URL(page.url());
    expect(url.searchParams.get('author')).toBe('all');
    expect(url.searchParams.get('start')).toBe(url.searchParams.get('end'));
    expect(url.searchParams.get('start')! < '2026-11-02').toBe(true);
    await expect(page.locator('[data-pr-id]')).toHaveCount(1);
    await expect(page.locator('[data-pr-id]')).toContainText(`${older!.repo} #${older!.number}`);
    await expect(page.getByText('No PRs match these filters.')).toHaveCount(0);
  });
});

// ============================================================================================================================
// Layout, touch and accessibility
// ============================================================================================================================

/** A week that shows every class at once: a link of each kind on three PRs, and the form to link a session open on a fourth. */
async function prepare(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  const world = await openWorld(page);
  const mixed = await prOf(world, 311);
  const confirmed = await prOf(world, 315);
  const empty = await prOf(world, 316);
  await decide(world, mixed.id, byEvidence(await detailOf(world, mixed.id)), 'rejected');
  await decide(world, confirmed.id, bySuggested(await detailOf(world, confirmed.id)), 'confirmed');
  await page.goto(`${ORIGIN}/delivery`);
  await expect(page.getByRole('heading', { level: 1, name: 'Delivery' })).toBeVisible();
  const mixedPanel = await openPr(page, mixed);
  await openPr(page, confirmed);
  const emptyPanel = await openPr(page, empty);
  await emptyPanel.getByRole('button', { name: 'Link a session' }).click();
  await expect(emptyPanel.getByRole('combobox')).toBeFocused();
  return { world, mixed, mixedPanel, confirmed, empty, emptyPanel };
}

for (const width of [1280, 390, 320]) {
  test.describe(`at ${width}px`, () => {
    test(
      'nothing leaves the window, every class is drawn, and the toast fits',
      { tag: '@responsive' },
      async ({ page }) => {
        const { world, mixed, mixedPanel } = await prepare(page, width);
        // Every class is on the page: evidence, owner, suggested, marked incorrect.
        for (const words of Object.values(LABEL)) {
          await expect(
            page.locator('main').getByText(words, { exact: true }).first(),
          ).toBeVisible();
        }
        expect(failures(await measureContainment(page))).toEqual([]);

        // With a toast up (and its Undo) the page still fits, and the Undo is a target a finger can hit on a phone.
        const suggested = bySuggested(await detailOf(world, mixed.id));
        const item = itemFor(mixedPanel, suggested);
        const dismiss = item.getByRole('button', { name: /^Dismiss/ });
        await expect(mixedPanel.getByText(/Token counts belong to each session/)).toHaveCount(1);
        await expect(item.getByText(/^Session tokens:/)).toBeVisible();
        if (width < 720) {
          const identity = await item.locator('time').boundingBox();
          const tokens = await item.getByText(/^Session tokens:/).boundingBox();
          const badge = await item.getByText('Suggested', { exact: true }).boundingBox();
          const action = await dismiss.boundingBox();
          const basis = await item.getByText(/^Basis:/).boundingBox();
          expect(tokens!.y).toBeGreaterThan(identity!.y);
          expect(badge!.y).toBeGreaterThan(tokens!.y);
          expect(basis!.y).toBeGreaterThan(badge!.y);
          expect(basis!.y + basis!.height).toBeLessThan(action!.y);
        }
        await dismiss.click();
        await expect(toastWith(page, 'Suggestion dismissed.')).toBeVisible();
        const toast = notifications(page)
          .locator('.astryx-toast')
          .filter({ hasText: 'Suggestion dismissed.' });
        await expect(toast).toHaveCSS('background-color', 'rgb(31, 27, 22)');
        await expect(toast).toHaveCSS('border-radius', '999px');
        const box = (await toast.boundingBox())!;
        expect(box.x + box.width / 2).toBeCloseTo(width / 2, 0);
        expect(failures(await measureContainment(page))).toEqual([]);
        if (width < 720) {
          const undo = await undoButton(page).boundingBox();
          expect(undo!.height).toBeGreaterThanOrEqual(44);
          const nav = await page.getByRole('navigation', { name: 'Sections' }).boundingBox();
          // The row and card animate in, so compare once the card is in position.
          await expect
            .poll(async () => {
              const current = (await toast.boundingBox())!;
              return current.y + current.height;
            })
            .toBeLessThan(nav!.y);
        }
      },
    );

    test(
      'actions and the Link a session form are 44px targets on a phone, and the primary is on the right',
      { tag: '@responsive' },
      async ({ page }) => {
        const { mixedPanel, emptyPanel } = await prepare(page, width);
        const buttons = [
          ...(await mixedPanel.getByRole('button').all()),
          ...(await emptyPanel.getByRole('button').all()),
        ];
        expect(buttons.length).toBeGreaterThanOrEqual(5);
        for (const button of buttons) {
          const box = await button.boundingBox();
          const name = (await button.getAttribute('aria-label')) ?? (await button.innerText());
          if (width < 720) expect(box!.height, name).toBeGreaterThanOrEqual(44);
          else expect(box!.height, name).toBeGreaterThanOrEqual(24);
        }
        // Cancel on the left of Add link, Dismiss on the left of Confirm link: the primary is last and rightmost on its line.
        const cancel = await emptyPanel.getByRole('button', { name: 'Cancel' }).boundingBox();
        const add = await emptyPanel.getByRole('button', { name: 'Add link' }).boundingBox();
        expect(cancel!.x).toBeLessThan(add!.x);
        const dismiss = await mixedPanel.getByRole('button', { name: /^Dismiss/ }).boundingBox();
        const confirm = await mixedPanel
          .getByRole('button', { name: /^Confirm link/ })
          .boundingBox();
        expect(dismiss!.x).toBeLessThan(confirm!.x);
      },
    );

    test(
      'axe finds nothing with every class and the form open',
      { tag: '@a11y' },
      async ({ page }) => {
        await prepare(page, width);
        const { violations } = await new AxeBuilder({ page }).analyze();
        expect(
          violations.map(
            (v) =>
              `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).join('\n    ')}`,
          ),
          `axe found ${violations.length} violation(s)`,
        ).toEqual([]);
      },
    );
  });
}
