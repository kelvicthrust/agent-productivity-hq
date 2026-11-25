import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import type { PullRequest } from '../../src/shared/contracts/prs.ts';
import type {
  WorkReviewAccount,
  WorkReviewEvidence,
  WorkReviewState,
  WorkReviewVersion,
} from '../../src/shared/contracts/work-review.ts';
import { expect, test } from './fixtures';
import { ORIGIN } from './helpers/virtualOrigin';
import { openWorld } from './helpers/world';

const SESSION_ID = 'private-session-fixture';
const SESSION = {
  kind: 'session',
  id: SESSION_ID,
  label: 'Import follow-up session',
  date: '2026-10-30',
  repo: 'kelvin/atlas-api',
  notes: [
    'I verified the recovery sequence with a fixture import.',
    'I still need to test recovery with an older database.',
  ],
} satisfies WorkReviewEvidence;

const SHIPPED_PR = {
  kind: 'pr',
  id: 'PR_import_cursor',
  label: 'kelvin/atlas-api #23',
  date: '2026-10-30',
  repo: SESSION.repo,
} as const;
const TEAM_PR = { ...SHIPPED_PR, id: 'PR_updated_checks', label: 'kelvin/atlas-api #24' };
const PR: PullRequest = {
  id: SHIPPED_PR.id,
  repo: SHIPPED_PR.repo,
  number: 23,
  title: 'Save the durable import cursor',
  url: 'https://github.com/kelvin/atlas-api/pull/23',
  mergedAt: '2026-10-30T19:00:00.000Z',
  author: 'kelvin',
  mergedBy: 'kelvin',
  authoredByMe: true,
  linkClass: 'evidence',
  linkedSessionCount: 1,
  suggestedCount: 0,
  providers: ['codex'],
};

const REVIEW: WorkReviewVersion = {
  version: 1,
  createdAt: '2026-11-04T20:00:00.000Z',
  headline: 'I fixed imports losing their place after a restart.',
  headlineEvidence: [SESSION],
  bullets: [
    {
      kind: 'shipped',
      text: 'I shipped a fix that saves the last imported record.',
      evidence: [SHIPPED_PR],
    },
    { kind: 'team', text: 'The team merged updated checks.', evidence: [TEAM_PR] },
    {
      kind: 'progress',
      text: 'I verified the recovery sequence with a fixture import.',
      evidence: [SESSION],
    },
    {
      kind: 'open',
      text: 'I still need to test recovery with an older database.',
      evidence: [SESSION],
    },
  ],
  coverage: ['One older session had a title but no readable transcript.'],
};

const EMPTY: WorkReviewState = {
  status: 'idle',
  message: null,
  review: null,
  versions: [],
  changed: false,
  locked: true,
};

const CONNECTED: WorkReviewAccount = {
  status: 'connected',
  account: 'review@example.test',
  message: null,
};
const DISCONNECTED: WorkReviewAccount = { status: 'disconnected', account: null, message: null };

type Generation = { body: unknown; scope: Record<string, string> };

async function mockReview(
  page: Page,
  read: (query: URLSearchParams) => WorkReviewState,
  generate: () => WorkReviewState,
  account = () => CONNECTED,
) {
  const generations: Generation[] = [];
  await page.route(`${ORIGIN}/api/work-review**`, async (route) => {
    const request = route.request();
    const { pathname, searchParams } = new URL(request.url());
    if (request.method() === 'GET' && pathname === '/api/work-review') {
      await route.fulfill({ json: read(searchParams) });
    } else if (request.method() === 'GET' && pathname === '/api/work-review/account') {
      await route.fulfill({ json: account() });
    } else if (request.method() === 'POST' && pathname === '/api/work-review/generate') {
      generations.push({
        body: request.postDataJSON() as unknown,
        scope: Object.fromEntries(searchParams),
      });
      await route.fulfill({ status: 202, json: generate() });
    } else {
      await route.fallback();
    }
  });
  return generations;
}

