import { appendFileSync, chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClaudeFeed } from '../../../src/server/collectors/live/claudeFeed.ts';
import { createCodexFeed } from '../../../src/server/collectors/live/codexFeed.ts';
import {
  createTranscriptFeed,
  type TranscriptAgent,
  type TranscriptFeed,
} from '../../../src/server/collectors/live/feed.ts';
import {
  DROP_AFTER_MS,
  PERMISSION_GUESS_MS,
  TRANSCRIPT_POLL_MS,
} from '../../../src/server/collectors/live/heuristics.ts';
import { manualSleep, settle } from '../paseo/liveHelpers.ts';
import { memoryLogger } from '../../server/helpers.ts';
import { R1, R2, R3, S1, S2, at, makeHomes, stamp, type Homes } from './feedHelpers.ts';
import {
  SENTINELS,
  claudePrompt,
  claudeText,
  claudeToolUse,
  codexCustomOutput,
  codexSessionMeta,
  codexTaskComplete,
  codexTaskStarted,
  codexTokenCount,
  line,
} from './lines.ts';

// The transcript feeds over real folders: the invented fixture transcripts copied to a temp home, a clock the test moves, and a sleep it
// releases one tick at a time. What a feed shows, what it keeps, and that it keeps nothing once stopped.

const SESSION = { sessionId: S1 };
let clock: number;
let homes: Homes;
let sleep: ReturnType<typeof manualSleep>;
let log: ReturnType<typeof memoryLogger>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  clock = at(34);
  homes = makeHomes(clock);
  sleep = manualSleep();
  log = memoryLogger('debug');
});
afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

const claude = (over: Partial<Parameters<typeof createClaudeFeed>[0]> = {}) =>
  createClaudeFeed({
    configDirs: () => [homes.claudeDir],
    now: () => clock,
    logger: log.logger,
    sleep,
    ...over,
  });
const codex = (over: Partial<Parameters<typeof createCodexFeed>[0]> = {}) =>
  createCodexFeed({
    homes: () => [homes.codexHome],
    now: () => clock,
    logger: log.logger,
    sleep,
    ...over,
  });

/** Ends the wait between ticks and lets the next tick run. */
async function tick(): Promise<void> {
  const before = sleep.asked.length;
  sleep.release();
  // The tick reads files, which takes real turns of the event loop: it is over when the loop asks to wait again.
  for (let turn = 0; turn < 2_000 && sleep.asked.length === before; turn += 1)
    await new Promise((resolve) => setImmediate(resolve));
  await settle();
}

async function started(feed: TranscriptFeed): Promise<TranscriptFeed> {
  feed.start();
  await feed.ready();
  await settle();
  return feed;
}

const byId = (feed: TranscriptFeed, id: string): TranscriptAgent | undefined =>
  feed.read().agents.find((agent) => agent.sessionId === id);

