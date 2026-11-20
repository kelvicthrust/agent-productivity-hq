import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { boot, type ListenFn, type RunningServer } from '../../../src/server/boot.ts';
import { createLocalAdapters } from '../../../src/server/collectors/discovery.ts';
import { RefreshRun, SourcesResponse } from '../../../src/shared/contracts/sources.ts';
import { HOST, PORT, TZ, WRITE, memoryLogger, tempConfig } from '../../server/helpers.ts';
import { T0, expectOraclesMatch, history, makeHome } from './helpers.ts';

// Restart through the real boot and the HTTP API: a refresh imports the fixture logs, the app stops, the logs are deleted, the
// app starts again on the same database file, and a refresh finds nothing and loses nothing. The fixture logs are INVENTED.

const fakeListen: ListenFn = async () => ({ close: (callback) => callback?.() });
const url = (path: string) => `http://127.0.0.1:${PORT}${path}`;

async function refreshOver(server: RunningServer) {
  const started = await server.app.request(url('/api/refresh'), {
    method: 'POST',
    headers: WRITE,
    body: '{}',
  });
  expect(started.status).toBe(202);
  const { id } = RefreshRun.parse(await started.json());
  for (let waited = 0; waited < 30_000; waited += 10) {
    const run = RefreshRun.parse(
      await (await server.app.request(url(`/api/refresh/${id}`), { headers: HOST })).json(),
    );
    if (run.state !== 'running') return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the run did not end');
}

const sourcesOver = async (server: RunningServer) =>
  SourcesResponse.parse(
    await (await server.app.request(url('/api/sources'), { headers: HOST })).json(),
  );

describe('delete the logs, restart the app', () => {
  it('keeps the history, the sources say what they found, and nothing is a failure', async () => {
    const config = tempConfig();
    const home = makeHome();
    const start = (logs = memoryLogger()) =>
      boot(config, {
        logger: logs.logger,
        listen: fakeListen,
        now: () => T0,
        timezone: TZ,
        scheduler: false,
        adapters: createLocalAdapters({ env: {}, home }),
      });

    const first = await start();
    const run = await refreshOver(first);
    expect(run.state).toBe('succeeded');
    expect(run.sources['codex']).toMatchObject({ state: 'succeeded', imported: 3 });
    expect(run.sources['claude']).toMatchObject({ state: 'succeeded', imported: 6 });
    const sources = await sourcesOver(first);
    expect(sources.sources?.map((s) => [s.id, s.status, s.sessions])).toEqual([
      ['codex', 'ok', 3],
      ['claude', 'ok', 6],
    ]);
    const before = history(first.db!);
    expectOraclesMatch(first.db!);
    await first.shutdown();

    for (const folder of ['.claude', '.config/claude', '.codex'])
      rmSync(join(home, folder), { recursive: true, force: true });

    const logs = memoryLogger();
    const second = await start(logs);
    try {
      // Retention at boot ran on the clock at boot and, with the history inside its 366 days, took nothing.
      expect(logs.entries.find((entry) => entry['step'] === 'retention')).toMatchObject({
        usageEvents: 0,
        pullRequests: 0,
      });
      const after = await refreshOver(second);
      expect(after.state).toBe('succeeded');
      expect(history(second.db!)).toEqual(before);
      expectOraclesMatch(second.db!);
      const sourcesAfter = await sourcesOver(second);
      // History still starts where it did: Codex's archived rollout is from 2026-09-28, Claude Code's first transcript from 10-12.
      const oldest = { codex: '2026-09-28', claude: '2026-10-12' } as Record<string, string>;
      for (const source of sourcesAfter.sources ?? []) {
        expect(source, source.id).toMatchObject({
          lastAttemptResult: 'succeeded',
          consecutiveFailures: 0,
          oldestDate: oldest[source.id],
        });
      }
      expect(sourcesAfter.sources?.map((s) => s.sessions)).toEqual([3, 6]);
    } finally {
      await second.shutdown();
    }
  });
});
