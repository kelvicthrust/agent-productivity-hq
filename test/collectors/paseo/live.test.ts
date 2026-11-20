import { describe, expect, it } from 'vitest';
import {
  LIVE_LIST_TIMEOUT_MS,
  LIVE_POLL_MS,
  PASSWORD_RETRY_MS,
  RETRY_MAX_MS,
  createPaseoLiveFeed,
  retryDelay,
  type PaseoLiveFeed,
} from '../../../src/server/collectors/paseo/live.ts';
import { createHqService } from '../../../src/server/services/hq/service.ts';
import { memoryLogger } from '../../server/helpers.ts';
import { connectErrors } from './helpers.ts';
import {
  NOW,
  SENTINELS,
  entry,
  fakeLiveDaemon,
  manualSleep,
  minutesAgo,
  settle,
  type FakeLiveDaemon,
  type ManualSleep,
} from './liveHelpers.ts';

// The live feed over a fake daemon and a sleep the test releases: no socket, no real timer, no real Paseo. Waits are released by hand,
// so "after 1 s, then 2 s" is an assertion on what the feed asked to wait, not on the clock. The feed asks the daemon for the whole
// listing every LIVE_POLL_MS, so "the daemon changed" is `daemon.entries = [...]` and "the next poll" is `sleep.releaseMs(2_000)`.

const URL = 'ws://127.0.0.1:6767/ws';

function setup(daemon: FakeLiveDaemon = fakeLiveDaemon()) {
  const sleep = manualSleep();
  const { logger, entries: logs } = memoryLogger('debug');
  const feed = createPaseoLiveFeed({
    url: URL,
    open: daemon.open,
    now: () => NOW,
    logger,
    sleep,
    random: () => 0,
  });
  return { daemon, sleep, feed, logs };
}

/** The waits the feed asked for, without the deadline it sets on each listing (that one is released only to time a listing out). */
const waits = (sleep: ManualSleep): number[] =>
  sleep.asked.filter((ms) => ms !== LIVE_LIST_TIMEOUT_MS);

/** Runs the next poll to its end. */
async function poll(sleep: ManualSleep): Promise<void> {
  sleep.releaseMs(LIVE_POLL_MS);
  await settle();
}

const ids = (feed: PaseoLiveFeed): string[] =>
  feed
    .read()
    .agents.map((agent) => agent.id)
    .sort();

