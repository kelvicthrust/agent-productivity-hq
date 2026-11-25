import { describe, expect, it, vi } from 'vitest';
import { workReviewKeyring } from '../../src/server/services/work-review/keyring.ts';
import { createWorkReviewService } from '../../src/server/services/work-review/service.ts';
import type { WorkReviewWorker } from '../../src/server/services/work-review/worker.ts';
import { upsertPullRequests } from '../../src/server/db/queries/prs.ts';
import { setMeta } from '../../src/server/db/queries/meta.ts';
import { gate } from '../fixtures/scripted-adapters/scripted.ts';
import { call, memoryDb, NOW, testApp, TZ, WRITE } from '../server/helpers.ts';
import { addActiveSession, addRepo } from '../server/usage/helpers.ts';

const HOUR = 3_600_000;

function fixture() {
  const db = memoryDb();
  setMeta(db, 'github_login', 'me');
  setMeta(db, 'setup_completed_at', '1');
  addRepo(db, 'me/app');
  const add = (n: number, author: string, mergedAt = NOW - 8 * 86_400_000, repoId = 'me/app') =>
    upsertPullRequests(db, [
      {
        nodeId: 'node-' + n,
        number: n,
        repoId,
        title: 'Repair ' + n,
        authorLogin: author,
        mergedByLogin: 'me',
        mergedAt,
        url: `https://github.com/${repoId}/pull/${n}`,
        headRef: null,
        baseRef: null,
        mergeCommitSha: null,
        commits: [],
        commitsComplete: true,
      },
    ]);
  add(1, 'me');
  const worker = {
    extract: vi.fn<WorkReviewWorker['extract']>(),
    summarize: vi.fn<WorkReviewWorker['summarize']>(async (input) => ({
      headline: 'A repair merged.',
      ids: [input.items[0]!.id],
      bullets: input.items.map((i) => ({ kind: i.kind, text: i.text, ids: [i.id] })),
    })),
  };
  let connected = true;
  const disconnect = () => {
    connected = false;
  };
  let time = NOW;
  const advance = (milliseconds: number) => void (time += milliseconds);
  const createService = () =>
    createWorkReviewService({
      db,
      timezone: TZ,
      now: () => time,
      worker,
      accountStatus: () => (connected ? 'connected' : 'disconnected'),
    });
  const service = createService();
  const filters = { start: '2026-10-26', end: '2026-11-01', author: 'all' };
  return { db, add, worker, service, filters, disconnect, advance, createService };
}

