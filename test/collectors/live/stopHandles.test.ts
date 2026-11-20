import { constants, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClaudeFeed } from '../../../src/server/collectors/live/claudeFeed.ts';
import type { OpenFiles } from '../../../src/server/collectors/live/confined.ts';
import { createCodexFeed } from '../../../src/server/collectors/live/codexFeed.ts';
import {
  createTranscriptFeed,
  type Tracker,
  type TranscriptFeed,
} from '../../../src/server/collectors/live/feed.ts';
import type { RecentFile } from '../../../src/server/collectors/live/recent.ts';
import { abortError } from '../../../src/server/lib/abortable.ts';
import { memoryLogger } from '../../server/helpers.ts';
import { manualSleep, settle } from '../paseo/liveHelpers.ts';
import { at, makeHomes } from './feedHelpers.ts';

// `stop()` resolves only after every file handle the feed opened is closed and no feed code can run again. The file system is real; a
// wrapper around the promise-based calls lets a test hold one call (a listing, a stat) or act the moment a file has been opened, so a
// stop can be placed exactly inside each step of a look.

const gates = vi.hoisted(() => ({
  holds: new Map<string, { entered: () => void; until: Promise<void> }>(),
  resolvedPaths: [] as string[],
  opened: [] as { fd: number; close(): Promise<void> }[],
  /** Files opened so far (a folder's handle is not counted: it is closed by the time the files are read). */
  fileOpens: 0,
  afterOpen: null as null | (() => void),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  const held =
    <F extends (...args: never[]) => Promise<unknown>>(name: string, fn: F) =>
    async (...args: Parameters<F>): Promise<Awaited<ReturnType<F>>> => {
      const hold = gates.holds.get(name);
      if (hold) {
        hold.entered();
        await hold.until;
      }
      return (await fn(...args)) as Awaited<ReturnType<F>>;
    };
  return {
    ...fs,
    readdir: held('readdir', fs.readdir as (...args: never[]) => Promise<unknown>),
    lstat: held('lstat', fs.lstat as (...args: never[]) => Promise<unknown>),
    realpath: (path: string) => {
      gates.resolvedPaths.push(path);
      return held('realpath', fs.realpath)(path);
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      gates.opened.push(handle);
      // A folder's handle (O_DIRECTORY) is a handle to close like the others, but a test that acts "when a file was opened" skips it.
      if (((args[1] as number | undefined) ?? 0) & constants.O_DIRECTORY) return handle;
      gates.fileOpens += 1;
      gates.afterOpen?.();
      return handle;
    },
  };
});

/** A tracker start that honours its signal (a stop waits for it): it ends with an AbortError the moment the signal aborts. */
function endsOnAbort<T>(signal: AbortSignal, until: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    until.then(resolve, reject);
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Holds every call of `name` until `release()`, and says when the first one is in. */
function hold(name: string) {
  const entered = deferred();
  const until = deferred();
  gates.holds.set(name, { entered: entered.resolve, until: until.promise });
  return {
    entered: entered.promise,
    release: () => {
      gates.holds.delete(name);
      until.resolve();
    },
  };
}

const NOW = Date.parse('2026-11-19T10:00:00Z');
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'live-stop-handles-'));
  gates.holds.clear();
  gates.resolvedPaths.length = 0;
  gates.opened.length = 0;
  gates.fileOpens = 0;
  gates.afterOpen = null;
});
afterEach(() => {
  gates.holds.clear();
  gates.afterOpen = null;
  rmSync(dir, { recursive: true, force: true });
});

function writeTranscript(name: string, lines = 5): string {
  const path = join(dir, name);
  writeFileSync(path, Array.from({ length: lines }, (_, n) => `{"n":${n}}\n`).join(''));
  utimesSync(path, new Date(NOW - 1_000), new Date(NOW - 1_000));
  return path;
}

interface Probe {
  /** The `OpenFiles` the feed gave its first tracker start. */
  files: OpenFiles | null;
  starts: number;
  lines: number;
}