describe('the live feed', () => {
  it('asks for the plain listing, without a subscription, and takes the entries as the full set', async () => {
    const { daemon, feed } = setup(
      fakeLiveDaemon([
        entry({ id: 'a-1' }),
        entry({ id: 'a-2', status: 'running' }),
        entry({ id: 'a-gone', archivedAt: minutesAgo(5) }),
      ]),
    );
    expect(feed.status()).toBe('stopped');
    feed.start();
    expect(feed.status()).toBe('starting');
    await feed.ready();

    expect(feed.status()).toBe('live');
    expect(ids(feed)).toEqual(['a-1', 'a-2']);
    expect(daemon.opened).toEqual([URL]);
    // Exactly these keys: a `subscribe` would show up as an extra one.
    expect(daemon.lists).toEqual([
      {
        includeBackground: true,
        filter: { includeBackground: true, includeArchived: false },
        page: { limit: 200 },
      },
    ]);
    await feed.stop();
  });

  it('polls the listing every 2 s over the one connection', async () => {
    const { daemon, sleep, feed } = setup(fakeLiveDaemon([entry({ id: 'a-1' })]));
    feed.start();
    await feed.ready();
    await settle();
    expect(waits(sleep)).toEqual([LIVE_POLL_MS]);
    expect(daemon.lists).toHaveLength(1);

    await poll(sleep);
    await poll(sleep);
    expect(daemon.lists).toHaveLength(3);
    expect(waits(sleep)).toEqual([LIVE_POLL_MS, LIVE_POLL_MS, LIVE_POLL_MS]);
    expect(daemon.opened).toHaveLength(1);
    expect(feed.status()).toBe('live');
    await feed.stop();
  });

  it('shows a change on the next poll: an agent added, one changed, one removed, one archived', async () => {
    const { daemon, sleep, feed } = setup(
      fakeLiveDaemon([entry({ id: 'a-1' }), entry({ id: 'a-3' })]),
    );
    feed.start();
    await feed.ready();
    await settle();

    daemon.entries = [
      entry({ id: 'a-1', status: 'running', title: 'renamed' }),
      entry({ id: 'a-2', status: 'running', title: 'second' }),
      entry({ id: 'a-3' }),
    ];
    expect(ids(feed)).toEqual(['a-1', 'a-3']); // not before the poll
    await poll(sleep);
    expect(ids(feed)).toEqual(['a-1', 'a-2', 'a-3']);
    expect(feed.read().agents.find((agent) => agent.id === 'a-1')).toMatchObject({
      status: 'running',
      title: 'renamed',
    });

    daemon.entries = [entry({ id: 'a-2' }), entry({ id: 'a-3', archivedAt: minutesAgo(0) })];
    await poll(sleep);
    expect(ids(feed)).toEqual(['a-2']); // a-1 removed, a-3 archived
    await feed.stop();
  });

  it('says whether the daemon had more than one page, on every poll', async () => {
    const { daemon, sleep, feed } = setup(fakeLiveDaemon([entry({ id: 'a-1' })]));
    feed.start();
    await feed.ready();
    await settle();
    expect(feed.read().truncated).toBe(false);

    daemon.hasMore = true;
    daemon.entries = [entry({ id: 'a-3' })];
    await poll(sleep);
    expect(ids(feed)).toEqual(['a-3']);
    expect(feed.read().truncated).toBe(true);
    await feed.stop();
  });

  it('keeps only the named fields of each agent, nothing of the raw answer', async () => {
    const { feed } = setup(fakeLiveDaemon([entry({ id: 'a-1', permissions: ['tool'] })]));
    feed.start();
    await feed.ready();
    expect(Object.keys(feed.read().agents[0] ?? {}).sort()).toEqual(
      [
        'id',
        'provider',
        'cwd',
        'title',
        'workspaceName',
        'parentAgentId',
        'sessionId',
        'status',
        'turnStartedAt',
        'pendingPermissionKind',
        'requiresAttention',
        'attentionReason',
        'attentionAt',
        'updatedAt',
        'createdAt',
        'archived',
        'providerUnavailable',
      ].sort(),
    );
    await feed.stop();
  });

  it('drops an entry without an id', async () => {
    const { daemon, feed } = setup(fakeLiveDaemon());
    daemon.entries = [{ agent: { title: 'no id' } }, {}, null, 'text', entry({ id: 'a-1' })];
    feed.start();
    await feed.ready();
    expect(ids(feed)).toEqual(['a-1']);
    await feed.stop();
  });

  describe('when the daemon cannot be reached', () => {
    it('says notrunning for a refused connection and tries again after 1 s', async () => {
      const { daemon, sleep, feed } = setup();
      daemon.script(connectErrors.refused());
      feed.start();
      await feed.ready();
      await settle();

      expect(feed.status()).toBe('notrunning');
      expect(feed.read()).toEqual({ agents: [], truncated: false });
      expect(sleep.asked).toEqual([1_000]);
      expect(daemon.clients[0]?.closed).toBe(true);

      sleep.release();
      await settle();
      expect(feed.status()).toBe('live');
      expect(daemon.opened).toHaveLength(2);
      await feed.stop();
    });

    it('says needspassword, answers no password, and does not ask again for a minute', async () => {
      const { daemon, sleep, feed, logs } = setup();
      daemon.script(connectErrors.password());
      feed.start();
      await feed.ready();
      await settle();

      expect(feed.status()).toBe('needspassword');
      expect(sleep.asked).toEqual([PASSWORD_RETRY_MS]);
      expect(JSON.stringify(logs)).not.toMatch(/password required/i);
      await feed.stop();
    });

    it('says failed for a timeout, and keeps the code in the log and nothing else', async () => {
      const { daemon, feed, logs } = setup();
      daemon.script(connectErrors.timeout());
      feed.start();
      await feed.ready();
      await settle();

      expect(feed.status()).toBe('failed');
      expect(logs.find((line) => line.msg === 'paseo live feed failed')).toMatchObject({
        code: 'connect_timeout',
      });
      await feed.stop();
    });

    it('a daemon that cannot list is failed, and the code in the log is one of the fixed list', async () => {
      const daemon = fakeLiveDaemon();
      daemon.scriptLists(Object.assign(new Error('boom'), { code: 'ECONNRESET' }));
      const { feed, logs } = setup(daemon);
      feed.start();
      await feed.ready();
      await settle();
      expect(feed.status()).toBe('failed');
      expect(logs.find((line) => line.msg === 'paseo live feed failed')).toMatchObject({
        code: 'econnreset',
      });
      await feed.stop();
    });

    it('logs the generic code failed for any code that is not on the fixed list', async () => {
      const daemon = fakeLiveDaemon();
      daemon.scriptLists(
        Object.assign(new Error('SENTINEL_RPC_MESSAGE'), { code: 'PERMISSION_DENIED_FOR_X' }),
      );
      const { feed, logs } = setup(daemon);
      feed.start();
      await feed.ready();
      await settle();
      expect(feed.status()).toBe('failed');
      expect(logs.find((line) => line.msg === 'paseo live feed failed')).toMatchObject({
        code: 'failed',
      });
      expect(JSON.stringify(logs).toLowerCase()).not.toMatch(/permission_denied|sentinel_rpc/);
      await feed.stop();
    });

    it('a daemon that asks for the password at the first listing is needspassword', async () => {
      const daemon = fakeLiveDaemon();
      daemon.scriptLists(connectErrors.password());
      const { sleep, feed } = setup(daemon);
      feed.start();
      await feed.ready();
      await settle();
      expect(feed.status()).toBe('needspassword');
      expect(waits(sleep)).toEqual([PASSWORD_RETRY_MS]);
      await feed.stop();
    });

    it('a first listing that is never answered times out after 5 s: failed, client closed, backoff, then a new connection lists again', async () => {
      const { daemon, sleep, feed, logs } = setup(fakeLiveDaemon([entry({ id: 'a-1' })]));
      daemon.scriptLists('hang');
      feed.start();
      await settle();
      expect(feed.status()).toBe('starting');
      expect(sleep.asked).toEqual([LIVE_LIST_TIMEOUT_MS]);

      sleep.releaseMs(LIVE_LIST_TIMEOUT_MS);
      await settle();
      expect(feed.status()).toBe('failed');
      expect(daemon.clients[0]?.closed).toBe(true);
      expect(waits(sleep)).toEqual([1_000]);
      expect(logs.find((line) => line.msg === 'paseo live feed failed')).toMatchObject({
        code: 'list_timeout',
      });

      sleep.releaseMs(1_000);
      await settle();
      expect(feed.status()).toBe('live');
      expect(ids(feed)).toEqual(['a-1']);
      expect(daemon.opened).toHaveLength(2);
      await feed.stop();
    });

    it('a daemon that drops before answering the first listing is a lost connection, not a slow one', async () => {
      const { daemon, sleep, feed, logs } = setup();
      daemon.scriptLists('hang');
      feed.start();
      await settle();
      daemon.drop();
      sleep.releaseMs(LIVE_LIST_TIMEOUT_MS);
      await settle();
      expect(feed.status()).toBe('failed');
      expect(logs.find((line) => line.msg === 'paseo live feed failed')).toMatchObject({
        code: 'connection_lost',
      });
      expect(daemon.clients[0]?.closed).toBe(true);
      await feed.stop();
    });

    it('backs off 1, 2, 4, 8, 16 s and then holds at 30 s', async () => {
      const { daemon, sleep, feed } = setup();
      daemon.script(...Array.from({ length: 8 }, () => connectErrors.refused()));
      feed.start();
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await settle();
        sleep.release();
      }
      await settle();
      expect(sleep.asked.slice(0, 8)).toEqual([
        1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
      ]);
      await feed.stop();
    });
  });

  describe('retryDelay', () => {
    it('doubles to a cap and takes up to 20 % off for jitter, never going under the password minute', () => {
      expect([1, 2, 3, 4, 5, 6, 7].map((n) => retryDelay(n, 0, false))).toEqual([
        1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
      ]);
      expect(retryDelay(1, 1, false)).toBe(800);
      expect(retryDelay(20, 1, false)).toBeLessThanOrEqual(RETRY_MAX_MS);
      expect(retryDelay(1, 1, true)).toBe(PASSWORD_RETRY_MS);
      expect(retryDelay(7, 0, true)).toBe(PASSWORD_RETRY_MS);
    });
  });

  describe('when a live connection drops or stops answering', () => {
    it('notices a drop between polls at the next one, clears the roster, closes the client, waits 1 s and resyncs', async () => {
      const { daemon, sleep, feed } = setup(fakeLiveDaemon([entry({ id: 'a-1' })]));
      feed.start();
      await feed.ready();
      await settle();
      expect(waits(sleep)).toEqual([LIVE_POLL_MS]);

      daemon.entries = [entry({ id: 'a-1' }), entry({ id: 'a-2' })]; // what the daemon will say next time
      daemon.drop();
      await poll(sleep);

      expect(feed.status()).toBe('failed');
      expect(feed.read().agents).toEqual([]);
      expect(daemon.clients[0]?.closed).toBe(true);
      expect(daemon.lists).toHaveLength(1); // the dropped connection was not asked again
      expect(waits(sleep).slice(1)).toEqual([1_000]);

      sleep.releaseMs(1_000);
      await settle();
      expect(feed.status()).toBe('live');
      expect(ids(feed)).toEqual(['a-1', 'a-2']);
      expect(daemon.opened).toHaveLength(2);
      expect(daemon.connected).toBe(1);
      await feed.stop();
    });

    it('a poll that fails ends the connection: failed with its code, client closed, backoff, resync', async () => {
      const { daemon, sleep, feed, logs } = setup(fakeLiveDaemon([entry({ id: 'a-1' })]));
      feed.start();
      await feed.ready();
      await settle();

      daemon.scriptLists(Object.assign(new Error('SENTINEL_POLL_ERROR'), { code: 'EPIPE' }));
      await poll(sleep);
      expect(feed.status()).toBe('failed');
      expect(feed.read().agents).toEqual([]);
      expect(daemon.clients[0]?.closed).toBe(true);
      expect(waits(sleep).slice(1)).toEqual([1_000]);
      expect(logs.find((line) => line.msg === 'paseo live feed failed')).toMatchObject({
        code: 'epipe',
      });

      sleep.releaseMs(1_000);
      await settle();
      expect(feed.status()).toBe('live');
      expect(daemon.opened).toHaveLength(2);
      await feed.stop();
    });

    it('a poll that is never answered times out after 5 s and the connection is rebuilt', async () => {
      const { daemon, sleep, feed, logs } = setup(fakeLiveDaemon([entry({ id: 'a-1' })]));
      feed.start();
      await feed.ready();
      await settle();

      daemon.scriptLists('hang');
      await poll(sleep);
      expect(feed.status()).toBe('live'); // still waiting for the answer
      sleep.releaseMs(LIVE_LIST_TIMEOUT_MS);
      await settle();
      expect(feed.status()).toBe('failed');
      expect(daemon.clients[0]?.closed).toBe(true);
      expect(logs.filter((line) => line.msg === 'paseo live feed failed')).toMatchObject([
        { code: 'list_timeout' },
      ]);

      sleep.releaseMs(1_000);
      await settle();
      expect(feed.status()).toBe('live');
      await feed.stop();
    });

    it('a poll that asks for a password is needspassword, and is not asked again for a minute', async () => {
      const { daemon, sleep, feed } = setup(fakeLiveDaemon([entry({ id: 'a-1' })]));
      feed.start();
      await feed.ready();
      await settle();

      daemon.scriptLists(connectErrors.password());
      await poll(sleep);
      expect(feed.status()).toBe('needspassword');
      expect(waits(sleep).at(-1)).toBe(PASSWORD_RETRY_MS);
      await feed.stop();
    });

    it('a daemon that stays up resets the wait: a later drop waits 1 s again', async () => {
      const { daemon, sleep, feed } = setup(fakeLiveDaemon([entry({ id: 'a-1' })]));
      daemon.script(connectErrors.refused(), connectErrors.refused());
      feed.start();
      await settle();
      sleep.release(); // after 1 s: refused again
      await settle();
      sleep.release(); // after 2 s: connects
      await settle();
      expect(feed.status()).toBe('live');

      daemon.drop();
      await poll(sleep);
      expect(waits(sleep).at(-1)).toBe(1_000);
      await feed.stop();
    });
  });

  describe('stop', () => {
    it('during a connect that never answers aborts it, closes the client and leaves no wait', async () => {
      const { daemon, sleep, feed } = setup();
      daemon.script('hang');
      feed.start();
      await settle();
      expect(feed.status()).toBe('starting');
      expect(daemon.clients[0]?.closed).toBe(false);

      await feed.stop();
      expect(daemon.clients[0]?.closed).toBe(true);
      expect(daemon.connected).toBe(0);
      expect(sleep.pending).toBe(0);
      expect(feed.status()).toBe('stopped');
      await feed.ready(); // does not hang
      // Nothing comes back later.
      await settle();
      expect(daemon.opened).toHaveLength(1);
    });

    it('during a listing that never answers aborts it, closes the client and leaves no wait, deadline included', async () => {
      const { daemon, sleep, feed } = setup(fakeLiveDaemon([entry({ id: 'a-1' })]));
      daemon.scriptLists('hang');
      feed.start();
      await settle();
      expect(sleep.pending).toBe(1); // the listing's deadline

      await feed.stop();
      expect(daemon.clients[0]?.closed).toBe(true);
      expect(daemon.connected).toBe(0);
      expect(sleep.pending).toBe(0);
      expect(feed.status()).toBe('stopped');
      await feed.ready();
      await settle();
      expect(daemon.opened).toHaveLength(1);
    });

    it('while live closes the connection, clears the roster and leaves no wait', async () => {
      const { daemon, sleep, feed } = setup(fakeLiveDaemon([entry({ id: 'a-1' })]));
      feed.start();
      await feed.ready();
      await settle();
      await feed.stop();

      expect(daemon.clients[0]?.closed).toBe(true);
      expect(sleep.pending).toBe(0);
      expect(feed.read()).toEqual({ agents: [], truncated: false });
      expect(feed.status()).toBe('stopped');
    });

    it('while waiting to retry leaves no wait, and is safe to call twice', async () => {
      const { daemon, sleep, feed } = setup();
      daemon.script(connectErrors.refused());
      feed.start();
      await feed.ready();
      await settle();
      expect(sleep.pending).toBe(1);

      await feed.stop();
      await feed.stop();
      expect(sleep.pending).toBe(0);
      expect(daemon.opened).toHaveLength(1);
    });

    it('can start again afterwards, with a fresh connection', async () => {
      const { daemon, feed } = setup(fakeLiveDaemon([entry({ id: 'a-1' })]));
      feed.start();
      feed.start(); // already started: nothing more
      await feed.ready();
      await feed.stop();
      feed.start();
      await feed.ready();
      expect(feed.status()).toBe('live');
      expect(daemon.opened).toHaveLength(2);
      await feed.stop();
    });
  });
});