describe('the Claude Code feed', () => {
  it('names a followed child when its metadata becomes readable without new transcript lines', async () => {
    const id = `${S1}:agent-a1`;
    const sidecar = join(
      homes.claudeDir,
      'projects/-work-invented-project',
      S1,
      'subagents',
      'agent-a1.meta.json',
    );
    const outside = join(homes.root, 'outside.meta.json');
    writeFileSync(outside, '{"agentType":"Wrong agent"}');
    const feed = await started(claude());
    try {
      expect(byId(feed, id)).not.toHaveProperty('subagentTitle');
      writeFileSync(sidecar, '{');
      await tick();
      expect(byId(feed, id)).not.toHaveProperty('subagentTitle');
      rmSync(sidecar);
      symlinkSync(outside, sidecar);
      await tick();
      expect(byId(feed, id)).not.toHaveProperty('subagentTitle');
      rmSync(sidecar);
      writeFileSync(
        sidecar,
        JSON.stringify({ agentType: 'Oversized', description: 'X'.repeat(16 * 1024) }),
      );
      await tick();
      expect(byId(feed, id)).not.toHaveProperty('subagentTitle');
      writeFileSync(
        sidecar,
        JSON.stringify({ agentType: 'Explore', description: 'SENTINEL_TASK' }),
      );
      await tick();
      expect(byId(feed, id)).toMatchObject({ subagentTitle: 'Explore' });
      expect(JSON.stringify({ snapshot: feed.read(), logs: log.entries })).not.toContain(
        'SENTINEL_TASK',
      );
    } finally {
      await feed.stop();
    }
  });
  it('is starting, then live, and shows main sessions and subagents with their inferred states', async () => {
    const feed = claude();
    expect(feed.status()).toBe('stopped');
    feed.start();
    expect(feed.status()).toBe('starting');
    expect(feed.read().agents).toEqual([]);
    await feed.ready();
    expect(feed.status()).toBe('live');

    const agents = feed.read().agents;
    expect(agents.map((agent) => agent.sessionId).sort()).toEqual(
      [S1, `${S1}:agent-a1`, S2].sort(),
    );
    expect(byId(feed, S1)).toMatchObject({
      provider: 'claude',
      parentSessionId: null,
      cwd: '/work/invented/project',
      state: 'finished',
      activity: 'none',
    });
    expect(byId(feed, `${S1}:agent-a1`)).toMatchObject({ parentSessionId: S1, state: 'finished' });
    expect(byId(feed, S2)).toMatchObject({ state: 'working', activity: 'editing' });
    await feed.stop();
  });

  it('infers "may be waiting" for a call with no result after the guess time, and the states change with the clock alone', async () => {
    const feed = await started(claude());
    clock += PERMISSION_GUESS_MS;
    expect(byId(feed, S2)).toMatchObject({ state: 'waiting', waitReason: 'permission' });
    clock += 2 * 60_000;
    expect(byId(feed, S1)).toMatchObject({ state: 'idle' });
    await feed.stop();
  });

  it('does not guess a permission wait for a session its hooks speak for (a subagent follows its parent), and says so for no other', async () => {
    const feed = await started(claude());
    clock += PERMISSION_GUESS_MS;
    const guesses: string[] = [];
    const read = feed.read({
      guessesPermission: (id) => {
        guesses.push(id);
        return id !== S2;
      },
    });
    expect(read.agents.find((a) => a.sessionId === S2)).toMatchObject({
      state: 'working',
      waitReason: null,
    });
    expect(guesses).toContain(S2);
    // A subagent is asked about by its main session's id, so the parent's hooks cover it.
    expect(guesses).not.toContain(`${S1}:agent-a1`);
    expect(guesses).toContain(S1);
    // A read that asks nothing guesses as before.
    expect(byId(feed, S2)).toMatchObject({ state: 'waiting', waitReason: 'permission' });
    await feed.stop();
  });

  it('reads what is appended on the next tick, and finds a new session file in the folder of a followed one', async () => {
    const feed = await started(claude());
    const project = join(homes.claudeDir, 'projects/-work-invented-project');
    clock += 2_000;
    appendFileSync(
      join(project, `${S2}.jsonl`),
      `${line({ type: 'user', timestamp: new Date(clock).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_write', content: 'SENTINEL_TOOL_OUTPUT' }] } })}\n`,
    );
    const fresh = '33333333-3333-4333-8333-333333333333';
    writeFileSync(
      join(project, `${fresh}.jsonl`),
      `${line(claudePrompt(clock, { sessionId: fresh }))}\n`,
    );
    stamp(project, clock);
    await tick();
    expect(byId(feed, S2)).toMatchObject({ state: 'working', activity: 'thinking' });
    expect(byId(feed, fresh)).toMatchObject({ state: 'working', activity: 'thinking' });
    await feed.stop();
  });

  it('follows a new subagent file under the folder of a followed session', async () => {
    const feed = await started(claude());
    const folder = join(homes.claudeDir, 'projects/-work-invented-project', S2, 'subagents');
    mkdirSync(folder, { recursive: true });
    clock += 2_000;
    writeFileSync(
      join(folder, 'agent-b2.jsonl'),
      `${line(claudePrompt(clock, { sessionId: S2, sidechain: true }))}\n`,
    );
    stamp(folder, clock);
    await tick();
    expect(byId(feed, `${S2}:agent-b2`)).toMatchObject({ parentSessionId: S2, state: 'working' });
    await feed.stop();
  });

  it('starts a session over when its file is replaced', async () => {
    const feed = await started(claude());
    const path = join(homes.claudeDir, 'projects/-work-invented-project', `${S2}.jsonl`);
    clock += 2_000;
    writeFileSync(path, `${line(claudeText(clock, { sessionId: S2 }, 'end_turn'))}\n`);
    stamp(path, clock);
    await tick();
    expect(byId(feed, S2)).toMatchObject({ state: 'finished' });
    await feed.stop();
  });

  it('shows a session that has gone quiet for 15 minutes as gone', async () => {
    const feed = await started(claude());
    clock += 16 * 60_000;
    expect(feed.read().agents).toEqual([]);
    await feed.stop();
  });

  it('stops following a file that was deleted, without a word about it', async () => {
    const feed = await started(claude());
    rmSync(join(homes.claudeDir, 'projects/-work-invented-project', `${S2}.jsonl`));
    clock += 2_000;
    await tick();
    expect(byId(feed, S2)).toBeUndefined();
    expect(feed.status()).toBe('live');
    await feed.stop();
  });

  it('survives a file it may not read, and still shows the others', async () => {
    const path = join(homes.claudeDir, 'projects/-work-invented-project', `${S2}.jsonl`);
    chmodSync(path, 0o000);
    const feed = await started(claude());
    expect(feed.status()).toBe('live');
    expect(byId(feed, S1)).toBeDefined();
    await feed.stop();
    chmodSync(path, 0o644);
  });
});

