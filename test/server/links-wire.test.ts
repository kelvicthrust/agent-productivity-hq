import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { boot, type ListenFn } from '../../src/server/boot.ts';
import { createRunner } from '../../src/server/collectors/runner.ts';
import { replaceComputedLinks, writeSessionRefs } from '../../src/server/db/queries/links.ts';
import { setMeta } from '../../src/server/db/queries/meta.ts';
import { upsertPullRequests } from '../../src/server/db/queries/prs.ts';
import { createRun } from '../../src/server/db/queries/sources.ts';
import { upsertSession } from '../../src/server/db/queries/usage.ts';
import { createApp } from '../../src/server/http/app.ts';
import { recomputeLinks } from '../../src/server/services/links.ts';
import { RefreshRun } from '../../src/shared/contracts/sources.ts';
import { makeHome } from '../integration/import/helpers.ts';
import { HOST, NOW, PORT, TZ, WRITE, call, memoryDb, memoryLogger, tempConfig } from './helpers.ts';

// The link engine through createApp, guards on (G8_3, G8_4, G8_6, G8_8): the three routes are served, one PR's class is the same in
// the Delivery list, the PR's own detail, the Overview Linked PRs figure and the Usage tree, a PR with several sessions counts
// once everywhere, a decision moves all of them together, and a refresh recomputes the computed links and leaves every decision
// exactly as the routes wrote it. The browser spec (test/e2e/links.spec.ts) shows the same through the screens.

const HOUR = 3_600_000;
// This week (Mon Nov 2 to Sun Nov 8 in Los Angeles); the clock is Wed Nov 4, 12:00.
const MERGED = Date.parse('2026-11-03T20:00:00Z');

interface World {
  db: DatabaseSync;
  ids: { a: number; b: number; c: number; d: number; e: number };
}

/**
 * Four PRs of one tracked repo and five sessions with usage in the week:
 *   PR_1  session a (a PR reference) and session b (a commit): two evidence links, one PR
 *   PR_2  session c is suggested
 *   PR_3  session d is suggested
 *   PR_4  no session
 * Session e has no link at all.
 */
function world(): World {
  const db = memoryDb();
  // The connected GitHub login: Delivery's default author filter is "mine".
  setMeta(db, 'github_login', 'kelvin');
  db.prepare(
    `INSERT INTO repo (id, display_name, tracking_state, access_state, added_at, backfill_complete)
     VALUES ('kelvin/app', 'kelvin/app', 'active', 'ok', 0, 1)`,
  ).run();
  upsertPullRequests(
    db,
    [1, 2, 3, 4].map((n) => ({
      nodeId: `PR_${n}`,
      repoId: 'kelvin/app',
      number: n,
      title: `Change ${n}`,
      url: `https://github.com/kelvin/app/pull/${n}`,
      authorLogin: 'kelvin',
      mergedByLogin: 'kelvin',
      mergedAt: MERGED + n * HOUR,
      headRef: `feature/${n}`,
      baseRef: 'main',
      mergeCommitSha: null,
      commits: n === 1 ? ['1a2b3c4d5e6f7a8b9c0d'] : [`${n}${n}${n}${n}${n}${n}${n}aaaa`],
      commitsComplete: true,
    })),
  );
  const session = (key: string, minutesBeforeMerge: number): number => {
    const lastEventAt = MERGED - minutesBeforeMerge * 60_000;
    const id = upsertSession(db, {
      provider: 'claude',
      providerSessionId: `session-${key}`,
      kind: 'root',
      repoId: 'kelvin/app',
      startedAt: lastEventAt - HOUR,
      startedBasis: 'source_start',
      firstEventAt: lastEventAt - HOUR,
      lastEventAt,
    });
    db.prepare(
      `INSERT INTO usage_event (provider, dedupe_key, session_id, occurred_at, model, provider_total)
       VALUES ('claude', ?, ?, ?, 'claude-sonnet', 1000)`,
    ).run(`${key}:1`, id, lastEventAt);
    return id;
  };
  const ids = {
    a: session('a', 30),
    b: session('b', 40),
    c: session('c', 50),
    d: session('d', 60),
    e: session('e', 70),
  };
  writeSessionRefs(db, ids.a, [{ kind: 'pr_url', value: 'kelvin/app#1', observedAt: MERGED }]);
  writeSessionRefs(db, ids.b, [{ kind: 'commit', value: '1a2b3c4', observedAt: MERGED }]);
  replaceComputedLinks(
    db,
    [
      { prNodeId: 'PR_1', sessionId: ids.a, class: 'evidence', basis: 'pr_reference' },
      { prNodeId: 'PR_1', sessionId: ids.b, class: 'evidence', basis: 'commit_match' },
      { prNodeId: 'PR_2', sessionId: ids.c, class: 'suggested', basis: 'same_repo_window' },
      { prNodeId: 'PR_3', sessionId: ids.d, class: 'suggested', basis: 'same_branch' },
    ],
    NOW,
  );
  return { db, ids };
}

