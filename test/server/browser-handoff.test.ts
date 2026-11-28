import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  PASEO_BROWSER_SESSION_HEADER,
  PASEO_HANDOFF_PATH,
} from '../../src/shared/contracts/browser-handoff.ts';
import { boot, type ListenFn } from '../../src/server/boot.ts';
import { upsertPullRequests } from '../../src/server/db/queries/prs.ts';
import { completeSetup } from '../../src/server/db/queries/setup.ts';
import { upsertSession } from '../../src/server/db/queries/usage.ts';
import { loadConfig } from '../../src/server/lib/config.ts';
import { createFakeGithub, createMemoryKeyring } from '../fixtures/github/scripted-github.ts';
import { FIXED_NOW, FIXED_TIMEZONE } from '../fixtures/seed.ts';
import { tempDir } from './helpers.ts';

const host = 'hq.example.ts.net:4317';
const origin = `https://${host}`;
const ownerLogin = 'owner@example.test';
const owner = { host, 'tailscale-user-login': ownerLogin };
const writeHeaders = {
  'Content-Type': 'application/json',
  'X-Agent-Productivity-Request': '1',
  Origin: origin,
};

async function withShare(
  run: (context: {
    db: NonNullable<Awaited<ReturnType<typeof boot>>['db']>;
    share: Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof boot>>['attachRemote']>>>;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    exchange: (ticket: string, headers?: Record<string, string>) => Promise<Response>;
    advance: (milliseconds: number) => void;
  }) => Promise<void>,
) {
  const staticDir = tempDir();
  writeFileSync(join(staticDir, 'index.html'), '<main>Agent HQ dashboard</main>');
  const config = loadConfig({ AGENT_PRODUCTIVITY_DATA_DIR: tempDir() }, { staticDir });
  let now = FIXED_NOW;
  const { net, gh } = createFakeGithub({ now: () => now });
  let dispatch: Parameters<ListenFn>[0]['fetch'] | undefined;
  const server = await boot(config, {
    managed: true,
    scheduler: false,
    github: { net, gh, keyring: createMemoryKeyring() },
    timezone: FIXED_TIMEZONE,
    now: () => now,
    listen: async (options) => {
      dispatch = options.fetch;
      return { address: () => ({ port: 43_192 }), close: (done) => done?.() };
    },
  });
  try {
    completeSetup(server.db!, { at: now, timezone: FIXED_TIMEZONE });
    const share = await server.attachRemote!({ host, ownerLogin });
    const request = async (path: string, init?: RequestInit) =>
      dispatch!(new Request(origin + path, { ...init, headers: { ...owner, ...init?.headers } }));
    const exchange = (ticket: string, headers: Record<string, string> = {}) =>
      request(PASEO_HANDOFF_PATH, {
        method: 'POST',
        headers: { ...writeHeaders, ...headers },
        body: JSON.stringify({ ticket }),
      });
    await run({
      db: server.db!,
      share,
      request,
      exchange,
      advance: (milliseconds) => {
        now += milliseconds;
      },
    });
  } finally {
    await server.shutdown();
  }
}

it('opens a fresh browser shell behind Serve without requiring the owner code', async () => {
  await withShare(async ({ request }) => {
    const shell = await request('/paseo/');
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('Agent HQ dashboard');
    expect(shell.headers.get('cache-control')).toBe('no-store');
    expect(
      (await request('/paseo/', { headers: { 'tailscale-user-login': 'other@example.test' } }))
        .status,
    ).toBe(403);
    expect((await request('/')).status).toBe(401);
    expect((await request('/api/bootstrap')).status).toBe(401);
  });
});