describe('the Codex feed', () => {
  it('shows rollouts from sessions/ (not archived_sessions/), with identity from the first line', async () => {
    const feed = await started(codex());
    expect(feed.status()).toBe('live');
    expect(
      feed
        .read()
        .agents.map((agent) => agent.sessionId)
        .sort(),
    ).toEqual([R1, R2].sort());
    expect(byId(feed, R1)).toMatchObject({
      provider: 'codex',
      parentSessionId: null,
      cwd: '/work/invented/project',
      startedAt: at(-1),
      state: 'finished',
    });
    expect(byId(feed, R2)).toMatchObject({
      parentSessionId: R1,
      state: 'waiting',
      waitReason: 'question',
    });
    expect(byId(feed, R3)).toBeUndefined();
    await feed.stop();
  });

  it('does not follow a compressed rollout', async () => {
    const day = join(homes.codexHome, 'sessions/2026/11/19');
    writeFileSync(join(day, `rollout-2026-11-19T10-00-09-${S1}.jsonl.zst`), 'not text');
    stamp(day, clock - 500);
    const feed = await started(codex());
    expect(feed.read().agents).toHaveLength(2);
    await feed.stop();
  });

  it('reads what is appended, and finds a rollout created today after the first look', async () => {
    const feed = await started(codex());
    const day = join(homes.codexHome, 'sessions/2026/11/19');
    clock += 2_000;
    appendFileSync(
      join(day, `rollout-2026-11-19T10-00-03-${R2}.jsonl`),
      `${line(codexCustomOutput(clock, 'call_ask'))}\n`,
    );
    const fresh = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    writeFileSync(
      join(day, `rollout-2026-11-19T10-00-36-${fresh}.jsonl`),
      `${line(codexSessionMeta(clock, { id: fresh }))}\n${line(codexTaskStarted(clock))}\n`,
    );
    stamp(day, clock);
    await tick();
    // The question's output arrived, so the spawned thread is no longer waiting; the new rollout is working.
    expect(byId(feed, R2)).toMatchObject({ state: 'working', activity: 'thinking' });
    expect(byId(feed, fresh)).toMatchObject({ state: 'working', activity: 'thinking' });
    await feed.stop();
  });

  it('takes the thread id from the file name when the first line cannot be read, and skips a file that has neither', async () => {
    const day = join(homes.codexHome, 'sessions/2026/11/19');
    const named = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    writeFileSync(
      join(day, `rollout-2026-11-19T10-00-30-${named}.jsonl`),
      `not json\n${line(codexTaskStarted(clock - 1000))}\n`,
    );
    writeFileSync(
      join(day, 'unnamed.jsonl'),
      `not json\n${line(codexTaskStarted(clock - 1000))}\n`,
    );
    stamp(day, clock - 500);
    const feed = await started(codex());
    expect(byId(feed, named)).toMatchObject({ parentSessionId: null, cwd: null, state: 'working' });
    expect(feed.read().agents).toHaveLength(3);
    await feed.stop();
  });

  it('keeps the first record’s identity and nickname when a fork replays its parent’s metadata', async () => {
    const day = join(homes.codexHome, 'sessions/2026/11/19');
    const child = '99999999-9999-4999-8999-999999999999';
    writeFileSync(
      join(day, `rollout-2026-11-19T10-00-20-${child}.jsonl`),
      [
        codexSessionMeta(clock - 5000, {
          id: child,
          source: { subagent: { thread_spawn: { parent_thread_id: R1, agent_nickname: 'Atlas' } } },
        }),
        codexSessionMeta(clock - 4000, { id: R1 }),
        codexTaskStarted(clock - 1000),
        codexTaskComplete(clock - 500),
      ]
        .map(line)
        .join('\n') + '\n',
    );
    stamp(day, clock - 500);
    const feed = await started(codex());
    expect(byId(feed, child)).toMatchObject({
      parentSessionId: R1,
      state: 'finished',
      subagentTitle: 'Atlas',
    });
    await feed.stop();
  });
});

