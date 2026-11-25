import { describe, expect, it, vi } from 'vitest';
import { workReviewKeyring } from '../../src/server/services/work-review/keyring.ts';
import { createWorkReviewService } from '../../src/server/services/work-review/service.ts';
import { upsertPullRequests } from '../../src/server/db/queries/prs.ts';
import { setMeta } from '../../src/server/db/queries/meta.ts';
import { call, memoryDb, NOW, testApp, TZ, WRITE } from '../server/helpers.ts';

function fixture() {
  const db = memoryDb();
  setMeta(db, 'github_login', 'me');
  setMeta(db, 'setup_completed_at', '1');
  db.exec(
    "INSERT INTO repo(id,display_name,tracking_state,access_state,added_at,backfill_complete) VALUES('me/app','me/app','active','ok',0,1)",
  );
  const add = (n: number, author: string) =>
    upsertPullRequests(db, [
      {
        nodeId: 'node-' + n,
        number: n,
        repoId: 'me/app',
        title: 'Repair ' + n,
        authorLogin: author,
        mergedByLogin: 'me',
        mergedAt: NOW - 8 * 86_400_000,
        url: 'https://github.com/me/app/pull/' + n,
        headRef: null,
        baseRef: null,
        mergeCommitSha: null,
        commits: [],
        commitsComplete: true,
      },
    ]);
  add(1, 'me');
  const worker = {
    extract: vi.fn(),
    summarize: vi.fn(
      async (input: {
        items: readonly {
          id: string;
          text: string;
          kind: 'shipped' | 'team' | 'progress' | 'open';
        }[];
      }) => ({
        headline: 'A repair merged.',
        ids: [input.items[0]!.id],
        bullets: input.items.map((i) => ({ kind: i.kind, text: i.text, ids: [i.id] })),
      }),
    ),
  };
  let connected = true;
  const disconnect = () => {
    connected = false;
  };
  const service = createWorkReviewService({
    db,
    timezone: TZ,
    now: () => NOW,
    worker,
    accountStatus: () => (connected ? 'connected' : 'disconnected'),
  });
  const filters = { start: '2026-10-26', end: '2026-11-01', author: 'all' };
  return { db, add, worker, service, filters, disconnect };
}

describe('manual review cache', () => {
  it('reads without a model, coalesces requests, and preserves locked versions after late evidence', async () => {
    const { service, add, filters, worker } = fixture();
    expect(service.read(filters).review).toBeNull();
    expect(worker.summarize).not.toHaveBeenCalled();
    service.generate(filters, false);
    service.generate(filters, false);
    await service.idle();
    const original = service.read(filters);
    expect(original.review?.version).toBe(1);
    expect(original.locked).toBe(true);
    service.generate({ ...filters, gran: 'month' }, false);
    await service.idle();
    expect(worker.summarize).toHaveBeenCalledTimes(1);
    add(2, 'somebody-else');
    expect(service.read(filters).changed).toBe(true);
    expect(() => service.generate(filters, false)).toThrow(/revision/i);
    service.generate(filters, true);
    await service.idle();
    expect(service.read(filters, 1).review).toEqual(original.review);
    expect(
      service
        .read(filters)
        .review?.bullets.map((b) => b.kind)
        .sort(),
    ).toEqual(['shipped', 'team']);
    expect(service.read({ ...filters, author: 'mine' }).review).toBeNull();
  });
});

