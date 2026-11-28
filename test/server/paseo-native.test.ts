import { Hono } from 'hono';
import { expect, expectTypeOf, it, vi } from 'vitest';
import type { z } from 'zod';
import {
  type ReportInputs,
  type ReportOutputs,
  reportOperations,
} from '../../plugins/paseo-agent-productivity/shared/report-contracts.ts';
import { createPaseoNative, type NativeOperation } from '../../src/server/paseo-native.ts';
import type { HttpEnv } from '../../src/server/http/errors.ts';
import { createRunner } from '../../src/server/collectors/runner.ts';
import { upsertPullRequests } from '../../src/server/db/queries/prs.ts';
import { upsertSession } from '../../src/server/db/queries/usage.ts';
import { replaceComputedLinks } from '../../src/server/db/queries/links.ts';
import { createApp } from '../../src/server/http/app.ts';
import type { OverviewResponse } from '../../src/shared/contracts/overview.ts';
import type {
  EvidenceItem,
  PrDetailResponse,
  PrsResponse,
  RecordsResponse,
} from '../../src/shared/contracts/prs.ts';
import type { SeriesResponse, YearResponse } from '../../src/shared/contracts/series.ts';
import type { WorkReviewState } from '../../src/shared/contracts/work-review.ts';
import { RefreshRun } from '../../src/shared/contracts/sources.ts';
import type {
  ModelsResponse,
  UsageCategoriesResponse,
  UsageGroupsResponse,
  UsageRootsResponse,
} from '../../src/shared/contracts/usage.ts';
import { call as http, HOST, NOW, PORT, TZ, memoryDb, memoryLogger, testApp } from './helpers.ts';

const config = { host: '127.0.0.1', port: PORT } as const;

it('keeps the installed plugin report types aligned with the local API codecs', () => {
  type Operations = (typeof reportOperations)[number];
  type ApiOutputs = {
    overview: z.output<typeof OverviewResponse>;
    workReview: WorkReviewState;
    series: z.output<typeof SeriesResponse>;
    year: z.output<typeof YearResponse>;
    models: z.output<typeof ModelsResponse>;
    records: z.output<typeof RecordsResponse>;
    prs: z.output<typeof PrsResponse>;
    prDetail: z.output<typeof PrDetailResponse>;
    prLinkSet: z.output<typeof EvidenceItem>;
    prLinkRemove: null;
    usageCategories: z.output<typeof UsageCategoriesResponse>;
    usageGroups: z.output<typeof UsageGroupsResponse>;
    usageRoots: z.output<typeof UsageRootsResponse>;
    refresh: z.output<typeof RefreshRun>;
    refreshStatus: z.output<typeof RefreshRun>;
  };
  expectTypeOf<Operations>().toEqualTypeOf<keyof ReportInputs>();
  expectTypeOf<Operations>().toEqualTypeOf<keyof ReportOutputs>();
  expectTypeOf<Operations>().toExtend<NativeOperation>();
  expectTypeOf<ReportOutputs>().toExtend<ApiOutputs>();
  expectTypeOf<ApiOutputs>().toExtend<ReportOutputs>();
});

it('uses the same setup route and write guard inputs as the web dashboard', async () => {
  const finish = vi.fn();
  const app = new Hono<HttpEnv>();
  app.post('/api/setup/complete', async (c) => {
    finish(c.req.header('host'), c.req.header('x-agent-productivity-request'), await c.req.json());
    return c.json({ id: 7 }, 202);
  });
  const call = createPaseoNative({ server: { app }, config: { host: '127.0.0.1', port: 4317 } });
  await expect(call({ operation: 'finish' })).resolves.toEqual({ ok: true, data: { id: 7 } });
  expect(finish).toHaveBeenCalledExactlyOnceWith('127.0.0.1:4317', '1', {});
});

