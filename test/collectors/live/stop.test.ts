import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTranscriptFeed } from '../../../src/server/collectors/live/feed.ts';
import { abortError } from '../../../src/server/lib/abortable.ts';
import type { RecentFile } from '../../../src/server/collectors/live/recent.ts';
import { memoryLogger } from '../../server/helpers.ts';
import { manualSleep, settle } from '../paseo/liveHelpers.ts';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open) };
});

// Stopping a transcript feed while it is in the middle of looking: the stop is prompt, the abort reaches the work, and a look that ends
// late changes nothing. The source is a fake with deferred answers, so the test decides when each step ends.

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** What a tracker start or roots lookup that honours its signal does: it ends with an AbortError the moment the signal aborts. */
function endsOnAbort<T>(signal: AbortSignal, until: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    until.then(resolve, reject);
  });
}

function feedOver(over: {
  roots: (signal: AbortSignal) => Promise<readonly string[]> | readonly string[];
  start?: (file: RecentFile, signal: AbortSignal) => Promise<null>;
}) {
  const sleep = manualSleep();
  const { logger, entries } = memoryLogger('debug');
  const feed = createTranscriptFeed({
    now: () => Date.parse('2026-11-19T10:00:00Z'),
    logger,
    sleep,
    source: {
      provider: 'claude',
      roots: over.roots,
      accept: () => true,
      hotDirs: (followed: readonly RecentFile[]) => followed.map((file) => dirname(file.path)),
      start: over.start ?? (() => Promise.resolve(null)),
    },
  });
  return { feed, sleep, entries };
}

describe('stopping a transcript feed during a look', () => {
  it('waits for a roots lookup that is in flight, and its late answer changes nothing', async () => {
    const roots = deferred<readonly string[]>();
    let asked = 0;
    const { feed } = feedOver({
      roots: () => {
        asked += 1;
        return roots.promise; // a lookup that does not look at its signal: nothing is raced against it, so the stop waits for it
      },
    });
    feed.start();
    await settle();
    expect(asked).toBe(1);
    let stopped = false;
    const stopping = feed.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);
    expect(feed.status()).toBe('stopped');
    roots.resolve(['/never/looked/at']);
    await stopping;
    expect(feed.status()).toBe('stopped');
    expect(feed.read()).toEqual({ agents: [], files: 0 });
    expect(asked).toBe(1);
  });

  it('resolves at once when the roots lookup ends on the abort', async () => {
    const roots = deferred<readonly string[]>();
    const { feed } = feedOver({ roots: (signal) => endsOnAbort(signal, roots.promise) });
    feed.start();
    await settle();
    await feed.stop();
    expect(feed.status()).toBe('stopped');
    roots.resolve(['/never/looked/at']);
    await settle();
    expect(feed.read()).toEqual({ agents: [], files: 0 });
  });

  it('aborts synchronously: the signal given to the tracker is aborted as soon as stop() is called, not after it resolves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'live-stop-'));
    try {
      const path = join(dir, 'a.jsonl');
      writeFileSync(path, '{}\n');
      const now = Date.parse('2026-11-19T10:00:00Z');
      utimesSync(path, new Date(now - 1_000), new Date(now - 1_000));
      const starting = deferred<null>();
      let seen: AbortSignal | undefined;
      const { feed } = feedOver({
        roots: () => [dir],
        // A tracker start that honours its signal: the stop waits for it, so it must end on the abort.
        start: (_file, signal) => {
          seen = signal;
          return endsOnAbort(signal, starting.promise);
        },
      });
      feed.start();
      for (let turn = 0; turn < 200 && seen === undefined; turn += 1) await settle();
      expect(seen).toBeDefined();
      expect(seen?.aborted).toBe(false);
      const stopping = feed.stop();
      expect(seen?.aborted).toBe(true); // before anything was awaited
      await stopping;
      starting.resolve(null);
      await settle();
      expect(feed.status()).toBe('stopped');
      expect(feed.read()).toEqual({ agents: [], files: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('closes opened transcript handles before a stop finishes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'live-stop-handles-'));
    const starting = deferred<null>();
    const trackerEntered = deferred<void>();
    const { feed } = feedOver({
      roots: () => [dir],
      start: () => {
        trackerEntered.resolve();
        return starting.promise;
      },
    });
    try {
      const path = join(dir, 'a.jsonl');
      writeFileSync(path, '{}\n');
      const now = Date.parse('2026-11-19T10:00:00Z');
      utimesSync(path, new Date(now), new Date(now));
      vi.mocked(open).mockClear();
      feed.start();
      await trackerEntered.promise;
      const handles = await Promise.all(vi.mocked(open).mock.results.map(({ value }) => value));

      const stopping = feed.stop().then(() => handles.filter(({ fd }) => fd !== -1).length);
      await settle();
      starting.resolve(null);
      const openWhenStopped = await stopping;
      await Promise.all(handles.map((handle) => handle.close()));
      expect(openWhenStopped).toBe(0);
    } finally {
      starting.resolve(null);
      await feed.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('can be started again while a stop waits, and the old look does not touch the new one', async () => {
    const first = deferred<readonly string[]>();
    let calls = 0;
    const { feed } = feedOver({
      roots: () => {
        calls += 1;
        return calls === 1 ? first.promise : [];
      },
    });
    feed.start();
    await settle();
    const stopping = feed.stop(); // waits for the first look's roots
    feed.start();
    await feed.ready();
    expect(feed.status()).toBe('notfound');
    first.resolve(['/old/look']);
    await stopping;
    expect(feed.status()).toBe('notfound');
    await feed.stop();
  });
});