function appOver(db: DatabaseSync, withRecompute = false) {
  const { logger } = memoryLogger();
  const runner = createRunner({
    db,
    now: () => NOW,
    logger,
    adapters: [],
    ...(withRecompute
      ? { afterSources: [{ name: 'links', rebuild: (id) => void recomputeLinks(db, NOW, id) }] }
      : {}),
  });
  return createApp({
    db,
    logger,
    runner,
    port: PORT,
    now: () => NOW,
    timezone: TZ,
    version: '0.0.0-test',
    staticDir: null,
  });
}
type App = ReturnType<typeof appOver>;

// What the tests read back, typed only as far as they look: the contract test already holds the full shapes.
interface PrBody {
  id: string;
  linkClass: string;
  linkedSessionCount: number;
  suggestedCount: number;
}
interface EvidenceBody {
  session: { id: number };
  effectiveClass: string;
  sourceClass: string;
  actions: string[];
}
interface SessionBody {
  id: number;
  linkStatus: string;
  linkedPrs: { prId: string; number: number; class: string }[];
}
interface PrList {
  items: PrBody[];
  counts: Record<string, number>;
}
interface PrDetail {
  pr: PrBody;
  evidence: EvidenceBody[];
}
interface Overview {
  kpis: { linkedPrs: { value: number; of: number; suggestedOnly: number } };
}

const get = async <T>(app: App, path: string): Promise<{ status: number; body: T }> => {
  const response = await call(app as never, path, { headers: HOST });
  return { status: response.status, body: (await response.json()) as T };
};
const put = async (app: App, prId: string, sessionId: number, decision: string) => {
  const response = await call(app as never, `/api/prs/${prId}/links/${sessionId}`, {
    method: 'PUT',
    headers: WRITE,
    body: JSON.stringify({ decision }),
  });
  return { status: response.status, body: (await response.json()) as unknown };
};
const del = (app: App, prId: string, sessionId: number) =>
  call(app as never, `/api/prs/${prId}/links/${sessionId}`, { method: 'DELETE', headers: WRITE });

/** One PR's class as the surfaces say it. */
async function surfaces(app: App, prId: string) {
  const list = await get<PrList>(app, '/api/prs');
  const row = list.body.items.find((item) => item.id === prId);
  const detail = await get<PrDetail>(app, `/api/prs/${prId}`);
  return { list: row, detail: detail.body.pr, counts: list.body.counts };
}

describe('the routes are served behind the guards', () => {
  it('answers the detail, a decision and its undo, and refuses a write without the app header or from a stranger host', async () => {
    const { db, ids } = world();
    const app = appOver(db);
    expect((await get<unknown>(app, '/api/prs/PR_2')).status).toBe(200);
    expect((await put(app, 'PR_2', ids.c, 'confirmed')).status).toBe(200);
    expect((await del(app, 'PR_2', ids.c)).status).toBe(204);

    const noHeader = await call(app as never, `/api/prs/PR_2/links/${ids.c}`, {
      method: 'PUT',
      headers: { ...HOST, 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'confirmed' }),
    });
    expect(noHeader.status).toBe(403);
    const stranger = await call(app as never, '/api/prs/PR_2', {
      headers: { host: 'evil.example:80' },
    });
    expect(stranger.status).toBe(421);
    expect((await get<unknown>(app, '/api/prs/PR_NOPE')).status).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS n FROM owner_link_decision').get()).toEqual({ n: 0 });
  });
});

