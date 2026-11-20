import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaseoLiveFeed } from '../../../src/server/collectors/paseo/live.ts';
import { createHqService } from '../../../src/server/services/hq/service.ts';
import { liveAgent, manualSleep } from '../../collectors/paseo/liveHelpers.ts';
import { NOW, memoryLogger } from '../helpers.ts';

// The roster service's repo lookup remembers each roster folder (the full working directory and `.git` paths). It must not outlive
// the feed: when the demand gate stops the feed, the lookup is dropped. The lookup is replaced by a counter here, so the test sees
// when a new one is made.
const resolvers = vi.hoisted(() => ({ made: 0, asked: [] as (string | null | undefined)[][] }));
vi.mock('../../../src/server/collectors/ingest/repo.ts', () => ({
  createRepoResolver: () => {
    const mine: (string | null | undefined)[] = [];
    resolvers.made += 1;
    resolvers.asked.push(mine);
    return (cwd: string | null | undefined) => {
      mine.push(cwd);
      return { repoId: 'owner/name', basis: 'git_config' as const };
    };
  },
}));

beforeEach(() => {
  resolvers.made = 0;
  resolvers.asked = [];
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** A feed that is live with one agent as soon as it is started, and counts its stops. */
function liveFeed() {
  let status: ReturnType<PaseoLiveFeed['status']> = 'stopped';
  const feed: PaseoLiveFeed & { stops: number } = {
    stops: 0,
    start: () => {
      status = 'live';
    },
    stop: () => {
      feed.stops += 1;
      status = 'stopped';
      return Promise.resolve();
    },
    ready: () => Promise.resolve(),
    status: () => status,
    read: () => ({
      agents: [
        liveAgent({ id: 'a-1', status: 'running', cwd: '/work/invented/project', title: 'busy' }),
      ],
      truncated: false,
    }),
  };
  return feed;
}

describe('the roster service and the repo lookup', () => {
  it('keeps the lookup between requests while the feed runs', async () => {
    const feed = liveFeed();
    const service = createHqService({
      feeds: { paseo: feed },
      now: () => NOW,
      logger: memoryLogger('debug').logger,
      waitsForSetup: () => false,
      sleep: manualSleep(),
    });
    await service.snapshot();
    await service.snapshot();
    expect(resolvers.made).toBe(1);
    expect(resolvers.asked[0]).toEqual(['/work/invented/project', '/work/invented/project']);
    await service.close();
  });

  it('drops the lookup when the feed is stopped for want of a request, so the next one starts empty', async () => {
    const feed = liveFeed();
    const service = createHqService({
      feeds: { paseo: feed },
      now: () => NOW, // time does not pass: only the stop can be why a new lookup is made
      logger: memoryLogger('debug').logger,
      waitsForSetup: () => false,
      idleMs: 30_000,
      sleep: manualSleep(),
    });
    expect((await service.snapshot()).agents).toHaveLength(1);
    expect(resolvers.made).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(feed.stops).toBe(1);

    expect((await service.snapshot()).agents).toHaveLength(1);
    expect(resolvers.made).toBe(2);
    expect(resolvers.asked[0]).toEqual(['/work/invented/project']); // the first lookup was not asked again
    await service.close();
  });

  it('drops the lookup when the service is closed, even if stopping the feed fails', async () => {
    const feed = liveFeed();
    feed.stop = () => Promise.reject(new Error('boom'));
    const service = createHqService({
      feeds: { paseo: feed },
      now: () => NOW,
      logger: memoryLogger('debug').logger,
      waitsForSetup: () => false,
      idleMs: 30_000,
      sleep: manualSleep(),
    });
    await service.snapshot();
    await vi.advanceTimersByTimeAsync(30_000);
    await service.snapshot();
    expect(resolvers.made).toBe(2);
    await service.close();
  });
});