// Lines a provider appends that carry no conversation and, often, no time (Claude Code's `cost-state`, a Codex `token_count` with no
// timestamp). Such a line is written when it is written, not when the conversation happened: it must neither bring an old session back
// nor keep one that is over on the roster (data-and-sources › Live roster (HQ) › What keeps a session on the roster).
const withoutTime = (record: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'timestamp'));
const costState = (sessionId: string) => ({ type: 'cost-state', sessionId, costUSD: 1.25 });

describe('bookkeeping lines', () => {
  const NEW_CLAUDE = '33333333-3333-4333-8333-333333333333';
  const NEW_CODEX = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const claudeFile = () =>
    join(homes.claudeDir, 'projects/-work-invented-project', `${NEW_CLAUDE}.jsonl`);
  const codexFile = () =>
    join(homes.codexHome, 'sessions/2026/11/19', `rollout-2026-11-19T08-00-00-${NEW_CODEX}.jsonl`);

  it.each([
    {
      provider: 'Claude Code',
      id: NEW_CLAUDE,
      path: claudeFile,
      makeFeed: claude,
      records: (old: number, now: number) => [
        claudePrompt(old, { sessionId: NEW_CLAUDE }),
        { type: 'queue-operation', timestamp: new Date(now).toISOString() },
      ],
    },
    {
      provider: 'Codex',
      id: NEW_CODEX,
      path: codexFile,
      makeFeed: codex,
      records: (old: number, now: number) => [
        codexSessionMeta(old, { id: NEW_CODEX }),
        codexTaskStarted(old),
        codexTokenCount(now),
      ],
    },
  ])('$provider: a timestamped record cannot revive an expired unfinished turn', async (entry) => {
    const file = entry.path();
    const records = entry.records(clock - DROP_AFTER_MS, clock);
    writeFileSync(file, records.map((record) => `${line(record)}\n`).join(''));
    stamp(file, clock);
    const feed = await started(entry.makeFeed());
    const agent = byId(feed, entry.id);
    await feed.stop();
    expect(agent).toBeUndefined();
  });

  it('an old Claude Code conversation followed by fresh bookkeeping lines is not on the roster, and stays off', async () => {
    const ctx = { sessionId: NEW_CLAUDE };
    writeFileSync(
      claudeFile(),
      [
        claudePrompt(clock - 2 * 3_600_000, ctx),
        claudeText(clock - 2 * 3_600_000 + 5_000, ctx, 'end_turn'),
        costState(NEW_CLAUDE),
        costState(NEW_CLAUDE),
      ]
        .map((record) => `${line(record)}\n`)
        .join(''),
    );
    stamp(claudeFile(), clock);
    const feed = await started(claude());
    expect(byId(feed, NEW_CLAUDE)).toBeUndefined();
    // More bookkeeping is appended while the app is open: still not a session that is there.
    clock += 2_000;
    appendFileSync(claudeFile(), `${line(costState(NEW_CLAUDE))}\n`);
    stamp(claudeFile(), clock);
    await tick();
    expect(byId(feed, NEW_CLAUDE)).toBeUndefined();
    await feed.stop();
  });

  it('a Claude Code conversation that ended recently leaves the roster 15 minutes after its last conversation line, however much bookkeeping follows', async () => {
    const ctx = { sessionId: NEW_CLAUDE };
    const ended = clock - 10 * 60_000;
    writeFileSync(
      claudeFile(),
      [claudePrompt(ended - 5_000, ctx), claudeText(ended, ctx, 'end_turn'), costState(NEW_CLAUDE)]
        .map((record) => `${line(record)}\n`)
        .join(''),
    );
    stamp(claudeFile(), clock);
    const feed = await started(claude());
    expect(byId(feed, NEW_CLAUDE)).toMatchObject({ state: 'idle', lastActivityAt: ended });
    clock = ended + DROP_AFTER_MS + 1_000;
    appendFileSync(claudeFile(), `${line(costState(NEW_CLAUDE))}\n`);
    stamp(claudeFile(), clock);
    await tick();
    expect(byId(feed, NEW_CLAUDE)).toBeUndefined();
    await feed.stop();
  });

  it('a conversation line that carries no time is still seen when it was read, as before', async () => {
    const ctx = { sessionId: NEW_CLAUDE };
    writeFileSync(claudeFile(), `${line(withoutTime(claudePrompt(clock, ctx)))}\n`);
    stamp(claudeFile(), clock);
    const feed = await started(claude());
    expect(byId(feed, NEW_CLAUDE)).toMatchObject({ state: 'working', activity: 'thinking' });
    await feed.stop();
  });

  it('an old Codex conversation followed by lines with no time is not on the roster, and stays off', async () => {
    const old = clock - 2 * 3_600_000;
    writeFileSync(
      codexFile(),
      [
        codexSessionMeta(old, { id: NEW_CODEX }),
        codexTaskStarted(old),
        codexTaskComplete(old + 5_000),
        withoutTime(codexTokenCount(old)),
        withoutTime(codexTokenCount(old)),
      ]
        .map((record) => `${line(record)}\n`)
        .join(''),
    );
    stamp(codexFile(), clock);
    const feed = await started(codex());
    expect(byId(feed, NEW_CODEX)).toBeUndefined();
    clock += 2_000;
    appendFileSync(codexFile(), `${line(withoutTime(codexTokenCount(clock)))}\n`);
    stamp(codexFile(), clock);
    await tick();
    expect(byId(feed, NEW_CODEX)).toBeUndefined();
    await feed.stop();
  });
});