it('reuses dated session notes across a week and month, and clears them with a confirmed reset', async () => {
  const { db, service, filters, worker } = fixture();
  const start = NOW - 8 * 86_400_000;
  db.prepare(
    "INSERT INTO session (id,provider,provider_session_id,kind,recorded_name,repo_id,started_at,started_basis) VALUES(12,'codex','local-synthetic','root','Investigate parser retry','me/app',?,'source_start')",
  ).run(start);
  db.prepare(
    "INSERT INTO usage_event(provider,dedupe_key,session_id,occurred_at,model,provider_total) VALUES('codex','one',12,?,'local',1)",
  ).run(start);
  worker.extract.mockResolvedValue([
    { kind: 'progress', text: 'I investigated the parser retry.' },
  ]);
  service.generate(filters, false);
  await service.idle();
  expect(
    service
      .read(filters)
      .review?.bullets.some((b) =>
        b.evidence.some((ref) => ref.kind === 'session' && ref.date === '2026-10-27'),
      ),
  ).toBe(true);
  expect(service.read(filters).review?.coverage.join(' ')).toContain('missing or incomplete');
  service.generate({ ...filters, start: '2026-10-01', end: '2026-10-31' }, false);
  await service.idle();
  expect(worker.extract).toHaveBeenCalledTimes(1);
  expect(worker.summarize).toHaveBeenCalledTimes(2);
  const { app } = testApp({ db, workReview: service });
  const result = await call(app, '/api/setup/reset', {
    method: 'POST',
    headers: WRITE,
    body: '{"confirmed":true}',
  });
  expect(result.status).toBe(204);
  expect(db.prepare('SELECT COUNT(*) AS n FROM work_review_note').get()?.['n']).toBe(0);
  expect(service.read(filters).review).toBeNull();
});

it('rejects generation without consent, after disconnect, and for an unrecognized repository', async () => {
  const { db, service, worker, disconnect } = fixture();
  const { app } = testApp({ db, workReview: service });
  const post = (query: string, body: unknown) =>
    call(app, '/api/work-review/generate' + query, {
      method: 'POST',
      headers: WRITE,
      body: JSON.stringify(body),
    });
  expect((await post('', {})).status).toBe(400);
  expect((await post('?repos=unrecognized%2Frepo', { consent: true })).status).toBe(400);
  disconnect();
  expect((await post('', { consent: true })).status).toBe(502);
  expect(worker.extract).not.toHaveBeenCalled();
  expect(worker.summarize).not.toHaveBeenCalled();
});

it('keeps a saved review when a revision fails and never exposes upstream error text', async () => {
  const { service, add, worker, filters } = fixture();
  service.generate(filters, false);
  await service.idle();
  add(3, 'me');
  worker.summarize.mockRejectedValueOnce(new Error('SENTINEL_PRIVATE_PROMPT'));
  service.generate(filters, true);
  await service.idle();
  const failed = service.read(filters);
  expect(failed.status).toBe('failed');
  expect(failed.versions).toEqual([1]);
  expect(JSON.stringify(failed)).not.toContain('SENTINEL_PRIVATE_PROMPT');
});

it('keeps the system keychain untouched until the first Work Review registration', () => {
  const db = memoryDb();
  const keyring = { get: vi.fn(() => null), set: vi.fn(), delete: vi.fn(() => true) };
  const store = workReviewKeyring(db, keyring);
  expect(store.get('service', 'account')).toBeNull();
  store.delete('service', 'account');
  expect(keyring.get).not.toHaveBeenCalled();
  expect(keyring.delete).not.toHaveBeenCalled();
  store.set('service', 'account', 'fixture');
  store.get('service', 'account');
  expect(keyring.get).toHaveBeenCalledOnce();
  store.delete('service', 'account');
  store.get('service', 'account');
  expect(keyring.get).toHaveBeenCalledOnce();
  expect(keyring.delete).toHaveBeenCalledOnce();
  db.close();
});

it('retains headline-only batch summaries and their original citations across a long range', async () => {
  const { service, add, worker, filters } = fixture();
  for (let n = 2; n <= 81; n++) add(n, 'me');
  worker.summarize.mockImplementation(async ({ items }) => ({
    headline: 'I shipped the repairs.',
    ids: [
      items[0]!.id,
      ...items
        .slice(-1)
        .filter((last) => last !== items[0])
        .map((last) => last.id),
    ],
    bullets: [],
  }));
  service.generate(filters, false);
  await service.idle();
  const review = service.read(filters).review;
  expect(review?.headline).toBe('I shipped the repairs.');
  expect(review?.headlineEvidence).toHaveLength(3);
  expect(worker.summarize).toHaveBeenCalledTimes(3);
});

it('requires completed setup before starting a Work Review sign-in', async () => {
  const { app } = testApp();
  const result = await call(app, '/api/work-review/account/connect', {
    method: 'POST',
    headers: WRITE,
    body: '{}',
  });
  expect(result.status).toBe(400);
});