it('checks identity and origin before exchanging a ticket exactly once', async () => {
  await withShare(async ({ share, exchange }) => {
    const { ticket } = share.issueBrowserTicket()!;
    expect((await exchange(ticket, { 'tailscale-user-login': 'other@example.test' })).status).toBe(
      403,
    );
    expect((await exchange(ticket, { 'Tailscale-Funnel-Request': '?1' })).status).toBe(403);
    expect((await exchange(ticket, { Host: 'hq.example.ts.net:4916' })).status).toBe(421);
    expect((await exchange(ticket, { Origin: 'https://hq.example.ts.net:4916' })).status).toBe(403);
    const responses = await Promise.all([exchange(ticket), exchange(ticket)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    const success = responses.find((response) => response.ok)!;
    expect(success.headers.get('set-cookie')).toBeNull();
    expect(success.headers.get('cache-control')).toBe('no-store');
    expect(await success.json()).toEqual({
      credential: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
  });
});

it('grants the usual reports and management operations with owner-only routes denied', async () => {
  await withShare(async ({ db, share, exchange, request }) => {
    const repo = 'kelvin/example';
    const prId = 'legacy/PR+=';
    db.prepare(
      `INSERT INTO repo (id, display_name, tracking_state, access_state, added_at, backfill_complete)
       VALUES (?, ?, 'active', 'ok', 0, 1)`,
    ).run(repo, repo);
    upsertPullRequests(db, [
      {
        nodeId: prId,
        repoId: repo,
        number: 1,
        title: 'Change',
        url: 'https://github.com/kelvin/example/pull/1',
        authorLogin: 'kelvin',
        mergedByLogin: 'kelvin',
        mergedAt: FIXED_NOW,
        headRef: 'change',
        baseRef: 'main',
        mergeCommitSha: null,
        commits: [],
        commitsComplete: true,
      },
    ]);
    const sessionId = upsertSession(db, {
      provider: 'codex',
      providerSessionId: 'example-session',
      kind: 'root',
      repoId: repo,
      startedAt: FIXED_NOW,
      startedBasis: 'source_start',
      firstEventAt: FIXED_NOW,
      lastEventAt: FIXED_NOW,
    });
    const { ticket } = share.issueBrowserTicket()!;
    const { credential } = (await (await exchange(ticket)).json()) as { credential: string };
    const headers = { ...writeHeaders, [PASEO_BROWSER_SESSION_HEADER]: credential };
    for (const path of [
      '/api/overview',
      '/api/sources',
      '/api/repos',
      '/api/prs',
      '/api/hq',
      '/api/work-review',
    ]) {
      expect((await request(path, { headers })).status, path).toBe(200);
    }
    for (const [method, path, body, status] of [
      ['POST', '/api/accounts/github/connect', {}, 200],
      [
        'PUT',
        `/api/prs/${encodeURIComponent(prId)}/links/${sessionId}`,
        { decision: 'confirmed' },
        200,
      ],
      ['DELETE', '/api/repos/kelvin/example', {}, 204],
      ['POST', '/api/refresh', {}, 202],
    ] as const) {
      const response = await request(path, { method, headers, body: JSON.stringify(body) });
      expect(response.status, path).toBe(status);
    }
    for (const [method, path] of [
      ['GET', '/api/hq/claude-hooks'],
      ['PUT', '/api/hq/claude-hooks'],
      ['GET', '/api/accounts/claude/usage-capture/preview'],
      ['PUT', '/api/accounts/claude/usage-capture'],
      ['GET', '/api/work-review/account'],
      ['POST', '/api/work-review/account/connect'],
      ['POST', '/api/work-review/account/disconnect'],
      ['POST', '/api/work-review/generate'],
      ['GET', '/api/work-review/automation'],
      ['POST', '/api/work-review/automation'],
      ['POST', '/api/setup/reset'],
      ['POST', '/api/setup/complete'],
      ['POST', '/api/hq/hooks/claude'],
    ] as const) {
      const response = await request(path, {
        method,
        headers,
        ...(method === 'GET' ? {} : { body: '{}' }),
      });
      expect(response.status, path).toBe(403);
    }
    expect(
      (
        await request('/api/bootstrap', {
          headers: { ...headers, 'tailscale-user-login': 'other@example.test' },
        })
      ).status,
    ).toBe(403);
  });
});

it('expires tickets and sessions and revokes both when the share closes', async () => {
  await withShare(async ({ share, exchange, request, advance }) => {
    const stale = share.issueBrowserTicket()!;
    advance(2 * 60 * 1_000);
    expect((await exchange(stale.ticket)).status).toBe(401);

    const session = async () => {
      const { credential } = (await (
        await exchange(share.issueBrowserTicket()!.ticket)
      ).json()) as {
        credential: string;
      };
      return { headers: { [PASEO_BROWSER_SESSION_HEADER]: credential } };
    };
    const expiredSession = await session();
    advance(8 * 60 * 60 * 1_000);
    expect((await request('/api/bootstrap', expiredSession)).status).toBe(401);

    const activeSession = await session();
    const outstanding = share.issueBrowserTicket()!;
    await share.close();
    expect(share.issueBrowserTicket()).toBeNull();
    expect((await exchange(outstanding.ticket)).status).toBe(401);
    expect((await request('/api/bootstrap', activeSession)).status).toBe(401);
  });
});
