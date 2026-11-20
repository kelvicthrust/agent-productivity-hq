import { afterEach, describe, expect, it } from 'vitest';
import { boot, type ListenFn, type RunningServer } from '../../src/server/boot.ts';
import { SetupDiscoverResponse } from '../../src/shared/contracts/sources.ts';
import { CAN_DENY, makeSetupHome, type SetupHome } from '../e2e/helpers/homes.ts';
import { HOST, NOW, PORT, TZ, WRITE, memoryLogger, tempConfig } from './helpers.ts';

// First-launch Setup, wired (M10: A35's service and routes mounted by createApp, fed by boot; G10_1, G10_2; TECH J1; P-39, P-40, P-43).
// The app is booted over a TEMPORARY home that holds INVENTED fixture history, so nothing here reads this computer's folders.
//   - discovery finds the folders at the documented defaults and at the override variables, with nothing asked for (no path, no picker),
//     reports absent and denied folders with their own words, and imports nothing: no usage, no session, no run, no attempt;
//   - Finish with nothing connected marks setup done and starts one run; a repeat starts none;
//   - a process that reads this machine reads nothing until Finish, and a process with no machine looks at nothing on disk.

const listen: ListenFn = async () => ({ close: (callback) => callback?.() });
const homes: SetupHome[] = [];
const servers: RunningServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.shutdown();
  for (const home of homes.splice(0)) home.close();
});

function machine(options?: Parameters<typeof makeSetupHome>[0]): SetupHome {
  const made = makeSetupHome(options);
  homes.push(made);
  return made;
}

async function start(
  home: SetupHome | null,
  extra: { scheduler?: boolean; codexOnPath?: boolean } = {},
): Promise<RunningServer> {
  const server = await boot(tempConfig(), {
    logger: memoryLogger().logger,
    listen,
    now: () => NOW,
    timezone: TZ,
    scheduler: extra.scheduler ?? false,
    ...(home ? { local: { env: home.env, home: home.home } } : {}),
    ...(extra.codexOnPath === undefined
      ? {}
      : { setup: { codexOnPath: () => extra.codexOnPath! } }),
  });
  servers.push(server);
  return server;
}

const url = (path: string) => `http://127.0.0.1:${PORT}${path}`;

const post = (server: RunningServer, path: string, headers: Record<string, string> = WRITE) =>
  server.app.request(url(path), { method: 'POST', headers });

async function discover(server: RunningServer) {
  const response = await post(server, '/api/setup/discover');
  expect(response.status).toBe(200);
  return SetupDiscoverResponse.parse(await response.json());
}