function feedOver(
  over: {
    onStart?: (file: RecentFile, probe: Probe, signal: AbortSignal) => Promise<null> | undefined;
    onLine?: () => void;
    roots?: () => readonly string[];
  } = {},
) {
  const sleep = manualSleep();
  const probe: Probe = { files: null, starts: 0, lines: 0 };
  const { logger, entries } = memoryLogger('debug');
  const feed = createTranscriptFeed({
    now: () => NOW,
    logger,
    sleep,
    source: {
      provider: 'claude',
      roots: over.roots ?? (() => [dir]),
      accept: (rel) => rel.endsWith('.jsonl'),
      hotDirs: (followed: readonly RecentFile[]) => followed.map((file) => dirname(file.path)),
      start: async (file, signal, files) => {
        probe.files = files;
        probe.starts += 1;
        await over.onStart?.(file, probe, signal);
        const tracker: Tracker = {
          line: () => {
            probe.lines += 1;
            over.onLine?.();
          },
          overlong: () => undefined,
          agent: () => null,
        };
        return tracker;
      },
    },
  });
  return { feed, sleep, probe, entries };
}

const openCount = () => gates.opened.filter((handle) => handle.fd !== -1).length;

/** What a stopped feed holds, by every measure the test can reach. */
async function expectNothingHeld(feed: TranscriptFeed, sleep: ReturnType<typeof manualSleep>) {
  expect(feed.status()).toBe('stopped');
  expect(feed.read()).toEqual({ agents: [], files: 0 });
  expect(openCount()).toBe(0);
  expect(sleep.pending).toBe(0);
}