describe('one rule: Delivery, the PR detail, Overview and the Usage tree agree on every link', () => {
  it('shows each PR with the class of its strongest effective link, once, however many sessions link to it', async () => {
    const { db } = world();
    const app = appOver(db);
    const list = await get<PrList>(app, '/api/prs');
    const byId = new Map(list.body.items.map((item) => [item.id, item]));
    expect(byId.get('PR_1')).toMatchObject({
      linkClass: 'evidence',
      linkedSessionCount: 2,
      suggestedCount: 0,
    });
    expect(byId.get('PR_2')).toMatchObject({
      linkClass: 'suggested',
      linkedSessionCount: 0,
      suggestedCount: 1,
    });
    expect(byId.get('PR_3')).toMatchObject({ linkClass: 'suggested' });
    expect(byId.get('PR_4')).toMatchObject({ linkClass: 'unlinked', linkedSessionCount: 0 });
    // four PRs, each in exactly one tab
    expect(list.body.counts).toEqual({
      all: 4,
      evidence: 1,
      owner: 0,
      suggested: 2,
      unlinked: 1,
    });

    // Overview: Linked PRs counts distinct PRs with an evidence or owner link; suggestions are reported apart
    const overview = await get<Overview>(app, '/api/overview');
    expect(overview.body.kpis.linkedPrs).toMatchObject({ value: 1, of: 4, suggestedOnly: 2 });
    // and no PR shape carries tokens: they are never allocated to a PR (G8_8)
    for (const item of list.body.items) expect(Object.keys(item)).not.toContain('tokens');
    expect(JSON.stringify(list.body)).not.toMatch(/"tokens"/);
  });

  it('moves all four together when the owner decides, and back again on Undo', async () => {
    const { db, ids } = world();
    const app = appOver(db);

    // Confirm a suggestion: the PR is now linked (owner), in every place that says so
    expect((await put(app, 'PR_2', ids.c, 'confirmed')).status).toBe(200);
    let s = await surfaces(app, 'PR_2');
    expect(s.list).toMatchObject({ linkClass: 'owner', linkedSessionCount: 1, suggestedCount: 0 });
    expect(s.detail).toEqual(s.list);
    expect(s.counts).toEqual({ all: 4, evidence: 1, owner: 1, suggested: 1, unlinked: 1 });
    expect((await get<Overview>(app, '/api/overview')).body.kpis.linkedPrs).toMatchObject({
      value: 2,
      of: 4,
      suggestedOnly: 1,
    });
    // the tab keeps the PR: the owner tab lists it and the suggested tab does not
    const owner = await get<PrList>(app, '/api/prs?linkClass=owner');
    expect(owner.body.items.map((i) => i.id)).toEqual(['PR_2']);
    const suggested = await get<PrList>(app, '/api/prs?linkClass=suggested');
    expect(suggested.body.items.map((i) => i.id)).toEqual(['PR_3']);

    // Mark one of PR_1's two evidence links incorrect: the PR stays evidence on the other, still counted once
    await put(app, 'PR_1', ids.a, 'rejected');
    s = await surfaces(app, 'PR_1');
    expect(s.list).toMatchObject({ linkClass: 'evidence', linkedSessionCount: 1 });
    expect(s.detail).toEqual(s.list);
    // ... and the other one too: now nothing links it
    await put(app, 'PR_1', ids.b, 'rejected');
    s = await surfaces(app, 'PR_1');
    expect(s.list).toMatchObject({ linkClass: 'unlinked', linkedSessionCount: 0 });
    expect(s.detail).toEqual(s.list);
    expect((await get<Overview>(app, '/api/overview')).body.kpis.linkedPrs).toMatchObject({
      value: 1,
      of: 4,
    });

    // Undo both: back to evidence
    await del(app, 'PR_1', ids.a);
    await del(app, 'PR_1', ids.b);
    s = await surfaces(app, 'PR_1');
    expect(s.list).toMatchObject({ linkClass: 'evidence', linkedSessionCount: 2 });
    expect(s.detail).toEqual(s.list);
  });

  it('puts the same link, with the same class, on the PR and on the session in the Usage tree', async () => {
    const { db, ids } = world();
    const app = appOver(db);
    await put(app, 'PR_2', ids.c, 'confirmed');
    const groups = await get<{ groups: { key: string; label: string }[] }>(
      app,
      '/api/usage/groups',
    );
    const key = groups.body.groups.find((g) => g.label === 'kelvin/app')!.key;
    const roots = await get<{ roots: SessionBody[] }>(
      app,
      `/api/usage/groups/${encodeURIComponent(key)}/roots`,
    );
    const sessions = new Map(roots.body.roots.map((root) => [root.id, root]));

    // the confirmed session lists PR 2 as Owner-confirmed; the evidence sessions list PR 1 as an Evidence link; a suggested one is Suggested
    expect(sessions.get(ids.c)).toMatchObject({ linkStatus: 'linked' });
    expect(sessions.get(ids.c)?.linkedPrs).toEqual([
      expect.objectContaining({ prId: 'PR_2', number: 2, class: 'owner' }),
    ]);
    expect(sessions.get(ids.a)?.linkedPrs).toEqual([
      expect.objectContaining({ prId: 'PR_1', class: 'evidence' }),
    ]);
    expect(sessions.get(ids.d)?.linkedPrs).toEqual([
      expect.objectContaining({ prId: 'PR_3', class: 'suggested' }),
    ]);
    // a tracked, collected session with no link says Unlinked (the only state that may)
    expect(sessions.get(ids.e)).toMatchObject({ linkStatus: 'unlinked', linkedPrs: [] });

    // dismissed and marked incorrect leave the tree, and the session is then Unlinked
    await put(app, 'PR_3', ids.d, 'dismissed');
    await put(app, 'PR_1', ids.a, 'rejected');
    const after = await get<{ roots: SessionBody[] }>(
      app,
      `/api/usage/groups/${encodeURIComponent(key)}/roots`,
    );
    const next = new Map(after.body.roots.map((root) => [root.id, root]));
    expect(next.get(ids.d)).toMatchObject({ linkStatus: 'unlinked', linkedPrs: [] });
    expect(next.get(ids.a)).toMatchObject({ linkStatus: 'unlinked', linkedPrs: [] });
    // and the PR keeps the item, struck through, with the source claim kept
    const detail = await get<PrDetail>(app, '/api/prs/PR_1');
    const struck = detail.body.evidence.find((item) => item.session.id === ids.a);
    expect(struck).toMatchObject({
      effectiveClass: 'rejected',
      sourceClass: 'evidence',
      actions: ['restore'],
    });
  });
});

