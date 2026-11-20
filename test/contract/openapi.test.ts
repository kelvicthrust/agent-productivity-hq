import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  COMPONENTS,
  ErrorEnvelope,
  ROUTES,
  routeKey,
  type RouteContract,
} from '../../src/shared/contracts/index.ts';
import { servedRoutes } from '../../src/server/http/app.ts';
import { resolveScope } from '../../src/shared/domain/scope.ts';
import { claudePlanProfile } from '../../src/server/integrations/claudePlan/credentials.ts';
import { createClaudeCapture } from '../../src/server/integrations/claudeCapture/index.ts';
import { createGithubAccounts } from '../../src/server/services/accounts-github.ts';
import { createClaudeAccounts } from '../../src/server/services/claude-account.ts';
import { createHookStore } from '../../src/server/services/hq/hookStore.ts';
import { rig } from '../claudeHooks/helpers.ts';
import { upsertPullRequests } from '../../src/server/db/queries/prs.ts';
import { upsertSession } from '../../src/server/db/queries/usage.ts';
import { createFakeGithub, createMemoryKeyring } from '../fixtures/github/scripted-github.ts';
import { HOST, NOW, WRITE, call, memoryDb, tempDir, testApp } from '../server/helpers.ts';
import { PENDING_ROUTES } from './pending.ts';
import { canon, differences, resolveRef, zodJson, type Canon } from './canon.ts';

// docs/tech/local-api.md is the reviewable copy of the API; src/shared/contracts is the code. This test reads the
// document's OpenAPI block and fails when they disagree about a route, a parameter, a request or response shape, or a
// named schema. Routes the server does not serve yet are listed in pending.ts, and that list must match what the app
// really serves.

type Json = Record<string, unknown>;
const text = readFileSync(join(import.meta.dirname, '../../docs/tech/local-api.md'), 'utf8');
const blocks = [...text.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!);
const doc = parse(blocks[0]!) as Json;
const extra = parse(blocks[1]!) as Record<string, Json>;
(doc['components'] as { schemas: Json }).schemas = {
  ...(doc['components'] as { schemas: Json }).schemas,
  ...extra,
};

const paths = doc['paths'] as Record<string, Record<string, Json>>;
const METHODS = ['get', 'put', 'post', 'delete'];
const docRoutes = Object.entries(paths).flatMap(([path, ops]) =>
  Object.keys(ops)
    .filter((m) => METHODS.includes(m))
    .map((method) => ({ method: method as RouteContract['method'], path })),
);
const docKey = (r: { method: string; path: string }) => `${r.method.toUpperCase()} ${r.path}`;
const sort = (xs: string[]) => [...xs].sort();

const docSchemaCanon = (schema: Json): Canon => canon(schema, doc);
const codeCanon = (schema: z.ZodType, io: 'input' | 'output' = 'output') =>
  canon(zodJson(schema, io), {});

const operation = (route: Pick<RouteContract, 'method' | 'path'>) =>
  paths[route.path]![route.method]!;
const responseSchema = (response: Json): Json | null => {
  const resolved =
    typeof response['$ref'] === 'string' ? resolveRef(response['$ref'], doc) : response;
  const content = resolved['content'] as Record<string, { schema: Json }> | undefined;
  return content?.['application/json']?.schema ?? null;
};

describe('the document and the code describe the same routes', () => {
  it('the OpenAPI block has one contract per operation', () => {
    expect(docRoutes).toHaveLength(ROUTES.length);
    expect(sort(ROUTES.map(routeKey))).toEqual(sort(docRoutes.map(docKey)));
    expect(new Set(ROUTES.map(routeKey)).size).toBe(ROUTES.length);
  });

  it('every non-GET route is marked csrf in the code and carries X-Agent-Productivity-Request in the document, and no GET does', () => {
    for (const route of ROUTES) {
      const params = (operation(route)['parameters'] as Json[] | undefined) ?? [];
      const hasHeader = params.some(
        (p) => p['name'] === 'X-Agent-Productivity-Request' && p['in'] === 'header',
      );
      expect(route.csrf, routeKey(route)).toBe(route.method !== 'get');
      expect(hasHeader, routeKey(route)).toBe(route.csrf);
    }
  });
});

