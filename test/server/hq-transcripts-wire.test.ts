import { afterEach, describe, expect, it, vi } from 'vitest';
import { boot, type ListenFn, type RunningServer } from '../../src/server/boot.ts';
import { migrate } from '../../src/server/db/migrate.ts';
import { openDatabase } from '../../src/server/db/open.ts';
import { completeSetup } from '../../src/server/db/queries/setup.ts';
import { FULL_LISTING_EVERY_MS } from '../../src/server/collectors/live/heuristics.ts';
import { HqResponse } from '../../src/shared/contracts/hq.ts';
import { SENTINELS } from '../collectors/live/lines.ts';
import { at, makeHomes, S1, stamp } from '../collectors/live/feedHelpers.ts';
import { HOST, TZ, call, memoryLogger, tempConfig, tempDir } from './helpers.ts';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// HQ's transcript feeds through the real boot, over temp provider homes holding invented transcripts. What is checked is the demand: nothing
// is read until /api/hq is asked for, nothing before first-launch Setup is finished, the feeds stop when nobody asks, and for good on
// shutdown. Reads are counted at the folder lister (`createRecent`), which every look at a provider folder goes through.

const looks = vi.hoisted(() => ({ refreshes: 0 }));
vi.mock('../../src/server/collectors/live/recent.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/server/collectors/live/recent.ts')>();
  return {
    ...actual,
    createRecent: (options: Parameters<typeof actual.createRecent>[0]) => {
      const inner = actual.createRecent(options);
      return {
        refresh: () => {
          looks.refreshes += 1;
          return inner.refresh();
        },
        clear: () => inner.clear(),
      };
    },
  };
});

const listen: ListenFn = async () => ({ close: (callback) => callback?.() });
const servers: RunningServer[] = [];
const CLOCK = at(34);

afterEach(async () => {
  for (const server of servers.splice(0)) await server.shutdown();
  looks.refreshes = 0;
});

async function start(
  options: { setupDone?: boolean; local?: boolean; idleMs?: number; now?: () => number } = {},
) {
  const homes = makeHomes(CLOCK);
  const config = tempConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDatabase(config.dbPath);
  migrate(db);
  if (options.setupDone !== false) completeSetup(db, { at: CLOCK, timezone: TZ });
  db.close();
  const { logger, entries } = memoryLogger('debug');
  const server = await boot(config, {
    logger,
    listen,
    now: options.now ?? (() => CLOCK),
    timezone: TZ,
    scheduler: false,
    // No batch import: the only readers of the provider folders in this process are the live feeds.
    adapters: [],
    ...(options.local === false
      ? {}
      : {
          local: {
            env: { CLAUDE_CONFIG_DIR: homes.claudeDir, CODEX_HOME: homes.codexHome },
            home: tempDir(),
          },
        }),
    hq: { idleMs: options.idleMs ?? 60_000, coldWaitMs: 5_000, transcriptPollMs: 5 },
  });
  servers.push(server);
  return { server, homes, logs: entries };
}

const hq = async (server: RunningServer) => {
  const response = await call(server.app as never, '/api/hq', { headers: HOST });
  expect(response.status).toBe(200);
  return HqResponse.parse(await response.json());
};

function writeWorkingChild(project: string, name: string): void {
  const child = join(project, S1, 'subagents', `${name}.jsonl`);
  writeFileSync(
    child,
    JSON.stringify({
      type: 'user',
      isSidechain: true,
      timestamp: new Date(CLOCK - 1000).toISOString(),
      message: { content: SENTINELS[0] },
    }) + '\n',
  );
  stamp(child, CLOCK);
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let waited = 0; waited < 5_000; waited += 5) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Waits until the count has not moved for `quietMs`. */
async function stillFor(quietMs: number): Promise<number> {
  let last = looks.refreshes;
  let since = Date.now();
  while (Date.now() - since < quietMs) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (looks.refreshes !== last) {
      last = looks.refreshes;
      since = Date.now();
    }
  }
  return last;
}