describe('a refresh recomputes the computed links and never touches a decision', () => {
  it('through the real runner: the decision rows are byte for byte what the routes wrote, and the computed table is rebuilt from the identifiers', async () => {
    const { db, ids } = world();
    const app = appOver(db, true);
    await put(app, 'PR_2', ids.c, 'confirmed');
    await put(app, 'PR_1', ids.a, 'rejected');
    await put(app, 'PR_3', ids.d, 'dismissed');
    const decisions = db
      .prepare('SELECT * FROM owner_link_decision ORDER BY pr_node_id, session_id')
      .all();
    expect(decisions).toHaveLength(3);

    const started = await call(app as never, '/api/refresh', {
      method: 'POST',
      headers: WRITE,
      body: '{}',
    });
    expect(started.status).toBe(202);
    for (let waited = 0; waited < 5_000; waited += 10) {
      const run = (await (
        await call(
          app as never,
          `/api/refresh/${((await started.clone().json()) as { id: number }).id}`,
          { headers: HOST },
        )
      ).json()) as { state: string };
      if (run.state !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(
      db.prepare('SELECT * FROM owner_link_decision ORDER BY pr_node_id, session_id').all(),
    ).toEqual(decisions);
    // rebuilt from what the sessions named: the PR reference and the commit are evidence again; the world's hand-written
    // suggestions are replaced by what the 48 h rule says (every same-repo session active in the window, at most three a PR)
    const computed = db
      .prepare(
        "SELECT pr_node_id, session_id, class, basis FROM pr_session_link WHERE class = 'evidence' ORDER BY session_id",
      )
      .all();
    expect(computed).toEqual([
      { pr_node_id: 'PR_1', session_id: ids.a, class: 'evidence', basis: 'pr_reference' },
      { pr_node_id: 'PR_1', session_id: ids.b, class: 'evidence', basis: 'commit_match' },
    ]);
    // and the owner's say still holds over the rebuilt table
    const s = await surfaces(app, 'PR_2');
    expect(s.list).toMatchObject({ linkClass: 'owner' });
    const rejected = (await get<PrDetail>(app, '/api/prs/PR_1')).body.evidence;
    expect(rejected.find((item) => item.session.id === ids.a)).toMatchObject({
      effectiveClass: 'rejected',
    });
  });
});

describe('the real process recomputes the links after every refresh, and the preview does not', () => {
  const listen: ListenFn = async () => ({ close: (callback) => callback?.() });
  const MERGED_AT = Date.parse('2026-10-13T12:00:00Z');
  const CLAUDE_FILE =
    '.claude/projects/-fixture-SENTINEL_CWD_d4e5f6-lib/33333333-cccc-4ccc-8ccc-000000000003.jsonl';

  function homeWithEvidence() {
    const home = makeHome();
    appendFileSync(
      join(home, CLAUDE_FILE),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-10-13T09:05:00.000Z',
        sessionId: '33333333-cccc-4ccc-8ccc-000000000003',
        message: {
          role: 'user',
          content: 'SENTINEL_PROMPT_body see https://github.com/Kelvin/Lib/pull/12',
        },
      }) + '\n',
    );
    return home;
  }

  /** A refresh through the booted app, waited for. */
  async function refreshed(app: { fetch: (request: Request) => Response | Promise<Response> }) {
    const started = await call(app as never, '/api/refresh', {
      method: 'POST',
      headers: WRITE,
      body: '{}',
    });
    const { id } = (await started.json()) as { id: number };
    for (let waited = 0; waited < 10_000; waited += 10) {
      const run = RefreshRun.parse(
        await (await call(app as never, `/api/refresh/${id}`, { headers: HOST })).json(),
      );
      if (run.state !== 'running') return run;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('the run did not end');
  }

  const addPr = (db: DatabaseSync) => {
    db.prepare(
      `INSERT INTO repo (id, display_name, tracking_state, access_state, added_at, backfill_complete)
       VALUES ('kelvin/lib', 'kelvin/lib', 'active', 'ok', 0, 1)`,
    ).run();
    upsertPullRequests(db, [
      {
        nodeId: 'PR_lib_12',
        repoId: 'kelvin/lib',
        number: 12,
        title: 'Fix the lib',
        url: 'https://github.com/kelvin/lib/pull/12',
        authorLogin: 'kelvin',
        mergedByLogin: 'kelvin',
        mergedAt: MERGED_AT,
        headRef: 'feature/links',
        baseRef: 'main',
        mergeCommitSha: null,
        commits: ['1a2b3c4d5e6f7a8b9c0d'],
        commitsComplete: true,
      },
    ]);
  };

  it('keeps the last computed links and their health across a failed rebuild and a restart', async () => {
    const config = tempConfig();
    let now = NOW;
    const options = {
      logger: memoryLogger().logger,
      listen,
      now: () => now,
      timezone: TZ,
      scheduler: false,
      local: { env: {}, home: homeWithEvidence() },
    };
    let server = await boot(config, options);
    const expectedHealth = async (state: string, lastSuccessfulAt: string | null) => {
      for (const path of ['/api/overview', '/api/prs']) {
        const { body } = await get<{ linkHealth: unknown }>(server.app, path);
        expect(body.linkHealth).toEqual({ state, lastSuccessfulAt });
      }
    };
    try {
      addPr(server.db!);
      await expectedHealth('unavailable', null);

      const first = await refreshed(server.app);
      expect(first).toMatchObject({ state: 'succeeded', linkRebuild: 'succeeded' });
      await expectedHealth('fresh', new Date(NOW).toISOString());
      const computed = () => server.db!.prepare('SELECT * FROM pr_session_link').all();
      const oldLinks = computed();
      expect(oldLinks.length).toBeGreaterThan(0);

      server.db!.exec(`CREATE TRIGGER fail_link_rebuild BEFORE INSERT ON pr_session_link
        BEGIN SELECT RAISE(ABORT, 'scripted link rebuild failure'); END`);
      now += HOUR;
      server.db!.exec("UPDATE pull_request SET title = 'Edited title' WHERE node_id = 'PR_lib_12'");
      const unchanged = await refreshed(server.app);
      expect(unchanged).toMatchObject({ state: 'succeeded', linkRebuild: null });
      expect(computed()).toEqual(oldLinks);
      await expectedHealth('fresh', new Date(NOW).toISOString());

      server.db!.exec(
        "UPDATE pull_request SET head_ref = 'feature/changed' WHERE node_id = 'PR_lib_12'",
      );
      await expectedHealth('stale', new Date(NOW).toISOString());
      const failed = await refreshed(server.app);
      expect(failed).toMatchObject({ state: 'partial', linkRebuild: 'failed' });
      expect(computed()).toEqual(oldLinks);
      await expectedHealth('stale', new Date(NOW).toISOString());

      const interrupted = createRun(server.db!, {
        trigger: 'manual',
        startedAt: now,
        sources: {},
        rebuildLinks: true,
      });
      await server.shutdown();
      server = await boot(config, options);
      await expectedHealth('stale', new Date(NOW).toISOString());
      expect(computed()).toEqual(oldLinks);
      expect(
        (await get<RefreshRun>(server.app, `/api/refresh/${failed.id}`)).body.linkRebuild,
      ).toBe('failed');
      expect((await get<RefreshRun>(server.app, `/api/refresh/${interrupted}`)).body).toMatchObject(
        {
          state: 'interrupted',
          linkRebuild: 'interrupted',
        },
      );

      server.db!.exec('DROP TRIGGER fail_link_rebuild');
      const retried = await refreshed(server.app);
      expect(retried.linkRebuild).toBe('succeeded');
      await expectedHealth('fresh', new Date(now).toISOString());
    } finally {
      await server.shutdown();
    }
  });

  it('a process that has this machine links a session to the PR it named, and logs only counts', async () => {
    const { logger, entries } = memoryLogger('debug');
    const server = await boot(tempConfig(), {
      logger,
      listen,
      now: () => NOW,
      timezone: TZ,
      scheduler: false,
      local: { env: {}, home: homeWithEvidence() },
    });
    addPr(server.db!);

    const run = await refreshed(server.app);
    expect(run.state).toBe('succeeded');
    expect(
      server.db!.prepare('SELECT pr_node_id, class, basis FROM pr_session_link').all(),
    ).toEqual([{ pr_node_id: 'PR_lib_12', class: 'evidence', basis: 'pr_reference' }]);
    const recomputed = entries.find((entry) => entry['msg'] === 'links recomputed');
    expect(recomputed).toMatchObject({ source: 'links' });
    expect(JSON.stringify(entries)).not.toMatch(/SENTINEL_PROMPT|Kelvin\/Lib/);
    await server.shutdown();
  });

  it('a process with scripted adapters (the preview, the browser specs) keeps the links its world was written with', async () => {
    const server = await boot(tempConfig(), {
      logger: memoryLogger().logger,
      listen,
      now: () => NOW,
      timezone: TZ,
      scheduler: false,
      adapters: [],
    });
    addPr(server.db!);
    const session = upsertSession(server.db!, {
      provider: 'claude',
      providerSessionId: 'session-x',
      kind: 'root',
      repoId: 'kelvin/lib',
      startedAt: MERGED_AT - 2 * HOUR,
      startedBasis: 'source_start',
      firstEventAt: MERGED_AT - 2 * HOUR,
      lastEventAt: MERGED_AT - HOUR,
    });
    server
      .db!.prepare(
        `INSERT INTO usage_event (provider, dedupe_key, session_id, occurred_at, model, provider_total)
         VALUES ('claude', 'x:1', ?, ?, 'claude-sonnet', 1000)`,
      )
      .run(session, MERGED_AT - HOUR);
    // a hand-written link no recompute would produce: the session has no reference and no commit
    replaceComputedLinks(
      server.db!,
      [{ prNodeId: 'PR_lib_12', sessionId: session, class: 'evidence', basis: 'pr_reference' }],
      NOW,
    );

    await refreshed(server.app);
    expect(
      server.db!.prepare('SELECT pr_node_id, class, basis FROM pr_session_link').all(),
    ).toEqual([{ pr_node_id: 'PR_lib_12', class: 'evidence', basis: 'pr_reference' }]);
    await server.shutdown();
  });
});