describe('named schemas', () => {
  const documented = (doc['components'] as { schemas: Record<string, Json> }).schemas;

  it('every documented schema has a code schema of the same name, and the reverse', () => {
    expect(sort(Object.keys(COMPONENTS))).toEqual(sort(Object.keys(documented)));
  });

  it.each(Object.keys(COMPONENTS))('%s matches the document', (name) => {
    const code = codeCanon(COMPONENTS[name as keyof typeof COMPONENTS] as z.ZodType);
    const docc = docSchemaCanon(documented[name]!);
    expect(differences(code, docc, name)).toEqual([]);
  });
});

describe('each route: parameters, request body and responses', () => {
  const docParams = (route: RouteContract) => {
    const out = new Map<string, Canon>();
    for (const raw of (operation(route)['parameters'] as Json[] | undefined) ?? []) {
      const p = typeof raw['$ref'] === 'string' ? resolveRef(raw['$ref'], doc) : raw;
      if (p['in'] === 'header') continue;
      out.set(`${p['in'] as string}:${p['name'] as string}`, docSchemaCanon(p['schema'] as Json));
      if (p['in'] === 'path')
        expect(p['required'], `${routeKey(route)} path param ${p['name'] as string}`).toBe(true);
    }
    return out;
  };

  it.each(ROUTES.map((r) => [routeKey(r), r] as const))('%s', (_key, route) => {
    // parameters: same names, same shapes
    const fromDoc = docParams(route);
    const fromCode = new Map<string, Canon>();
    for (const [name, schema] of Object.entries(route.params ?? {}))
      fromCode.set(`path:${name}`, codeCanon(schema, 'input'));
    for (const [name, schema] of Object.entries(route.query ?? {}))
      fromCode.set(`query:${name}`, codeCanon(schema, 'input'));
    expect(sort([...fromCode.keys()])).toEqual(sort([...fromDoc.keys()]));
    for (const [key, shape] of fromCode)
      expect(differences(shape, fromDoc.get(key)!, key)).toEqual([]);

    // request body
    const requestBody = operation(route)['requestBody'] as Json | undefined;
    expect(!!route.body).toBe(!!requestBody);
    if (route.body && requestBody) {
      expect(route.body.required).toBe(requestBody['required'] === true);
      const schema = responseSchema(requestBody)!;
      expect(
        differences(codeCanon(route.body.schema, 'input'), docSchemaCanon(schema), 'body'),
      ).toEqual([]);
    }

    // responses: same statuses, same shapes
    const docResponses = operation(route)['responses'] as Record<string, Json>;
    expect(sort(Object.keys(route.responses))).toEqual(sort(Object.keys(docResponses)));
    for (const [status, schema] of Object.entries(route.responses)) {
      const documentedSchema = responseSchema(docResponses[status]!);
      if (schema === null) expect(documentedSchema, `${status} has no body`).toBeNull();
      else {
        expect(documentedSchema, `${status} has a body`).not.toBeNull();
        expect(differences(codeCanon(schema), docSchemaCanon(documentedSchema!), status)).toEqual(
          [],
        );
      }
    }
  });
});