describe('statuses', () => {
  it.each([
    ['Claude Code', () => claude({ configDirs: () => [join(homes.root, 'nothing')] })],
    ['Codex', () => codex({ homes: () => [join(homes.root, 'nothing')] })],
  ])('%s: a machine without the provider is notfound, quietly', async (_name, make) => {
    const feed = await started(make());
    expect(feed.status()).toBe('notfound');
    expect(feed.read().agents).toEqual([]);
    await feed.stop();
    expect(
      log.entries.some((entry) => entry['level'] === 'warn' || entry['level'] === 'error'),
    ).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)('a folder that may not be read is denied', async () => {
    chmodSync(join(homes.claudeDir, 'projects'), 0o000);
    const feed = await started(claude());
    expect(feed.status()).toBe('denied');
    expect(feed.read().agents).toEqual([]);
    await feed.stop();
    chmodSync(join(homes.claudeDir, 'projects'), 0o755);
  });

  it('a look that throws is failed, logged with a fixed code, and tried again', async () => {
    let fail = true;
    const feed = claude({
      configDirs: () => {
        if (fail) throw new Error(`boom ${homes.root} SENTINEL_ERROR_TEXT`);
        return [homes.claudeDir];
      },
    });
    feed.start();
    await feed.ready();
    expect(feed.status()).toBe('failed');
    expect(JSON.stringify(log.entries)).toContain('tick_failed');
    fail = false;
    clock += 60_000;
    stamp(homes.root, clock - 1000);
    await tick();
    expect(feed.status()).toBe('live');
    await feed.stop();
  });

  it('a root that appears later is found by the next full listing', async () => {
    const feed = await started(claude({ configDirs: () => [join(homes.root, 'later')] }));
    expect(feed.status()).toBe('notfound');
    cpSyncProjects(join(homes.root, 'later'));
    clock += 60_000;
    stamp(join(homes.root, 'later'), clock - 1000);
    await tick();
    expect(feed.status()).toBe('live');
    await feed.stop();
  });
});

function cpSyncProjects(dir: string): void {
  const project = join(dir, 'projects/-work-invented-project');
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, `${S1}.jsonl`),
    `${line(claudeToolUse(clock - 500, SESSION, 'x', 'Read'))}\n`,
  );
}