describe('automatic current-week review', () => {
  it('requires opt-in, uses the default calendar week, and updates only when there is evidence', async () => {
    const { db, service, worker, add, advance, filters } = fixture();
    addRepo(db, 'me/other');
    add(2, 'someone-else', NOW);
    add(3, 'me', NOW + 14 * HOUR);
    expect(service.getAutomation()).toEqual({ enabled: false });
    await service.tick();
    expect(service.read({}).review).toBeNull();
    await expect(service.setAutomation(true)).resolves.toEqual({ enabled: true });
    await service.tick();
    expect(service.read({}).review).toBeNull();
    add(4, 'ME', NOW, 'me/other');
    addActiveSession(db, {
      id: 12,
      provider: 'codex',
      name: 'Codex investigation',
      startedAt: NOW,
    });
    addActiveSession(db, {
      id: 13,
      provider: 'claude',
      name: 'Claude investigation',
      startedAt: NOW,
    });
    worker.extract.mockResolvedValue([{ kind: 'progress', text: 'I investigated the parser.' }]);
    await Promise.all([service.tick(), service.tick()]);
    expect(worker.extract.mock.calls.map(([input]) => input.title).sort()).toEqual([
      'Claude investigation',
      'Codex investigation',
    ]);
    expect(worker.summarize).toHaveBeenCalledOnce();
    expect(worker.summarize.mock.calls[0]?.[0]).toMatchObject({
      startDate: '2026-11-02',
      endDate: '2026-11-08',
      items: [
        expect.objectContaining({ kind: 'shipped', text: 'Repair 4' }),
        expect.objectContaining({ kind: 'progress' }),
        expect.objectContaining({ kind: 'progress' }),
      ],
    });
    expect(service.read({}).versions).toEqual([1]);
    expect(service.read(filters).review).toBeNull();

    // Local midnight here is eight hours after UTC midnight. Remove the future fixture before
    // advancing to a new local date with no new eligible evidence.
    db.exec("DELETE FROM pull_request WHERE node_id = 'node-3'");
    advance(24 * HOUR);
    await service.tick();
    expect(worker.summarize).toHaveBeenCalledOnce();
    expect(service.read({}).versions).toEqual([1]);
    db.close();
  });

  it('locally replaces the report when its last evidence is removed', async () => {
    const { db, service, worker, add, advance } = fixture();
    add(2, 'me', NOW);
    await service.setAutomation(true);
    await service.tick();
    const original = service.read({}).review;
    db.exec("DELETE FROM pull_request WHERE node_id = 'node-2'");
    advance(6 * HOUR);
    await service.tick();
    expect(service.read({})).toMatchObject({
      versions: [2, 1],
      review: { headlineEvidence: [], bullets: [] },
    });
    expect(service.read({}, 1).review).toEqual(original);
    expect(worker.summarize).toHaveBeenCalledOnce();
    db.close();
  });

  it('persists the opt-in and six-hour window across service restarts, retaining a prior version after failure', async () => {
    const { db, service, createService, worker, add, advance } = fixture();
    add(2, 'me', NOW);
    service.generate({}, false);
    await service.idle();
    await service.setAutomation(true);
    add(3, 'me', NOW);
    worker.summarize.mockRejectedValueOnce(new Error('PRIVATE_UPSTREAM_TEXT'));
    await service.tick();
    expect(service.read({})).toMatchObject({ status: 'failed', versions: [1] });
    expect(service.read({}).message).not.toContain('PRIVATE_UPSTREAM_TEXT');
    await service.close();

    const restarted = createService();
    expect(restarted.getAutomation()).toEqual({ enabled: true });
    advance(6 * HOUR - 1);
    await restarted.tick();
    expect(worker.summarize).toHaveBeenCalledTimes(2);
    advance(1);
    await restarted.tick();
    expect(worker.summarize).toHaveBeenCalledTimes(3);
    expect(restarted.read({}).versions).toEqual([2, 1]);
    advance(6 * HOUR);
    await restarted.tick();
    expect(worker.summarize).toHaveBeenCalledTimes(3);
    db.close();
  });

  it('does not replace the last week at the timezone boundary', async () => {
    const { db, service, add, worker, advance } = fixture();
    advance(108 * HOUR - 1); // Sunday evening in report time, just before Monday.
    add(2, 'me', NOW);
    await service.setAutomation(true);
    await service.tick();
    const lastScope = { start: '2026-11-02', end: '2026-11-08' };
    expect(service.read(lastScope).versions).toEqual([1]);
    add(3, 'me', NOW);
    advance(6 * HOUR);
    await service.tick();
    expect(worker.summarize).toHaveBeenCalledOnce();
    expect(service.read(lastScope)).toMatchObject({ locked: true, changed: true, versions: [1] });
    expect(service.read({}).review).toBeNull();
    db.close();
  });

  it.each(['opt-out', 'disconnect', 'shutdown', 'rollover'] as const)(
    'keeps the last version if the automatic update is interrupted by %s',
    async (action) => {
      const { db, service, add, worker, advance } = fixture();
      add(2, 'me', NOW);
      service.generate({}, false);
      await service.idle();
      add(3, 'me', NOW);
      await service.setAutomation(true);
      advance(108 * HOUR - 1);
      const started = gate();
      const result = gate();
      let requestSignal: AbortSignal | undefined;
      worker.summarize.mockImplementationOnce(async (_input, signal) => {
        requestSignal = signal;
        started.release();
        await result.promise;
        return { headline: 'I made progress.', ids: ['0'], bullets: [] };
      });
      const run = service.tick();
      await started.promise;
      expect(service.generate({}, false).status).toBe('running');
      let stop: Promise<unknown> | undefined;
      if (action === 'opt-out') stop = service.setAutomation(false);
      else if (action === 'disconnect') stop = service.disconnect();
      else if (action === 'shutdown') stop = service.close();
      else advance(1);
      expect(requestSignal?.aborted).toBe(action !== 'rollover');
      result.release();
      await Promise.all([run, stop]);
      expect(service.read({ start: '2026-11-02', end: '2026-11-08' }).versions).toEqual([1]);
      expect(service.getAutomation().enabled).toBe(action === 'rollover' || action === 'shutdown');
      expect(worker.summarize).toHaveBeenCalledTimes(2);
      db.close();
    },
  );

  it('leaves an explicitly generated review running when automation is turned off', async () => {
    const { db, service, worker, add } = fixture();
    await service.setAutomation(true);
    add(2, 'me', NOW);
    service.generate({}, false);
    await service.setAutomation(false);
    await service.idle();
    expect(worker.summarize).toHaveBeenCalledOnce();
    expect(service.read({}).versions).toEqual([1]);
    db.close();
  });

  it('does not send further evidence when Monday begins during a model request', async () => {
    const { db, service, worker, advance } = fixture();
    addActiveSession(db, {
      id: 12,
      provider: 'codex',
      name: 'Codex investigation',
      startedAt: NOW,
    });
    addActiveSession(db, {
      id: 13,
      provider: 'claude',
      name: 'Claude investigation',
      startedAt: NOW,
    });
    advance(108 * HOUR - 1);
    const started = gate();
    const result = gate();
    let requestSignal: AbortSignal | undefined;
    worker.extract.mockImplementation(async (_input, signal) => {
      requestSignal = signal;
      started.release();
      await result.promise;
      return [{ kind: 'progress', text: 'I investigated the parser.' }];
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await service.setAutomation(true);
      const run = service.tick();
      await started.promise;
      advance(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(requestSignal?.aborted).toBe(true);
      result.release();
      await run;
      expect(worker.extract).toHaveBeenCalledOnce();
      expect(worker.summarize).not.toHaveBeenCalled();
      expect(service.read({ start: '2026-11-02', end: '2026-11-08' }).versions).toEqual([]);
    } finally {
      result.release();
      await service.close();
      vi.useRealTimers();
      db.close();
    }
  });
});

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
