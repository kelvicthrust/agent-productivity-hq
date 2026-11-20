import { describe, expect, it } from 'vitest';
import { ReposResponse } from '../../src/shared/contracts/repos.ts';
import { seedDatabase } from '../fixtures/seed.ts';
import { HOST, WRITE, call, memoryDb, testApp } from './helpers.ts';

describe('GET /api/repos', () => {
  it('lists the seeded repos, active before stopped, with the inaccessible one still active', async () => {
    const db = memoryDb();
    seedDatabase(db);
    const { app } = testApp({ db });
    const res = await call(app, '/api/repos', { headers: HOST });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = ReposResponse.parse(await res.json());
    const active = body.active ?? [];
    expect(active.length).toBeGreaterThanOrEqual(4);
    expect(active.every((r) => r.trackingState === 'active')).toBe(true);
    expect((body.stopped ?? []).every((r) => r.trackingState === 'stopped')).toBe(true);

    const inaccessible = active.find((r) => r.id === 'kelvin/archive-private');
    expect(inaccessible).toMatchObject({ accessState: 'inaccessible' });
    expect(typeof inaccessible?.mergedPrsLast12Months).toBe('number');
    const names = active.map((r) => r.displayName.toLowerCase());
    expect(names).toEqual([...names].sort());
  });

  it('counts only merged pull requests inside the 12-month lookback', async () => {
    const db = memoryDb();
    seedDatabase(db);
    const { app } = testApp({ db });
    const before = ReposResponse.parse(
      await (await call(app, '/api/repos', { headers: HOST })).json(),
    );
    const repo = before.active![0]!;
    db.prepare(
      "INSERT INTO pull_request (node_id, repo_id, number, title, url, merged_at) VALUES ('PR_old', ?, 99999, 't', 'https://example.test/x', ?)",
    ).run(repo.id, Date.parse('2024-01-01T00:00:00Z'));
    const after = ReposResponse.parse(
      await (await call(app, '/api/repos', { headers: HOST })).json(),
    );
    expect(after.active![0]!.mergedPrsLast12Months).toBe(repo.mergedPrsLast12Months);
  });

  it('is empty when no repo is tracked, and adding one says GitHub is not available in a process with no GitHub ports', async () => {
    const db = memoryDb();
    seedDatabase(db, { scenario: 'no-repos' });
    const { app } = testApp({ db });
    expect(
      ReposResponse.parse(await (await call(app, '/api/repos', { headers: HOST })).json()),
    ).toEqual({
      active: [],
      stopped: [],
    });
    const post = await call(app, '/api/repos', {
      method: 'POST',
      headers: WRITE,
      body: JSON.stringify({ input: 'a/b' }),
    });
    expect(post.status).toBe(422);
    expect(((await post.json()) as { error: { code: string } }).error.code).toBe(
      'github_not_connected',
    );
  });
});
