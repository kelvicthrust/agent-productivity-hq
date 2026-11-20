import { describe, expect, it } from 'vitest';
import { AddRepoResponse, ReposResponse } from '../../src/shared/contracts/repos.ts';
import { ErrorEnvelope } from '../../src/shared/contracts/errors.ts';
import { NOW, tempConfig } from './helpers.ts';
import { scriptedGithub, startWithGithub } from './github-boot.ts';

// G6_5: a repo that is added stays added across a restart, adding it again is a 409 with nothing doubled, and stopping it and
// adding it again brings its history back once. Boot, the data folder and the SQLite file are real; GitHub is scripted.

const REPO = 'kelvin/atlas-api';
const RANGE = 'start=2026-10-01&end=2026-11-04';
const ADD = { input: 'https://github.com/Kelvin/Atlas-API/pulls' };

const prIds = (db: { prepare: (sql: string) => { all: () => unknown[] } }) =>
  (
    db.prepare('SELECT node_id FROM pull_request ORDER BY node_id').all() as { node_id: string }[]
  ).map((row) => row.node_id);

describe('a tracked repo across restarts', () => {
  it('is still tracked after a restart, with its merged PRs, and adding it again is a 409', async () => {
    const config = tempConfig();
    const clock = { now: NOW };
    const scripted = scriptedGithub(clock);

    const first = await startWithGithub({ config, clock, scripted });
    const added = await first.send('POST', '/api/repos', ADD);
    expect(added.status).toBe(201);
    const repo = AddRepoResponse.parse(added.json);
    expect(repo).toMatchObject({
      id: REPO,
      displayName: 'Kelvin/Atlas-API',
      trackingState: 'active',
      reactivated: false,
    });
    await first.untilBackfilled(REPO);
    const before = prIds(first.db());
    expect(before).toEqual(['PR_atlas_1', 'PR_atlas_2', 'PR_atlas_3']);
    await first.stop();

    const second = await startWithGithub({ config, clock, scripted });
    const repos = ReposResponse.parse((await second.send('GET', '/api/repos')).json);
    expect(repos.active?.map((r) => [r.id, r.accessState, r.mergedPrsLast12Months])).toEqual([
      [REPO, 'ok', 3],
    ]);
    expect(prIds(second.db())).toEqual(before);

    // the same repo in another spelling, and by the plain name: 409, nothing doubled, GitHub not even asked
    const asked = scripted.github.requests.length;
    for (const input of [
      'kelvin/atlas-api',
      'KELVIN/ATLAS-API',
      'https://github.com/kelvin/atlas-api.git',
    ]) {
      const again = await second.send('POST', '/api/repos', { input });
      expect(again.status, input).toBe(409);
      expect(ErrorEnvelope.parse(again.json).error.code).toBe('already_tracked');
    }
    expect(scripted.github.requests.length).toBe(asked);
    expect(second.db().prepare('SELECT COUNT(*) AS n FROM repo').get()).toEqual({ n: 1 });
    await second.stop();
  });

  it('stop, restart, add again: the same rows come back once and the first pass runs again', async () => {
    const config = tempConfig();
    const clock = { now: NOW };
    const scripted = scriptedGithub(clock);

    const first = await startWithGithub({ config, clock, scripted });
    await first.send('POST', '/api/repos', ADD);
    await first.untilBackfilled(REPO);
    const before = prIds(first.db());

    const stopped = await first.send('DELETE', `/api/repos/${REPO}`);
    expect(stopped.status).toBe(204);
    // idempotent
    expect((await first.send('DELETE', `/api/repos/${REPO}`)).status).toBe(204);
    await first.stop();

    const second = await startWithGithub({ config, clock, scripted });
    const repos = ReposResponse.parse((await second.send('GET', '/api/repos')).json);
    expect(repos.active).toEqual([]);
    expect(repos.stopped?.map((r) => r.id)).toEqual([REPO]);
    // a stopped repo leaves the views but keeps its rows
    expect(prIds(second.db())).toEqual(before);
    const hidden = (await second.send('GET', `/api/prs?${RANGE}&author=all`)).json as {
      items: unknown[];
    };
    expect(hidden.items).toEqual([]);

    const back = await second.send('POST', '/api/repos', ADD);
    expect(back.status).toBe(201);
    expect(AddRepoResponse.parse(back.json).reactivated).toBe(true);
    await second.untilBackfilled(REPO);
    expect(prIds(second.db())).toEqual(before);
    expect(second.db().prepare('SELECT COUNT(*) AS n FROM repo').get()).toEqual({ n: 1 });
    const shown = (await second.send('GET', `/api/prs?${RANGE}&author=all`)).json as {
      items: unknown[];
    };
    expect(shown.items).toHaveLength(3);
    await second.stop();
  });

  it('keeps what the owner typed when the repo cannot be read, and stores nothing', async () => {
    const started = await startWithGithub();
    const missing = await started.send('POST', '/api/repos', { input: 'someone/not-there' });
    expect(missing.status).toBe(422);
    expect(ErrorEnvelope.parse(missing.json).error).toMatchObject({
      code: 'repo_inaccessible',
      details: { reason: 'not_found', repo: 'someone/not-there' },
    });
    const junk = await started.send('POST', '/api/repos', { input: 'not a repo' });
    expect(junk.status).toBe(400);
    expect(ErrorEnvelope.parse(junk.json).error.details).toMatchObject({
      fields: { input: expect.any(String) },
    });
    expect(started.db().prepare('SELECT COUNT(*) AS n FROM repo').get()).toEqual({ n: 0 });
    await started.stop();
  });

  it('reads PRs by their merge time: the author view and the all-merges view differ, and every row links to GitHub', async () => {
    const started = await startWithGithub();
    await started.send('POST', '/api/repos', { input: 'kelvin/atlas-api' });
    await started.untilBackfilled(REPO);
    // the connected login is learned when the sync read its credential
    const mine = (await started.send('GET', `/api/prs?${RANGE}`)).json as {
      items: { number: number; url: string; authoredByMe: boolean; mergedBy: string | null }[];
    };
    expect(mine.items.map((pr) => pr.number)).toEqual([1, 2]);
    expect(mine.items.every((pr) => pr.authoredByMe)).toBe(true);
    // PR 2 was merged by someone else but is still the owner's: the merger never decides
    expect(mine.items.find((pr) => pr.number === 2)?.mergedBy).toBe('review-bot');
    expect(mine.items.map((pr) => pr.url)).toEqual([
      'https://github.com/Kelvin/Atlas-API/pull/1',
      'https://github.com/Kelvin/Atlas-API/pull/2',
    ]);
    const all = (await started.send('GET', `/api/prs?${RANGE}&author=all`)).json as {
      items: { number: number }[];
    };
    expect(all.items.map((pr) => pr.number)).toEqual([1, 2, 3]);
    await started.stop();
  });
});