const count = (server: RunningServer, table: string): number =>
  (server.db!.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const runs = (server: RunningServer) =>
  server.db!.prepare('SELECT id, state, trigger FROM refresh_run ORDER BY id').all() as unknown as {
    id: number;
    state: string;
    trigger: string;
  }[];

async function runsOver(server: RunningServer): Promise<void> {
  for (let waited = 0; waited < 20_000; waited += 10) {
    const all = runs(server);
    if (all.length > 0 && all.every((run) => run.state !== 'running')) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the run did not end');
}

describe('discovery through the real app', () => {
  it('finds both providers at their documented default folders, asking for nothing', async () => {
    const home = machine();
    const server = await start(home);
    const answer = await discover(server);
    expect(answer.sources?.map((s) => [s.id, s.status])).toEqual([
      ['codex', 'ok'],
      ['claude', 'ok'],
    ]);
    // Where it looked is the machine's own place, under the home it was given: nothing was typed or picked.
    const where = Object.fromEntries((answer.sources ?? []).map((s) => [s.id, s.location]));
    expect(where['codex']).toContain(home.home);
    expect(where['claude']).toContain(home.home);
  });

  it('finds them at the override variables when the defaults are empty (CODEX_HOME, CLAUDE_CONFIG_DIR)', async () => {
    const home = machine({ claudeAt: 'override', codexAt: 'override' });
    expect(Object.keys(home.env).sort()).toEqual(['CLAUDE_CONFIG_DIR', 'CODEX_HOME']);
    const answer = await discover(await start(home));
    expect(answer.sources?.map((s) => [s.id, s.status])).toEqual([
      ['codex', 'ok'],
      ['claude', 'ok'],
    ]);
    const where = Object.fromEntries((answer.sources ?? []).map((s) => [s.id, s.location]));
    expect(where['codex']).toContain(home.env['CODEX_HOME']);
    expect(where['claude']).toContain(home.env['CLAUDE_CONFIG_DIR']);
  });

  it('reports a provider that was never run as Not found, and a source that is not found is not a failure', async () => {
    const server = await start(machine({ claude: 'absent', codex: 'absent' }));
    const answer = await discover(server);
    expect(answer.sources?.map((s) => [s.id, s.status])).toEqual([
      ['codex', 'notfound'],
      ['claude', 'notfound'],
    ]);
    for (const source of answer.sources ?? []) {
      expect(source).toMatchObject({ lastAttemptResult: null, consecutiveFailures: 0 });
    }
  });

  it.skipIf(!CAN_DENY)('reports a folder macOS keeps closed as Access denied', async () => {
    const home = machine({ claude: 'denied' });
    const answer = await discover(await start(home));
    const byId = Object.fromEntries((answer.sources ?? []).map((s) => [s.id, s.status]));
    expect(byId).toEqual({ codex: 'ok', claude: 'denied' });
  });

  it('imports nothing: no usage, no session, no run and no attempt exist after discovery, however often it is asked', async () => {
    const server = await start(machine());
    await discover(server);
    await discover(server);
    for (const table of [
      'usage_event',
      'session',
      'source_file',
      'refresh_run',
      'pull_request',
      'repo',
    ]) {
      expect(count(server, table), table).toBe(0);
    }
    const attempts = server
      .db!.prepare('SELECT COUNT(*) AS n FROM source_state WHERE last_attempt_at IS NOT NULL')
      .get() as { n: number };
    expect(attempts.n).toBe(0);
    // The stored rows say only what was seen.
    expect(count(server, 'source_state')).toBeGreaterThan(0);
  });

  it('is refused without the app header, like every write, and a body is never read', async () => {
    const server = await start(machine());
    const refused = await post(server, '/api/setup/discover', HOST);
    expect(refused.status).toBe(403);
    // A client that sends a folder, a key or a token changes nothing: the answer is the same as for an empty body.
    const empty = await discover(server);
    const response = await server.app.request(url('/api/setup/discover'), {
      method: 'POST',
      headers: WRITE,
      body: JSON.stringify({ path: '/etc', apiKey: 'sk-not-a-real-key', folder: '/Users' }),
    });
    expect(SetupDiscoverResponse.parse(await response.json())).toEqual(empty);
  });

  it('says ChatGPT is unavailable when `codex` is not on the PATH, without starting anything', async () => {
    const server = await start(machine(), { codexOnPath: false });
    // No ChatGPT integration is given here, so the answer has no ChatGPT entry at all: the card is the account service's.
    const answer = await discover(server);
    expect((answer.accounts ?? []).find((a) => a.id === 'chatgpt')).toBeUndefined();
  });
});

describe('a process with no machine', () => {
  it('looks at nothing on disk: a stored row is read back as it is and a visit to Setup changes none', async () => {
    const server = await start(null);
    server
      .db!.prepare(
        "INSERT INTO source_state (source_id, status, location) VALUES ('codex', 'ok', '/synthetic/codex')",
      )
      .run();
    const answer = await discover(server);
    expect(answer.sources?.map((s) => [s.id, s.status, s.location])).toEqual([
      ['codex', 'ok', '/synthetic/codex'],
    ]);
    const stored = server
      .db!.prepare("SELECT status, location FROM source_state WHERE source_id = 'codex'")
      .get();
    expect(stored).toEqual({ status: 'ok', location: '/synthetic/codex' });
  });
});

describe('Finish', () => {
  it('is allowed with nothing found and nothing connected: setup is done and one run starts', async () => {
    const server = await start(machine({ claude: 'absent', codex: 'absent' }));
    expect(
      await (await server.app.request(url('/api/bootstrap'), { headers: HOST })).json(),
    ).toMatchObject({
      setupComplete: false,
    });
    const finished = await post(server, '/api/setup/complete');
    expect(finished.status).toBe(202);
    const run = (await finished.json()) as { id: number; state: string; trigger: string };
    expect(run.id).toBe(1);
    await runsOver(server);
    expect(runs(server).map((r) => r.trigger)).toEqual(['setup']);
    expect(
      await (await server.app.request(url('/api/bootstrap'), { headers: HOST })).json(),
    ).toMatchObject({
      setupComplete: true,
    });
  });

  it('starts no second run when it is pressed again, and answers the run that was started', async () => {
    const server = await start(machine({ claude: 'absent', codex: 'absent' }));
    const first = (await (await post(server, '/api/setup/complete')).json()) as { id: number };
    await runsOver(server);
    const again = await post(server, '/api/setup/complete');
    expect(again.status).toBe(202);
    expect(((await again.json()) as { id: number }).id).toBe(first.id);
    expect(runs(server)).toHaveLength(1);
    const completedAt = server
      .db!.prepare("SELECT value FROM app_meta WHERE key = 'setup_completed_at'")
      .get() as { value: string };
    await post(server, '/api/setup/complete');
    expect(
      server.db!.prepare("SELECT value FROM app_meta WHERE key = 'setup_completed_at'").get(),
    ).toEqual(completedAt);
  });

  it('imports the history it found: the first run is the one Finish started', async () => {
    const server = await start(machine());
    await post(server, '/api/setup/complete');
    await runsOver(server);
    expect(runs(server)).toEqual([{ id: 1, state: 'succeeded', trigger: 'setup' }]);
    expect(count(server, 'session')).toBeGreaterThan(0);
  });
});

describe('a machine that has not finished Setup', () => {
  it('reads nothing by itself, however long the app has been up: the first run is Finish’s', async () => {
    const server = await start(machine(), { scheduler: true });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(runs(server)).toEqual([]);
    expect(count(server, 'session')).toBe(0);
  });

  it('starts its first run by itself once Setup has been finished (a restart), as before', async () => {
    const home = machine();
    const config = tempConfig();
    const first = await boot(config, {
      logger: memoryLogger().logger,
      listen,
      now: () => NOW,
      timezone: TZ,
      scheduler: false,
      local: { env: home.env, home: home.home },
    });
    await post(first, '/api/setup/complete');
    await runsOver(first);
    await first.shutdown();
    const second = await boot(config, {
      logger: memoryLogger().logger,
      listen,
      now: () => NOW,
      timezone: TZ,
      local: { env: home.env, home: home.home },
    });
    servers.push(second);
    await runsOver(second);
    expect(runs(second).map((r) => r.trigger)).toEqual(['setup', 'scheduler']);
  });
});
