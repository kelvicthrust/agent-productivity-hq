import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { WorkReviewState } from '../../src/shared/contracts/work-review.ts';
import { boot, REFRESH_INTERVAL_MS } from '../../src/server/boot.ts';
import type { NetFetch } from '../../src/server/collectors/github/ports.ts';
import { WORK_REVIEW_MODELS_URL, WORK_REVIEW_RESPONSES_URL } from '../../src/server/lib/net.ts';
import { setMeta } from '../../src/server/db/queries/meta.ts';
import { upsertPullRequests } from '../../src/server/db/queries/prs.ts';
import { workReviewKeyring } from '../../src/server/services/work-review/keyring.ts';
import { createWorkReviewWorker } from '../../src/server/services/work-review/worker.ts';
import { createWorkReviewService } from '../../src/server/services/work-review/service.ts';
import { createMemoryKeyring } from '../fixtures/github/scripted-github.ts';
import { gate, scriptedAdapter, succeeds } from '../fixtures/scripted-adapters/scripted.ts';
import {
  call,
  HOST,
  memoryDb,
  memoryLogger,
  NOW,
  tempConfig,
  tempDir,
  testApp,
  TZ,
  WRITE,
} from '../server/helpers.ts';
import { addEvent, addRepo, addSession } from '../server/usage/helpers.ts';

function modelResponse(result: unknown) {
  return new Response(
    'data: ' +
      JSON.stringify({
        type: 'response.completed',
        response: {
          model: 'gpt-6-luna',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: JSON.stringify(result) }],
            },
          ],
        },
      }) +
      '\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

it('generates a cited non-PR update from a mixed imported session through the normal HTTP path', async () => {
  const home = tempDir();
  const root = join(home, '.claude', 'projects', 'example');
  mkdirSync(root, { recursive: true });
  const source = join(root, 'local-pilot.jsonl');
  const message = (type: string, content: unknown) =>
    JSON.stringify({
      type,
      sessionId: 'local-pilot',
      timestamp: new Date(NOW - 1000).toISOString(),
      message: { role: type, content },
    });
  const body =
    [
      message('user', 'Look into flaky cursor handling in the import job.'),
      message('assistant', [
        {
          type: 'text',
          text: 'Tracing the parser located a cursor reset when the importer resumes after interruption.',
        },
      ]),
      message('user', 'What should I cook for dinner?'),
      message('user', [{ type: 'tool_result', content: 'PRIVATE_TOOL_OUTPUT' }]),
    ].join('\n') + '\n';
  writeFileSync(source, body);
  const db = memoryDb();
  setMeta(db, 'setup_completed_at', '1');
  addSession(db, {
    id: 1,
    provider: 'claude',
    psid: 'local-pilot',
    startedAt: NOW - 10_000,
    kind: 'root',
  });
  addEvent(db, { session: 1, at: NOW - 1000 });
  db.prepare(
    "INSERT INTO source_file(id,source_id,path,size,mtime_ms,head_hash,read_offset,state) VALUES(1,'claude',?,?,1,?,?,'ok')",
  ).run(
    source,
    Buffer.byteLength(body),
    createHash('sha256').update(body).digest('hex'),
    Buffer.byteLength(body),
  );
  db.exec('UPDATE usage_event SET source_file_id=1');
  const requests: string[] = [];
  const note = 'I traced an import failure to its checkpoint logic.';
  const net: NetFetch = async (url, init) => {
    if (url === WORK_REVIEW_MODELS_URL)
      return Response.json({ models: [{ slug: 'gpt-6-luna', visibility: 'list' }] });
    expect(url).toBe(WORK_REVIEW_RESPONSES_URL);
    const payload = JSON.parse(init!.body!) as { input: { content: string }[] };
    const input = payload.input[0]!.content;
    requests.push(input);
    const result =
      requests.length === 1
        ? { notes: [{ kind: 'progress', text: note }] }
        : {
            headline: 'I found why import retries lose their position.',
            ids: ['0'],
            bullets: [{ kind: 'progress', text: note, ids: ['0'] }],
          };
    return modelResponse(result);
  };
  const service = createWorkReviewService({
    db,
    now: () => NOW,
    timezone: TZ,
    local: { home, env: {} },
    worker: createWorkReviewWorker({
      net,
      accessToken: async () => 'synthetic.oauth.grant',
      invalidateAccessToken: async () => {},
    }),
  });
  const { app, entries } = testApp({ db, workReview: service });
  const generate = () =>
    call(app, '/api/work-review/generate', {
      method: 'POST',
      headers: WRITE,
      body: JSON.stringify({ consent: true }),
    });
  expect((await generate()).status).toBe(202);
  await service.idle();
  const report = WorkReviewState.parse(
    await (await call(app, '/api/work-review', { headers: HOST })).json(),
  );
  expect(report.status, report.message ?? '').toBe('idle');
  expect(requests).toHaveLength(2);
  expect(requests[0]).toContain('cook for dinner');
  expect(requests[0]).not.toContain('PRIVATE_TOOL_OUTPUT');
  expect(requests[1]).toContain(note);
  expect(requests[1]).not.toContain('dinner');
  expect(report.review?.bullets).toMatchObject([
    { kind: 'progress', evidence: [{ kind: 'session', id: '1', notes: [note] }] },
  ]);
  const stored = JSON.stringify([
    db.prepare('SELECT * FROM work_review_note').all(),
    db.prepare('SELECT * FROM work_review_version').all(),
    entries,
  ]);
  for (const privateText of [
    'cook for dinner',
    'Look into flaky',
    'Tracing the parser',
    'PRIVATE_TOOL_OUTPUT',
    'synthetic.oauth.grant',
  ])
    expect(stored).not.toContain(privateText);
  expect((await generate()).status).toBe(200);
  expect(requests).toHaveLength(2);
  db.close();
});