test('Work Review offers sign-in again after a rejected grant', async ({ page }) => {
  await openWorld(page);
  let rejected = false;
  const message = 'Sign in to Work Review again to use your ChatGPT plan.';
  await mockReview(
    page,
    () => (rejected ? { ...EMPTY, status: 'failed', message } : EMPTY),
    () => {
      rejected = true;
      return { ...EMPTY, status: 'running' };
    },
    () =>
      rejected
        ? {
            ...DISCONNECTED,
            account: CONNECTED.account,
            message: 'Your ChatGPT connection has expired.',
          }
        : CONNECTED,
  );
  await page.goto(`${ORIGIN}/work-review?start=2026-10-26&end=2026-11-01&author=all`);
  await acknowledgePlan(page);
  const account = page.getByRole('region', { name: 'ChatGPT plan' });
  await expect(account).toContainText('Using ChatGPT plan');
  await page.getByRole('button', { name: 'Generate update' }).click();
  await page
    .getByRole('dialog', { name: /^Generate update/ })
    .getByRole('button', { name: 'Generate update' })
    .click();
  await expect(page.getByRole('alert')).toHaveText(message);
  await expect(account.getByRole('button', { name: 'Continue with ChatGPT' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate update' })).toHaveCount(0);
});

async function acknowledgePlan(page: Page) {
  const welcome = page.getByRole('dialog', { name: 'You’re using your ChatGPT plan' });
  await expect(welcome).toBeVisible();
  await expect(welcome.getByRole('link', { name: 'Manage usage' })).toHaveAttribute(
    'href',
    'https://chatgpt.com/settings/usage',
  );
  await welcome.getByRole('button', { name: 'Got it' }).click();
  await expect(welcome).toBeHidden();
}

test('Overview opens a scoped review in place, asks for consent, and copies the report @a11y @responsive', async ({
  page,
}) => {
  await openWorld(page);
  await page.route(`${ORIGIN}/api/prs/${PR.id}`, (route) => route.fulfill({ json: { pr: PR } }));
  await page.setViewportSize({ width: 1280, height: 900 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => sessionStorage.setItem('review-on-clipboard', text),
      },
    });
  });

  let requested = false;
  const generations = await mockReview(
    page,
    (query) =>
      requested && query.get('start') === '2026-10-26'
        ? { ...EMPTY, review: REVIEW, versions: [1] }
        : EMPTY,
    () => {
      requested = true;
      return { ...EMPTY, status: 'running' };
    },
  );
  await page.goto(`${ORIGIN}/?provider=codex&author=all`);
  const customRange = page.getByRole('dialog', { name: 'Custom range' });
  await page.getByRole('button', { name: 'Custom', exact: true }).click();
  await customRange.getByRole('button', { name: 'Last month', exact: true }).click();
  await expect(page).toHaveURL(
    `${ORIGIN}/?start=2026-10-01&end=2026-10-31&provider=codex&author=all`,
  );
  await page.getByRole('button', { name: 'Last month', exact: true }).click();
  await customRange.getByRole('button', { name: 'Last week', exact: true }).click();
  await expect(page).toHaveURL(
    `${ORIGIN}/?start=2026-10-26&end=2026-11-01&provider=codex&author=all`,
  );

  const preview = page.getByRole('region', { name: 'Work Review' });
  const card = preview.getByRole('button', { name: /^Work Review/ });
  await expect(preview.getByRole('button')).toHaveCount(1);
  await expect(customRange).toBeHidden();
  await card.click();
  const modal = page.getByRole('dialog', { name: 'Weekly work review' });
  const close = modal.getByRole('button', { name: 'Close', exact: true });
  await expect(close).toBeFocused();
  const generate = modal.getByRole('button', { name: 'Generate update' });
  const disclosure = page.getByRole('dialog', { name: /^Generate update/ });
  await generate.click();
  await expect(disclosure).toContainText('selected session excerpts and pull request metadata');
  await expect(disclosure).toContainText('for cloud processing');
  await expect(disclosure).toContainText('ChatGPT plan you connected separately');
  await expect(disclosure).toContainText('reviews and evidence links on this machine');
  await expect(disclosure.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(disclosure).toBeHidden();
  await expect(generate).toBeFocused();
  expect(generations).toHaveLength(0);

  await generate.click();
  await disclosure.getByRole('button', { name: 'Generate update' }).click();
  await expect(modal).toContainText(REVIEW.headline);
  await expect(modal.getByRole('button', { name: 'Copy update' })).toBeFocused();
  expect(generations).toEqual([
    {
      body: { consent: true },
      scope: { author: 'all', end: '2026-11-01', provider: 'codex', start: '2026-10-26' },
    },
  ]);

  await expect(page).toHaveURL(
    `${ORIGIN}/?start=2026-10-26&end=2026-11-01&provider=codex&author=all`,
  );
  await expect(modal.getByRole('link', { name: 'Manage review' })).toHaveAttribute(
    'href',
    '/work-review?start=2026-10-26&end=2026-11-01&provider=codex&author=all',
  );
  const report = modal.getByRole('article', { name: REVIEW.headline });
  for (const heading of [
    'Shipped',
    'Team merges',
    'Other progress',
    'Still open',
    'Source coverage',
  ]) {
    await expect(report.getByRole('heading', { name: heading })).toBeVisible();
  }
  await expect(report).toContainText(REVIEW.coverage[0]!);
  await page.screenshot({
    path: test.info().outputPath('work-review-modal-desktop.png'),
    animations: 'disabled',
  });
  await report.locator('header summary').click();
  await expect(report.locator('header')).toContainText(
    'Local session · kelvin/atlas-api · Oct 30, 2026',
  );
  await expect(report.locator('header').getByText(SESSION.notes[0]!)).toBeVisible();
  await report.getByText(SHIPPED_PR.label, { exact: true }).click();
  await expect(
    report.getByRole('link', { name: /^Save the durable import cursor/ }),
  ).toHaveAttribute('href', PR.url);
  await page.getByRole('button', { name: 'Copy update' }).click();
  await expect(page.getByText('Copied to clipboard.')).toBeVisible();
  const clipboard = await page.evaluate(() => sessionStorage.getItem('review-on-clipboard'));
  expect(clipboard).toContain(REVIEW.headline);
  expect(clipboard).toContain(
    'Still open\n- I still need to test recovery with an older database.',
  );
  expect(clipboard).not.toContain(SESSION_ID);
  expect(clipboard).not.toContain(SESSION.label);
  expect(clipboard).not.toContain('Local session ·');

  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  await expect(card).toBeFocused();
  // Capture the card at rest after checking its keyboard focus state.
  await card.evaluate((element: HTMLButtonElement) => {
    element.scrollIntoView({ block: 'center', behavior: 'instant' });
    element.blur();
  });
  await page.mouse.move(0, 0);
  const panel = page.getByRole('region', { name: 'Recently merged' });
  for (const property of [
    'border-left-width',
    'border-left-color',
    'border-radius',
    'box-shadow',
  ]) {
    const expected = await panel.evaluate(
      (element, name) => getComputedStyle(element).getPropertyValue(name),
      property,
    );
    await expect(card).toHaveCSS(property, expected);
  }
  await page.screenshot({
    path: test.info().outputPath('work-review-overview.png'),
    animations: 'disabled',
  });
  await card.press('Enter');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(report).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('work-review-modal-phone.png'),
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 320, height: 700 });
  await expect(modal.getByRole('button', { name: 'Copy update' })).toBeInViewport();
  await expect(close).toBeInViewport();
  expect(await modal.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(320);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await close.click();
  await expect(card).toBeFocused();
  await expect(preview).toContainText(REVIEW.headline);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('radio', { name: 'This week' }).click();
  await expect(preview).not.toContainText(REVIEW.headline);
  expect(generations).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('a failed historical revision keeps the original and version history stays readable @a11y @responsive', async ({
  page,
}) => {
  await openWorld(page);
  await page.setViewportSize({ width: 320, height: 860 });
  let attempts = 0;
  const second: WorkReviewVersion = {
    ...REVIEW,
    version: 2,
    headline: 'The import recovery check now passes.',
    bullets: REVIEW.bullets.filter(({ kind }) => kind !== 'open'),
  };
  const saved = { ...EMPTY, review: REVIEW, versions: [1], changed: true };
  const generations = await mockReview(
    page,
    (query) => {
      if (attempts === 0) return saved;
      if (attempts === 1)
        return { ...saved, status: 'failed', message: 'Codex timed out. Try again.' };
      return {
        ...saved,
        review: query.get('version') === '1' ? REVIEW : second,
        versions: [2, 1],
        changed: false,
      };
    },
    () => {
      attempts++;
      return { ...saved, status: 'running' };
    },
  );

  await page.goto(`${ORIGIN}/work-review?start=2026-10-26&end=2026-11-01&author=all`);
  await acknowledgePlan(page);
  await expect(page.getByRole('article', { name: REVIEW.headline })).toBeVisible();
  await expect(page.getByText('New evidence is available for this closed period.')).toBeVisible();
  await page.getByRole('article').evaluate((report) => report.scrollIntoView({ block: 'start' }));
  await page.screenshot({
    path: test.info().outputPath('work-review-phone.png'),
    animations: 'disabled',
  });
  const revision = page.getByRole('button', { name: 'Create revision' });
  const dialog = page.getByRole('dialog', { name: /^Create revision/ });
  await revision.click();
  await expect(dialog).toBeVisible();
  await dialog.evaluate(async (element) => {
    await Promise.allSettled(
      element.getAnimations({ subtree: true }).map((animation) => animation.finished),
    );
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await dialog.getByRole('button', { name: 'Create revision' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Codex timed out.' })).toBeVisible();
  await expect(page.getByRole('article', { name: REVIEW.headline })).toBeVisible();
  await revision.click();
  await dialog.getByRole('button', { name: 'Create revision' }).click();
  await expect(page.getByRole('article', { name: second.headline })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Still open' })).toHaveCount(0);
  await page.getByLabel('Review version').selectOption('1');
  await expect(page.getByRole('article', { name: REVIEW.headline })).toBeVisible();
  await expect(revision).toHaveCount(0);
  expect(generations.map(({ body }) => body)).toEqual([
    { consent: true, revision: true },
    { consent: true, revision: true },
  ]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('ChatGPT connection gates generation and preserves previously saved reviews', async ({
  page,
}) => {
  await openWorld(page);
  const generations = await mockReview(
    page,
    () => ({ ...EMPTY, review: REVIEW, versions: [1], changed: true }),
    () => EMPTY,
  );
  let account: WorkReviewAccount = {
    status: 'unavailable',
    account: null,
    message: 'Sign-in is unavailable in this installation.',
  };
  const authUrl = 'https://auth.openai.com/api/accounts/authorize?state=example';
  let requestedUrl = 'https://auth.openai.com/api/accounts/oauth/token?state=example';
  await page.route(`${ORIGIN}/api/work-review/account`, (route) =>
    route.fulfill({ json: account }),
  );
  const connections: unknown[] = [];
  await page.route(`${ORIGIN}/api/work-review/account/connect`, async (route) => {
    connections.push(route.request().postDataJSON());
    expect(route.request().method()).toBe('POST');
    account = { ...DISCONNECTED, status: 'pending' };
    await route.fulfill({ json: { url: requestedUrl } });
  });
  await page.route(`${ORIGIN}/api/work-review/account/disconnect`, async (route) => {
    expect(route.request().method()).toBe('POST');
    account = { ...DISCONNECTED, account: CONNECTED.account };
    await route.fulfill({ json: account });
  });
  const connect = page.getByRole('button', { name: 'Continue with ChatGPT' });
  const review = page.getByRole('article', { name: REVIEW.headline });
  const generate = page.getByRole('button', { name: 'Create revision' });
  const signIn = page.getByRole('link', { name: 'Open ChatGPT sign-in' });
  await page.goto(`${ORIGIN}/work-review`);
  await expect(page.getByText('Sign-in is unavailable in this installation.')).toBeVisible();
  await expect(review).toBeVisible();
  await expect(connect).toHaveCount(0);
  await expect(generate).toHaveCount(0);

  account = DISCONNECTED;
  await page.reload();
  await expect(connect).toHaveAccessibleDescription(
    'Finish sign-in in a browser on the Mac running HQ.',
  );
  await connect.click();
  await expect(
    page
      .getByRole('alert', { name: '', exact: true })
      .filter({ hasText: 'couldn’t use the returned sign-in URL' }),
  ).toBeVisible();
  await expect(signIn).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel sign-in' }).click();

  requestedUrl = authUrl;
  await connect.click();
  await expect(signIn).toHaveAttribute('href', authUrl);
  await expect(generate).toHaveCount(0);
  account = CONNECTED;
  await acknowledgePlan(page);
  await expect(page.getByText('Using ChatGPT plan · review@example.test')).toBeVisible();
  await expect(generate).toBeVisible();
  await page.reload();
  await expect(generate).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'You’re using your ChatGPT plan' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Disconnect ChatGPT' }).click();
  await expect(generate).toHaveCount(0);
  await expect(review).toBeVisible();
  await page.getByRole('button', { name: 'Use a different ChatGPT account' }).click();
  await expect(signIn).toBeVisible();
  expect(connections).toEqual([{}, {}, { newProfile: true }]);
  expect(generations).toHaveLength(0);
});