describe('what is kept, said and dropped', () => {
  it('keeps only allowlisted data and leaves labels, paths and conversation text out of logs', async () => {
    const claudeFeed = await started(claude());
    const codexFeed = await started(codex());
    clock += PERMISSION_GUESS_MS;
    const shown = JSON.stringify([claudeFeed.read(), codexFeed.read()]);
    const logged = JSON.stringify(log.entries);
    for (const sentinel of SENTINELS) {
      expect(shown).not.toContain(sentinel);
      expect(logged).not.toContain(sentinel);
    }
    expect(logged).not.toContain(homes.root);
    expect(logged).not.toContain('.jsonl');
    expect(logged).not.toContain('Atlas');
    // What a record holds is exactly these fields.
    for (const agent of [...claudeFeed.read().agents, ...codexFeed.read().agents]) {
      expect(Object.keys(agent).sort()).toEqual(
        [
          'activity',
          'cwd',
          'lastActivityAt',
          'parentSessionId',
          'provider',
          'sessionId',
          'since',
          'startedAt',
          'state',
          ...(agent.sessionId === R2 ? ['subagentTitle'] : []),
          'waitReason',
        ].sort(),
      );
    }
    await claudeFeed.stop();
    await codexFeed.stop();
  });

  it.each([
    ['Claude Code', () => claude()],
    ['Codex', () => codex()],
  ])(
    '%s: stop leaves no timer, no roster and no memory of the files, and the feed can start again',
    async (_name, make) => {
      const feed = await started(make());
      expect(feed.read().agents.length).toBeGreaterThan(0);
      expect(sleep.pending).toBe(1);
      await feed.stop();
      expect(feed.status()).toBe('stopped');
      expect(feed.read().agents).toEqual([]);
      expect(sleep.pending).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      await feed.stop(); // safe twice

      // Nothing about the folders survives: with the files gone, a new start finds nothing (no stale session, no remembered path).
      rmSync(join(homes.root), { recursive: true, force: true });
      await started(feed);
      expect(feed.status()).toBe('notfound');
      expect(feed.read().agents).toEqual([]);
      await feed.stop();
      expect(sleep.pending).toBe(0);
    },
  );

  it('a stop before the first look ends cleanly: no timer, no throw, ready resolves', async () => {
    const feed = claude();
    feed.start();
    const stopped = feed.stop();
    await expect(feed.ready()).resolves.toBeUndefined();
    await stopped;
    expect(feed.status()).toBe('stopped');
    expect(sleep.pending).toBe(0);
  });

  it('start twice is one loop, and the loop asks to wait the poll interval', async () => {
    const feed = claude();
    feed.start();
    feed.start();
    await feed.ready();
    await settle();
    expect(sleep.asked).toEqual([TRANSCRIPT_POLL_MS]);
    await feed.stop();
  });

  it('a stopped feed that is looked at after stop reads nothing from disk (no file is opened)', async () => {
    const feed = await started(claude());
    await feed.stop();
    // Make the files unreadable: a feed that still held a stream or a path would fail or show something.
    chmodSync(join(homes.claudeDir, 'projects'), 0o000);
    expect(feed.read().agents).toEqual([]);
    chmodSync(join(homes.claudeDir, 'projects'), 0o755);
  });
});

describe('a read in flight', () => {
  it('is aborted by stop: the signal fires, and stop returns without waiting for the read to finish', async () => {
    let signal: AbortSignal | null = null;
    const feed = createTranscriptFeed({
      now: () => clock,
      logger: log.logger,
      sleep,
      source: {
        provider: 'claude',
        roots: () => [join(homes.claudeDir, 'projects')],
        accept: (rel) => rel.endsWith('.jsonl'),
        hotDirs: () => [],
        // A source that never finishes by itself, as a read of a file that stalls would not.
        start: (_file, own) =>
          new Promise((_resolve, reject) => {
            signal = own;
            own.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
      },
    });
    feed.start();
    for (let turn = 0; turn < 2_000 && signal === null; turn += 1)
      await new Promise((resolve) => setImmediate(resolve));
    expect(signal).not.toBeNull();
    expect((signal as AbortSignal | null)?.aborted).toBe(false);
    await feed.stop();
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    expect(feed.status()).toBe('stopped');
    expect(feed.read().agents).toEqual([]);
    expect(sleep.pending).toBe(0);
  });
});