it('does not dispatch an unregistered operation or accept a route as an argument', async () => {
  const reset = vi.fn();
  const app = new Hono<HttpEnv>();
  app.post('/api/setup/reset', (c) => {
    reset();
    return c.json({});
  });
  const call = createPaseoNative({ server: { app }, config: { host: '127.0.0.1', port: 4317 } });
  for (const request of [
    { operation: 'reset' },
    { operation: 'workReviewGenerate' },
    { operation: 'workReview', parameters: { version: 0 } },
    { operation: 'workReview', parameters: { consent: true } },
    { operation: 'claudeHooks' },
    { operation: 'claudePlanCheck' },
    { operation: 'constructor' },
    { operation: 'repoRecheck', parameters: { id: '../setup/reset' } },
    { operation: 'refresh', parameters: { sources: ['claude_account'] } },
    { operation: 'refreshStatus', parameters: { runId: '../setup/reset' } },
    { operation: 'prDetail', parameters: { prId: '..' } },
    { operation: 'prLinkSet', parameters: { prId: 'PR_1', sessionId: 1, decision: 'restore' } },
    { operation: 'usageRoots', parameters: { groupKey: '__untracked', limit: 101 } },
    { operation: 'prs', parameters: { cursor: 'x'.repeat(5000) } },
    { operation: 'prs', parameters: { limit: 201 } },
    { operation: 'records', parameters: { limit: '1' } },
    { operation: 'models', parameters: { author: 'all' } },
    { operation: 'overview', parameters: { path: '/api/setup/reset' } },
    { operation: 'finish', parameters: { path: '/api/setup/reset' } },
  ]) {
    await expect(call(request)).resolves.toMatchObject({ ok: false, reason: 'invalid_input' });
  }
  expect(reset).not.toHaveBeenCalled();
});