describe('stop() waits for the handles', () => {
  it('waits for an in-flight Claude root lookup and skips the remaining roots', async () => {
    const first = join(dir, 'first');
    const second = join(dir, 'second');
    const lookup = hold('realpath');
    const sleep = manualSleep();
    const feed = createClaudeFeed({
      configDirs: () => [first, second],
      now: () => NOW,
      logger: memoryLogger('debug').logger,
      sleep,
    });
    feed.start();
    await lookup.entered;
    let stopped = false;
    const stopping = feed.stop().then(() => {
      stopped = true;
    });
    await settle();
    const stoppedBeforeLookupFinished = stopped;
    lookup.release();
    await stopping;
    await settle();
    expect({ stoppedBeforeLookupFinished, paths: gates.resolvedPaths }).toEqual({
      stoppedBeforeLookupFinished: false,
      paths: [join(first, 'projects')],
    });
    await expectNothingHeld(feed, sleep);
  });

  it('during the listing: it resolves once the listing call that was in flight has ended, and nothing is held', async () => {
    writeTranscript('a.jsonl');
    const listing = hold('readdir');
    const { feed, sleep } = feedOver();
    feed.start();
    await listing.entered;
    let stopped = false;
    const stopping = feed.stop().then(() => {
      stopped = true;
    });
    await settle();
    // The one residual: a file system call that has not answered is waited for (it is not raced and left running).
    expect(stopped).toBe(false);
    listing.release();
    await stopping;
    await expectNothingHeld(feed, sleep);
  });

  it('during the stat loop of the listing', async () => {
    writeTranscript('a.jsonl');
    writeTranscript('b.jsonl');
    const stat = hold('lstat');
    const { feed, sleep, probe } = feedOver();
    feed.start();
    await stat.entered;
    const stopping = feed.stop();
    await settle();
    stat.release();
    await stopping;
    await expectNothingHeld(feed, sleep);
    expect(probe.starts).toBe(0); // nothing was read after the stop
  });

  it('during a read with an open handle: the handle is closed, the count is zero, and no resource is left', async () => {
    writeTranscript('a.jsonl', 50);
    const before = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
    let stopping: Promise<void> | null = null;
    const ref: { feed: TranscriptFeed | null } = { feed: null };
    const { feed, sleep, probe } = feedOver({
      onLine: () => {
        stopping ??= ref.feed?.stop() ?? null; // inside the read: the stream and the handle are open
      },
    });
    ref.feed = feed;
    feed.start();
    for (let turn = 0; turn < 200 && stopping === null; turn += 1) await settle();
    expect(stopping).not.toBeNull();
    await stopping;
    expect(probe.files?.count()).toBe(0);
    await expectNothingHeld(feed, sleep);
    expect(probe.lines).toBeLessThan(50); // the read ended at the abort, it did not run on
    expect(process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length).toBe(
      before,
    );
  });

  it('during the tracker start, with the handle open (the fake tracker never answers)', async () => {
    writeTranscript('a.jsonl');
    const never = deferred();
    const { feed, sleep, probe } = feedOver({
      onStart: (_file, _probe, signal) =>
        endsOnAbort(
          signal,
          never.promise.then(() => null),
        ),
    });
    feed.start();
    for (let turn = 0; turn < 200 && probe.starts === 0; turn += 1) await settle();
    expect(openCount()).toBe(1);
    expect(probe.files?.count()).toBe(1);
    await feed.stop(); // the tracker's start ends on the abort, and the handle is closed
    expect(probe.files?.count()).toBe(0);
    await expectNothingHeld(feed, sleep);
    never.resolve();
    await settle();
    await expectNothingHeld(feed, sleep);
  });

  it('closes both handles when stopped while opening the Codex first line', async () => {
    const clock = at(34);
    const homes = makeHomes(clock);
    const sleep = manualSleep();
    const feed = createCodexFeed({
      homes: () => [homes.codexHome],
      now: () => clock,
      logger: memoryLogger('debug').logger,
      sleep,
    });
    let stopping: Promise<void> | null = null;
    let handlesAtStop = 0;
    gates.afterOpen = () => {
      // The tail holds the first handle while the tracker opens the second for `session_meta`.
      if (gates.fileOpens < 2) return;
      handlesAtStop = openCount();
      gates.afterOpen = null;
      stopping = feed.stop();
    };
    feed.start();
    for (let turn = 0; turn < 200 && stopping === null; turn += 1) await settle();
    expect(stopping).not.toBeNull();
    expect(handlesAtStop).toBe(2);
    await stopping;
    await expectNothingHeld(feed, sleep);
    await settle();
    await expectNothingHeld(feed, sleep);
  });

  it('after a full run every read has closed its handle, and a stop then leaves nothing', async () => {
    writeTranscript('a.jsonl');
    const { feed, sleep, probe } = feedOver();
    feed.start();
    await feed.ready();
    expect(feed.status()).toBe('live');
    expect(probe.files?.count()).toBe(0); // every read closed its handle
    await feed.stop();
    await expectNothingHeld(feed, sleep);
  });

  it('a restart right after a stop works, and the old run touches nothing of the new one', async () => {
    writeTranscript('a.jsonl');
    const never = deferred();
    const first = feedOver({
      onStart: (_file, _probe, signal) =>
        endsOnAbort(
          signal,
          never.promise.then(() => null),
        ),
    });
    first.feed.start();
    for (let turn = 0; turn < 200 && first.probe.starts === 0; turn += 1) await settle();
    const stopping = first.feed.stop();
    first.feed.start(); // while the stop is still closing
    await stopping;
    expect(first.feed.status()).toBe('starting');
    never.resolve();
    await first.feed.ready();
    expect(first.feed.status()).toBe('live');
    expect(first.probe.starts).toBeGreaterThanOrEqual(2);
    await first.feed.stop();
    await expectNothingHeld(first.feed, first.sleep);
  });

  it('keeps no state after a stop: a restart over an emptied folder finds nothing', async () => {
    const path = writeTranscript('a.jsonl');
    const { feed } = feedOver();
    feed.start();
    await feed.ready();
    expect(feed.read().files).toBe(1);
    await feed.stop();
    rmSync(path);
    feed.start();
    await feed.ready();
    expect(feed.read()).toEqual({ agents: [], files: 0 });
    await feed.stop();
  });

  it('closes every handle of a run even when two reads were open at once', async () => {
    writeTranscript('a.jsonl');
    writeTranscript('b.jsonl');
    const { feed, sleep } = feedOver();
    feed.start();
    await feed.ready();
    await feed.stop();
    expect(gates.opened.length).toBeGreaterThanOrEqual(2);
    await expectNothingHeld(feed, sleep);
    expect(gates.opened.every((handle: FileHandle | { fd: number }) => handle.fd === -1)).toBe(
      true,
    );
  });
});