describe('transcript feeds through boot', () => {
  it.each(['recent housekeeping', 'old modification time'] as const)(
    'groups working Claude subagents under their expired parent on first load (%s)',
    async (parentFile) => {
      const { server, homes, logs } = await start();
      const project = join(homes.claudeDir, 'projects', '-work-invented-project');
      const parent = join(project, `${S1}.jsonl`);
      const old = CLOCK - 60 * 60_000;
      const conversation = {
        type: 'assistant',
        timestamp: new Date(old).toISOString(),
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: SENTINELS[0] }] },
      };
      const records = [
        conversation,
        ...(parentFile === 'recent housekeeping'
          ? [{ type: 'cost-state', timestamp: new Date(CLOCK).toISOString() }]
          : []),
      ];
      writeFileSync(parent, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
      stamp(parent, parentFile === 'recent housekeeping' ? CLOCK : old);
      for (const name of ['agent-a1', 'agent-a2']) writeWorkingChild(project, name);

      const body = await hq(server);
      const children = body.agents.filter(
        (agent) => agent.provider === 'claude' && agent.kind === 'child',
      );
      expect(children).toHaveLength(2);
      expect(children[0]).toMatchObject({
        parentId: expect.any(String),
        parentBasis: 'native',
        parentAway: false,
        state: 'working',
      });
      expect(children[1]).toMatchObject({ parentId: children[0]!.parentId, state: 'working' });
      expect(body.agents.filter((agent) => agent.id === children[0]!.parentId)).toEqual([
        expect.objectContaining({
          kind: 'root',
          state: 'idle',
          lastActivityAt: new Date(old).toISOString(),
        }),
      ]);
      const output = JSON.stringify({ body, logs });
      for (const sentinel of [SENTINELS[0], homes.root, S1]) expect(output).not.toContain(sentinel);
    },
  );

  it.each(['missing', 'symbolic link', 'housekeeping only', 'recent activity'] as const)(
    'keeps a working Claude subagent visible when idle parent context is unavailable (%s)',
    async (parentFile) => {
      const { server, homes } = await start();
      const project = join(homes.claudeDir, 'projects', '-work-invented-project');
      const parent = join(project, `${S1}.jsonl`);
      rmSync(parent);
      if (parentFile === 'symbolic link') {
        const outside = join(homes.root, 'outside.jsonl');
        writeFileSync(
          outside,
          JSON.stringify({
            type: 'user',
            timestamp: new Date(at(1)).toISOString(),
            message: { content: SENTINELS[0] },
          }) + '\n',
        );
        stamp(outside, CLOCK);
        symlinkSync(outside, parent);
      } else if (parentFile === 'housekeeping only') {
        writeFileSync(parent, JSON.stringify({ type: 'cost-state', timestamp: CLOCK }) + '\n');
        stamp(parent, CLOCK);
      } else if (parentFile === 'recent activity') {
        // The ordinary discovery window misses this file. A recent conversation cannot make an idle parent.
        writeFileSync(
          parent,
          JSON.stringify({
            type: 'user',
            timestamp: new Date(CLOCK - 1000).toISOString(),
            message: { content: SENTINELS[0] },
          }) + '\n',
        );
        stamp(parent, CLOCK - 60 * 60_000);
      }
      writeWorkingChild(project, 'agent-a1');

      const body = await hq(server);
      const children = body.agents.filter(
        (agent) => agent.provider === 'claude' && agent.kind === 'child',
      );
      expect(children).toEqual([
        expect.objectContaining({
          state: 'working',
          parentBasis: 'native',
          parentAway: true,
          parentId: null,
        }),
      ]);
    },
  );

  it('keeps the same parent id after an expired parent resumes and is discovered again', async () => {
    let clock = CLOCK;
    const { server, homes } = await start({ now: () => clock });
    const project = join(homes.claudeDir, 'projects', '-work-invented-project');
    const parent = join(project, `${S1}.jsonl`);
    const recordParent = (at: number) => {
      writeFileSync(
        parent,
        JSON.stringify({
          type: 'user',
          timestamp: new Date(at).toISOString(),
          message: { content: SENTINELS[0] },
        }) + '\n',
      );
      stamp(parent, at);
    };
    recordParent(clock - 60 * 60_000);
    writeWorkingChild(project, 'agent-a1');

    const childIn = (body: HqResponse) =>
      body.agents.find((agent) => agent.provider === 'claude' && agent.kind === 'child');
    const initial = await hq(server);
    const parentId = childIn(initial)?.parentId;
    expect(initial.agents.find((agent) => agent.id === parentId)?.state).toBe('idle');

    recordParent(clock);
    // The exact lookup sees the write between full scans. It must stop reporting the parent as idle.
    await vi.waitFor(async () => {
      const body = await hq(server);
      expect(body.agents.find((agent) => agent.id === parentId)?.state).not.toBe('idle');
    });
    clock += FULL_LISTING_EVERY_MS;
    await vi.waitFor(async () => {
      const body = await hq(server);
      expect(body.agents.find((agent) => agent.id === parentId)?.state).toBe('working');
      expect(childIn(body)).toMatchObject({ parentId, parentAway: false });
    });
  });

  it('reads nothing until the first /api/hq, then answers with the sessions the transcripts show', async () => {
    const { server } = await start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(looks.refreshes).toBe(0);

    const body = await hq(server);
    expect(body.feeds).toEqual([
      { id: 'paseo', status: 'unavailable' },
      { id: 'claude', status: 'live' },
      { id: 'codex', status: 'live' },
    ]);
    expect(looks.refreshes).toBeGreaterThan(0);
    // Two Codex rollouts (one spawned by the other) and three Claude Code files (a session, its subagent and another session).
    expect(body.agents).toHaveLength(5);
    expect(
      body.agents.every((agent) => agent.confidence === 'inferred' && agent.seenBy.transcript),
    ).toBe(true);
    const children = body.agents.filter((agent) => agent.kind === 'child');
    expect(children).toHaveLength(2);
    expect(
      children.every((child) => child.parentBasis === 'native' && child.parentId !== null),
    ).toBe(true);
    expect(body.agents.filter((agent) => agent.state === 'waiting')).toHaveLength(1); // the Codex thread asking a question
    // It keeps polling while someone is looking.
    const seen = looks.refreshes;
    await until(() => looks.refreshes > seen, 'another look');
  });

  it('nothing in what it answers or logs is text from a transcript, a title or a path', async () => {
    const { server, homes, logs } = await start();
    const text = JSON.stringify(await hq(server));
    for (const sentinel of SENTINELS) expect(text).not.toContain(sentinel);
    const logged = JSON.stringify(logs);
    for (const sentinel of SENTINELS) expect(logged).not.toContain(sentinel);
    expect(logged).not.toContain(homes.root);
    expect(logged).not.toContain('rollout-');
    expect(text).not.toContain(homes.root);
  });

  it('keeps serving the roster when a transcript timestamp is outside the date range', async () => {
    const { server, homes } = await start();
    const transcript = join(homes.claudeDir, 'projects', 'test-project', 'timestamp.jsonl');
    mkdirSync(join(homes.claudeDir, 'projects', 'test-project'));
    writeFileSync(
      transcript,
      JSON.stringify({
        type: 'user',
        timestamp: 10_000_000_000_000_000,
        message: { content: 'Synthetic test prompt' },
      }) + '\n',
    );
    stamp(transcript, CLOCK);

    const body = await hq(server);
    expect(body.agents).toHaveLength(6);
    expect(body.agents).toContainEqual(
      expect.objectContaining({ state: 'working', lastActivityAt: new Date(CLOCK).toISOString() }),
    );
  });

  it('stops looking when nobody has asked for the idle time, and starts again on the next request', async () => {
    const { server, logs } = await start({ idleMs: 40 });
    await hq(server);
    await until(
      () =>
        logs.some(
          (entry) => entry['message'] === 'hq feeds stopped' || entry['msg'] === 'hq feeds stopped',
        ),
      'the feeds to stop',
    );
    const frozen = await stillFor(80);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(looks.refreshes).toBe(frozen);

    // The next request starts the feeds again. It may answer while the first look is still under way ("starting"), so ask until
    // the feed has finished it.
    let status = (await hq(server)).feeds[1]?.status;
    for (let asked = 0; status !== 'live' && asked < 100; asked += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await hq(server)).feeds[1]?.status;
    }
    expect(status).toBe('live');
    expect(looks.refreshes).toBeGreaterThan(frozen);
  });

  it('stops for good on shutdown', async () => {
    const { server } = await start();
    await hq(server);
    await until(() => looks.refreshes > 1, 'polling');
    await server.shutdown();
    const frozen = await stillFor(60);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(looks.refreshes).toBe(frozen);
  });

  it('reads nothing before first-launch Setup is finished, and says so for each feed', async () => {
    const { server } = await start({ setupDone: false });
    const body = await hq(server);
    expect(body.feeds).toEqual([
      { id: 'paseo', status: 'unavailable' },
      { id: 'claude', status: 'setup_incomplete' },
      { id: 'codex', status: 'setup_incomplete' },
    ]);
    expect(body.agents).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(looks.refreshes).toBe(0);
  });

  it('a process that does not read this machine has no transcript feeds', async () => {
    const { server } = await start({ local: false });
    const response = await call(server.app as never, '/api/hq', { headers: HOST });
    expect(HqResponse.parse(await response.json()).feeds.map((feed) => feed.status)).toEqual([
      'unavailable',
      'unavailable',
      'unavailable',
    ]);
    expect(looks.refreshes).toBe(0);
  });
});