it('uses the guarded report routes and their query filters', async () => {
  const { app, db } = testApp();
  try {
    const native = createPaseoNative({ server: { app }, config });
    const span = { start: '2026-11-02', end: '2026-11-04' };
    const range = 'start=2026-11-02&end=2026-11-04';
    const calls = [
      ['overview', { ...span, provider: 'codex' }, `/api/overview?${range}&provider=codex`],
      ['workReview', { ...span, provider: 'codex' }, `/api/work-review?${range}&provider=codex`],
      ['series', { ...span, gran: 'week' }, `/api/series?${range}&gran=week`],
      ['year', { author: 'all' }, '/api/year?author=all'],
      ['records', { ...span, limit: 1 }, `/api/records?${range}&limit=1`],
      ['models', { ...span, provider: 'claude' }, `/api/models?${range}&provider=claude`],
      [
        'prs',
        { ...span, linkClass: 'suggested', q: 'a&b', limit: 2 },
        `/api/prs?${range}&linkClass=suggested&q=a%26b&limit=2`,
      ],
      ['usageCategories', span, `/api/usage/categories?${range}`],
      ['usageGroups', span, `/api/usage/groups?${range}`],
      [
        'usageRoots',
        { ...span, groupKey: '__unknown', limit: 1 },
        `/api/usage/groups/__unknown/roots?${range}&limit=1`,
      ],
    ] as const;
    for (const [operation, parameters, path] of calls) {
      const response = await http(app, path, { headers: HOST });
      expect(response.status).toBe(200);
      await expect(native({ operation, parameters })).resolves.toEqual({
        ok: true,
        data: await response.json(),
      });
    }
    await expect(
      native({ operation: 'overview', parameters: { start: span.end, end: span.start } }),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid_range' });
    const otherHost = createPaseoNative({ server: { app }, config: { ...config, port: PORT + 1 } });
    await expect(otherHost({ operation: 'overview' })).resolves.toMatchObject({
      ok: false,
      reason: 'forbidden_origin',
    });
  } finally {
    db.close();
  }
});

it('uses raw encoded PR and group keys and applies owner decisions only through link routes', async () => {
  const { app, db } = testApp();
  try {
    const native = createPaseoNative({ server: { app }, config });
    const prId = 'legacy/PR+=';
    const groupKey = 'kelvin/app';
    db.prepare(
      `INSERT INTO repo (id, display_name, tracking_state, access_state, added_at, backfill_complete)
       VALUES (?, ?, 'active', 'ok', 0, 1)`,
    ).run(groupKey, groupKey);
    upsertPullRequests(db, [
      {
        nodeId: prId,
        repoId: groupKey,
        number: 1,
        title: 'Change',
        url: 'https://github.com/kelvin/app/pull/1',
        authorLogin: 'kelvin',
        mergedByLogin: 'kelvin',
        mergedAt: NOW,
        headRef: 'change',
        baseRef: 'main',
        mergeCommitSha: null,
        commits: [],
        commitsComplete: true,
      },
    ]);
    const prepareSession = (providerSessionId: string) =>
      upsertSession(db, {
        provider: 'codex',
        providerSessionId,
        kind: 'root',
        repoId: groupKey,
        startedAt: NOW - 1000,
        startedBasis: 'source_start',
        firstEventAt: NOW - 1000,
        lastEventAt: NOW,
      });
    const sessionId = prepareSession('example-session');
    const evidenceId = prepareSession('supporting-session');
    replaceComputedLinks(
      db,
      [
        { prNodeId: prId, sessionId, class: 'suggested', basis: 'same_repo_window' },
        { prNodeId: prId, sessionId: evidenceId, class: 'evidence', basis: 'pr_reference' },
      ],
      NOW,
    );
    const pair = { prId, sessionId };
    const detail = () => native({ operation: 'prDetail', parameters: { prId } });
    const set = (decision: string, id = sessionId) =>
      native({
        operation: 'prLinkSet',
        parameters: { ...pair, sessionId: id, decision },
      });
    const remove = (id = sessionId) =>
      native({ operation: 'prLinkRemove', parameters: { ...pair, sessionId: id } });
    await expect(detail()).resolves.toMatchObject({
      ok: true,
      data: {
        pr: { id: prId },
        evidence: [{ effectiveClass: 'evidence' }, { effectiveClass: 'suggested' }],
      },
    });
    await expect(set('confirmed')).resolves.toMatchObject({
      ok: true,
      data: { effectiveClass: 'owner' },
    });
    await expect(remove()).resolves.toEqual({ ok: true, data: null });
    await expect(set('rejected')).resolves.toMatchObject({ ok: false, reason: 'invalid_input' });
    await expect(set('rejected', evidenceId)).resolves.toMatchObject({
      ok: true,
      data: { effectiveClass: 'rejected' },
    });
    await expect(remove(evidenceId)).resolves.toEqual({ ok: true, data: null });
    await expect(set('dismissed')).resolves.toMatchObject({ ok: true, data: { actions: [] } });
    await expect(detail()).resolves.toMatchObject({
      ok: true,
      data: { evidence: [{ session: { id: evidenceId }, effectiveClass: 'evidence' }] },
    });
    await expect(
      native({ operation: 'usageRoots', parameters: { groupKey } }),
    ).resolves.toMatchObject({
      ok: true,
    });
  } finally {
    db.close();
  }
});

it('returns the active run ID when another guarded refresh is already running', async () => {
  const db = memoryDb();
  const { logger } = memoryLogger();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => (release = resolve));
  const runner = createRunner({
    db,
    logger,
    now: () => NOW,
    adapters: [],
    beforeSources: [{ name: 'waiting for test', run: () => waiting }],
  });
  const app = createApp({
    db,
    runner,
    logger,
    now: () => NOW,
    timezone: TZ,
    port: PORT,
    version: 'test',
    staticDir: null,
  });
  const native = createPaseoNative({ server: { app }, config });
  try {
    const started = await native({ operation: 'refresh', parameters: { sources: ['codex'] } });
    if (!started.ok) throw new Error(started.message);
    const running = RefreshRun.parse(started.data);
    expect(running.state).toBe('running');
    expect(Object.keys(running.sources)).toEqual(['codex']);
    const runId = running.id;
    await expect(native({ operation: 'refresh' })).resolves.toMatchObject({
      ok: false,
      reason: 'refresh_running',
      retryable: true,
      details: { runId },
    });
    await expect(
      native({ operation: 'refreshStatus', parameters: { runId } }),
    ).resolves.toMatchObject({
      ok: true,
      data: { id: runId },
    });
  } finally {
    release();
    await runner.idle();
    db.close();
  }
});

it('sends report fields and the refresh run ID without arbitrary handler data', async () => {
  const app = new Hono<HttpEnv>();
  app.get('/api/year', (c) =>
    c.json({
      start: '2026-01-01',
      today: '2026-11-04',
      counts: {},
      total: 0,
      daysWithMerge: 0,
      extra: 'outside the report contract',
    }),
  );
  app.post('/api/refresh', (c) =>
    c.json(
      {
        error: {
          code: 'refresh_running',
          message: 'A refresh is already running.',
          retryable: true,
          details: { runId: 2, extra: 'outside the native error contract' },
        },
      },
      409,
    ),
  );
  const native = createPaseoNative({ server: { app }, config });
  await expect(native({ operation: 'year' })).resolves.toEqual({
    ok: true,
    data: { start: '2026-01-01', today: '2026-11-04', counts: {}, total: 0, daysWithMerge: 0 },
  });
  await expect(native({ operation: 'refresh' })).resolves.toEqual({
    ok: false,
    reason: 'refresh_running',
    message: 'A refresh is already running.',
    retryable: true,
    details: { runId: 2 },
  });
});