it('boot schedules opted-in Work Review after the source refresh finishes', async () => {
  const config = tempConfig();
  const keyring = createMemoryKeyring();
  const releaseImport = gate();
  const adapter = scriptedAdapter('github', [
    async ({ db }) => {
      await releaseImport.promise;
      upsertPullRequests(db, [
        {
          nodeId: 'scheduled-pr',
          repoId: 'me/app',
          number: 5,
          title: 'Repair import retries',
          url: 'https://github.com/me/app/pull/5',
          authorLogin: 'me',
          mergedByLogin: 'me',
          mergedAt: NOW,
          headRef: null,
          baseRef: null,
          mergeCommitSha: null,
          commits: [],
          commitsComplete: true,
        },
      ]);
      return succeeds({ imported: 1 });
    },
  ]);
  const modelNet = vi.fn<NetFetch>(async (url, init) => {
    if (url === WORK_REVIEW_MODELS_URL)
      return Response.json({ models: [{ slug: 'gpt-6-luna', visibility: 'list' }] });
    expect(url).toBe(WORK_REVIEW_RESPONSES_URL);
    expect(init?.body).toContain('Repair import retries');
    return modelResponse({
      headline: 'I fixed a retry issue in the importer.',
      ids: ['0'],
      bullets: [],
    });
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(NOW);
  let server: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    server = await boot(config, {
      timezone: TZ,
      adapters: [adapter],
      logger: memoryLogger().logger,
      listen: async () => ({ close: (done) => done?.() }),
      workReview: { keyring, modelNet, authNet: vi.fn() },
    });
    const db = server.db!;
    setMeta(db, 'setup_completed_at', '1');
    setMeta(db, 'github_login', 'me');
    addRepo(db, 'me/app');
    workReviewKeyring(db, keyring).set(
      'agent-productivity-work-review',
      createHash('sha256').update(config.dataDir).digest('hex'),
      JSON.stringify({
        hostId: 'urn:uuid:12345678-1234-1234-1234-123456789abc',
        profile: { clientId: 'oaiapp_fixture', subject: 'fixture-owner', email: null },
        credentials: {
          access: 'synthetic-test-grant',
          refresh: null,
          accessExpiresAt: NOW + 24 * 3_600_000,
          refreshExpiresAt: NOW + 24 * 3_600_000,
          scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'],
        },
      }),
    );
    const optedIn = await call(server.app, '/api/work-review/automation', {
      method: 'POST',
      headers: WRITE,
      body: JSON.stringify({ enabled: true }),
    });
    expect(optedIn.status).toBe(200);
    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    expect(adapter.calls).toBe(1);
    expect(modelNet).not.toHaveBeenCalled();

    releaseImport.release();
    await vi.advanceTimersByTimeAsync(1);
    const report = await call(server.app, '/api/work-review', { headers: HOST });
    expect(WorkReviewState.parse(await report.json()).review).toMatchObject({
      version: 1,
      headlineEvidence: [{ id: 'scheduled-pr', kind: 'pr' }],
    });
    expect(modelNet).toHaveBeenCalledTimes(2); // Catalog read and summary.
  } finally {
    releaseImport.release();
    await server?.shutdown();
    vi.useRealTimers();
  }
});