describe('privacy', () => {
  it('never lets what Paseo says about errors, permissions, usage or notifications reach the service output or the log', async () => {
    const daemon = fakeLiveDaemon([
      entry({
        id: 'a-1',
        title: 'Visible title',
        status: 'running',
        permissions: ['tool', 'question'],
        attentionReason: 'permission',
        requiresAttention: true,
      }),
      entry({ id: 'a-2', status: 'error', providerUnavailable: true }),
    ]);
    const { feed, sleep, logs } = setup(daemon);
    const { logger, entries: serviceLogs } = memoryLogger('debug');
    const service = createHqService({
      feeds: { paseo: feed },
      now: () => NOW,
      logger,
      waitsForSetup: () => false,
      sleep: manualSleep(),
    });

    // The first request starts the feed and takes the listed agents; the next poll carries an added one, each with the same fields.
    const first = await service.snapshot();
    daemon.entries = [
      ...daemon.entries,
      entry({ id: 'a-3', status: 'running', permissions: ['plan'] }),
    ];
    await poll(sleep);
    const second = await service.snapshot();
    // A failing poll: the daemon's message and code are free text and must reach no log.
    daemon.scriptLists(
      Object.assign(new Error('SENTINEL_LASTERROR SENTINEL_PERMISSION_DETAIL'), {
        code: 'SENTINEL_PRIVATE_PERMISSION_DETAIL',
      }),
    );
    await poll(sleep);
    const third = await service.snapshot();

    expect(second.agents.map((agent) => agent.state).sort()).toEqual([
      'error',
      'waiting',
      'waiting',
    ]);
    expect(first.agents).toHaveLength(2);
    expect(third.feeds[0]?.status).toBe('failed');
    const everything = JSON.stringify([first, second, third, logs, serviceLogs, feed.read()]);
    for (const sentinel of SENTINELS) expect(everything).not.toContain(sentinel);
    expect(everything.toLowerCase()).not.toContain('sentinel_private_permission_detail');
    expect(logs.find((line) => line.msg === 'paseo live feed failed')).toMatchObject({
      code: 'failed',
    });
    // The title is allowed; the working directory and Paseo ids are never logged.
    expect(JSON.stringify([logs, serviceLogs])).not.toMatch(
      /Visible title|\/work\/invented|a-1|a-2/,
    );
    await service.close();
  });
});