describe('what the server serves against the document', () => {
  const all = ROUTES.map(routeKey);
  const hookToken = 'c'.repeat(43);
  const hookIngest = { store: createHookStore({ now: () => NOW }), token: hookToken };
  const { app } = testApp({ hookIngest });
  const served = servedRoutes(app);

  it('serves only routes the contracts describe', () => {
    for (const key of served) expect(all, key).toContain(key);
  });

  it('PENDING_ROUTES is exactly the described routes the server does not serve', () => {
    expect(sort([...PENDING_ROUTES])).toEqual(sort(all.filter((key) => !served.includes(key))));
    expect(new Set(PENDING_ROUTES).size).toBe(PENDING_ROUTES.length);
  });

  // The served set is pinned on purpose: building a route means updating this list and PENDING_ROUTES together.
  it('serves exactly the routes built so far: health and bootstrap (M2); the repo list, usage, sources and refresh (M4); the GitHub account routes, repo writes, PRs and year (M6); overview, series, records and models (M7); the evidence of a PR and the owner link decisions (M8); the Claude plan-usage capture (M9); first-launch Setup (M10); the live HQ roster (HQ M0); the Claude Code hooks switch and its loopback endpoint (HQ hooks)', () => {
    expect(served).toEqual([
      'DELETE /api/prs/{prId}/links/{sessionId}',
      'DELETE /api/repos/{owner}/{name}',
      'GET /api/accounts/claude/usage-capture/preview',
      'GET /api/accounts/{account}/connect/{loginId}',
      'GET /api/bootstrap',
      'GET /api/health',
      'GET /api/hq',
      'GET /api/hq/claude-hooks',
      'GET /api/models',
      'GET /api/overview',
      'GET /api/prs',
      'GET /api/prs/{prId}',
      'GET /api/records',
      'GET /api/refresh/{runId}',
      'GET /api/repos',
      'GET /api/repos/discover',
      'GET /api/series',
      'GET /api/sources',
      'GET /api/usage/categories',
      'GET /api/usage/groups',
      'GET /api/usage/groups/{groupKey}/roots',
      'GET /api/year',
      'POST /api/accounts/claude/plan-limits/check',
      'POST /api/accounts/{account}/connect',
      'POST /api/accounts/{account}/disconnect',
      'POST /api/hq/hooks/claude',
      'POST /api/refresh',
      'POST /api/repos',
      'POST /api/repos/{owner}/{name}/recheck',
      'POST /api/setup/complete',
      'POST /api/setup/discover',
      'POST /api/setup/reset',
      'PUT /api/accounts/claude/usage-capture',
      'PUT /api/accounts/github/app',
      'PUT /api/hq/claude-hooks',
      'PUT /api/prs/{prId}/links/{sessionId}',
    ]);
  });

  /**
   * An app whose GitHub runs on the scripted GitHub. `signedIn: false` (the account routes) has gh signed out and a client ID
   * saved; `true` (the repo routes) has gh signed in and `kelvin/atlas-api` known to GitHub.
   */
  async function appWithGithub(signedIn: boolean) {
    const clock = { now: Date.parse('2026-11-04T20:00:00Z') };
    const github = createFakeGithub({ now: () => clock.now });
    github.addRepo({ fullName: 'kelvin/atlas-api', nodeId: 'R_atlasapi' });
    if (!signedIn) github.signOutGh();
    const db = memoryDb();
    const accounts = createGithubAccounts({
      db,
      net: github.net,
      keyring: createMemoryKeyring(),
      gh: github.gh,
      now: () => clock.now,
      sleep: () => new Promise<void>(() => undefined), // the device flow never moves on: it stays pending
    });
    const harness = testApp({
      db,
      github: accounts,
      repos: { net: github.net, auth: accounts.auth },
    });
    if (!signedIn) {
      const saved = await call(harness.app, '/api/accounts/github/app', {
        method: 'PUT',
        headers: WRITE,
        body: JSON.stringify({ clientId: 'Iv1.testclient' }),
      });
      expect(saved.status).toBe(200);
    }
    return harness.app;
  }

  /** An app whose Claude capture runs over a temporary config folder and data folder: nothing real is read or written. */
  function appWithClaude() {
    const dir = tempDir();
    const capture = createClaudeCapture({
      dataDir: join(dir, 'data'),
      env: { CLAUDE_CONFIG_DIR: join(dir, 'config') },
      home: dir,
    });
    const db = memoryDb();
    return testApp({
      db,
      claude: createClaudeAccounts({
        capture,
        db,
        now: () => Date.parse('2026-11-04T20:00:00Z'),
        profile: () => claudePlanProfile({}, dir),
        planLimits: {
          readCredential: async () => ({ state: 'ok', accessToken: 'test-only' }),
          net: async () =>
            Response.json({ five_hour: { utilization: 23, resets_at: '2026-11-05T00:00:00Z' } }),
        },
      }),
    }).app;
  }

  /** An app whose Claude Code hooks switch runs over a temporary config folder and data folder, with the hook endpoint mounted. */
  function appWithHooks() {
    const r = rig({ settings: '{"theme":"dark"}' });
    return testApp({ claudeHooks: r.hooks, hookIngest }).app;
  }

  /**
   * An app with one merged PR and one session of its repo active just before the merge, so the PR routes have something to answer
   * about: the session is a candidate for the PR, which is what a decision needs.
   */
  function appWithPr() {
    const db = memoryDb();
    db.prepare(
      `INSERT INTO repo (id, display_name, tracking_state, access_state, added_at, backfill_complete)
       VALUES ('kelvin/atlas-api', 'kelvin/atlas-api', 'active', 'ok', 0, 1)`,
    ).run();
    const merged = Date.parse('2026-11-03T18:00:00Z');
    upsertPullRequests(db, [
      {
        nodeId: 'PR_contract',
        repoId: 'kelvin/atlas-api',
        number: 7,
        title: 'Contract PR',
        url: 'https://github.com/kelvin/atlas-api/pull/7',
        authorLogin: 'kelvin',
        mergedByLogin: 'kelvin',
        mergedAt: merged,
        headRef: 'feature/contract',
        baseRef: 'main',
        mergeCommitSha: null,
        commits: [],
        commitsComplete: true,
      },
    ]);
    const sessionId = upsertSession(db, {
      provider: 'claude',
      providerSessionId: 'contract-session',
      kind: 'root',
      repoId: 'kelvin/atlas-api',
      startedAt: merged - 3_600_000,
      startedBasis: 'source_start',
      lastEventAt: merged - 1_800_000,
    });
    return { app: testApp({ db }).app, sessionId };
  }

  /** The status each served route answers with when it works (everything else is 200). */
  const SUCCESS: Record<string, number> = {
    'POST /api/refresh': 202,
    'POST /api/setup/complete': 202,
    'POST /api/setup/reset': 204,
    'POST /api/repos': 201,
    'DELETE /api/repos/{owner}/{name}': 204,
    'DELETE /api/prs/{prId}/links/{sessionId}': 204,
    'POST /api/hq/hooks/claude': 204,
  };

  it.each(served)('%s answers with a body its contract accepts, as JSON', async (key) => {
    const route = ROUTES.find((r) => routeKey(r) === key)!;
    const method = route.method.toUpperCase();
    const write = method !== 'GET';
    const isClaude = key.includes('/api/accounts/claude/');
    const isAccount = key.includes('/api/accounts/');
    const isRepoWrite = /\/api\/repos\/|^POST \/api\/repos$/.test(key);
    const pr = key.includes('/api/prs/{prId}') ? appWithPr() : null;
    const isHooks = key.includes('/api/hq/claude-hooks') || key === 'POST /api/hq/hooks/claude';
    const target = pr
      ? pr.app
      : isHooks
        ? appWithHooks()
        : isClaude
          ? appWithClaude()
          : isAccount
            ? await appWithGithub(false)
            : isRepoWrite
              ? await appWithGithub(true)
              : key === 'POST /api/setup/reset'
                ? testApp().app
                : app;
    // A run has to exist before it can be read: start one (the app has no adapters, so every source is skipped).
    if (key === 'GET /api/refresh/{runId}')
      await call(app, '/api/refresh', { method: 'POST', headers: WRITE, body: '{}' });
    // A repo has to be tracked before it can be stopped or re-checked.
    if (key === 'DELETE /api/repos/{owner}/{name}' || key.endsWith('/recheck')) {
      const added = await call(target, '/api/repos', {
        method: 'POST',
        headers: WRITE,
        body: JSON.stringify({ input: 'kelvin/atlas-api' }),
      });
      expect(added.status).toBe(201);
    }
    // A sign-in has to be running before it can be polled.
    let loginId = '1';
    if (key === 'GET /api/accounts/{account}/connect/{loginId}') {
      const started = await call(target, '/api/accounts/github/connect', {
        method: 'POST',
        headers: WRITE,
        body: '{}',
      });
      loginId = ((await started.json()) as { loginId: string }).loginId;
    }
    const url = route.path
      .replace('{prId}', 'PR_contract')
      .replace('{sessionId}', String(pr?.sessionId ?? 1))
      .replace('{groupKey}', '__untracked')
      .replace('{runId}', '1')
      .replace('{account}', 'github')
      .replace('{loginId}', loginId)
      .replace('{owner}', 'kelvin')
      .replace('{name}', 'atlas-api');
    const body =
      key === 'PUT /api/accounts/github/app'
        ? '{"clientId":"Iv1.testclient"}'
        : key === 'POST /api/repos'
          ? '{"input":"kelvin/atlas-api"}'
          : key === 'PUT /api/prs/{prId}/links/{sessionId}'
            ? '{"decision":"confirmed"}'
            : key === 'PUT /api/accounts/claude/usage-capture'
              ? '{"action":"begin_remove"}'
              : key === 'PUT /api/hq/claude-hooks'
                ? JSON.stringify({
                    enabled: true,
                    // The change carries the fingerprint of the preview, read the way the page reads it.
                    preview: (
                      (await (
                        await call(target, '/api/hq/claude-hooks', { headers: HOST })
                      ).json()) as {
                        preview: string;
                      }
                    ).preview,
                  })
                : key === 'POST /api/hq/hooks/claude'
                  ? '{"hook_event_name":"Stop","session_id":"contract-session"}'
                  : key === 'POST /api/setup/reset'
                    ? '{"confirmed":true}'
                    : '{}';
    const path = key === 'GET /api/repos/discover' ? url + '?login=octo-kelvin&via=gh' : url;
    const res = await call(target, path, {
      method,
      headers: write
        ? key === 'POST /api/hq/hooks/claude'
          ? { ...WRITE, authorization: `Bearer ${hookToken}` }
          : WRITE
        : HOST,
      ...(write && method !== 'DELETE' ? { body } : {}),
    });
    const expected = SUCCESS[key] ?? 200;
    expect(res.status, key).toBe(expected);
    const schema = route.responses[String(expected)] ?? null;
    if (schema === null) {
      // A 204 has no body at all.
      expect(await res.text()).toBe('');
      return;
    }
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(schema.safeParse(await res.json()).success).toBe(true);
  });

  it.each(PENDING_ROUTES.map((key) => [key] as const))(
    '%s is not served yet and says so with the error envelope',
    async (key) => {
      const [method, path] = key.split(' ') as [string, string];
      const url = path.replace(/\{[^}]+\}/g, '1');
      const headers =
        method === 'GET'
          ? HOST
          : { ...HOST, 'x-agent-productivity-request': '1', 'content-type': 'application/json' };
      const res = await call(app, url, {
        method,
        headers,
        ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }),
      });
      expect(res.status).toBe(404);
      expect(ErrorEnvelope.parse(await res.json()).error.code).toBe('not_found');
    },
  );
});

describe('the document and the domain agree on the filter defaults', () => {
  const parameter = (name: string) =>
    (doc['components'] as { parameters: Record<string, { schema: Json }> }).parameters[name]!
      .schema;
  const ctx = {
    today: '2026-11-04',
    timezone: 'America/Los_Angeles',
    knownRepos: new Set<string>(),
  };

  it('provider defaults to all and author to mine', () => {
    const result = resolveScope({}, ctx);
    expect(result.ok && result.scope.provider).toBe(parameter('provider')['default']);
    expect(result.ok && result.scope.author).toBe(parameter('author')['default']);
  });

  it('accepts exactly the documented values for gran, provider and author', () => {
    for (const name of ['gran', 'provider', 'author']) {
      for (const value of parameter(name)['enum'] as string[]) {
        expect(resolveScope({ [name]: value }, ctx).ok, `${name}=${value}`).toBe(true);
      }
      expect(resolveScope({ [name]: 'nope' }, ctx).ok, `${name}=nope`).toBe(false);
    }
  });
});
