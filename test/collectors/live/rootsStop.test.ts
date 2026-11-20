import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClaudeFeed } from '../../../src/server/collectors/live/claudeFeed.ts';
import { createCodexFeed } from '../../../src/server/collectors/live/codexFeed.ts';
import { createOpenFiles, enumerationMode } from '../../../src/server/collectors/live/confined.ts';
import type { TranscriptFeed } from '../../../src/server/collectors/live/feed.ts';
import { memoryLogger } from '../../server/helpers.ts';
import { manualSleep, settle } from '../paseo/liveHelpers.ts';

// Stopping a feed during the roots lookup or the listing of the first of several roots: the stop waits for the step that is in flight and
// for nothing after it, and no later root is touched. Every file system call that names a path is counted through the module seam, so
// "touched" means any `realpath`, `lstat`, `open` or `readdir` of a path below that root.

const seam = vi.hoisted(() => ({
  calls: [] as { call: string; path: string }[],
  hold: null as null | { call: string; entered: () => void; until: Promise<void> },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  const seen =
    <F extends (...args: never[]) => Promise<unknown>>(call: string, fn: F) =>
    async (...args: Parameters<F>): Promise<Awaited<ReturnType<F>>> => {
      seam.calls.push({ call, path: String((args as unknown[])[0]) });
      if (seam.hold?.call === call) {
        seam.hold.entered();
        await seam.hold.until;
      }
      return (await fn(...args)) as Awaited<ReturnType<F>>;
    };
  return {
    ...fs,
    realpath: seen('realpath', fs.realpath as (...args: never[]) => Promise<unknown>),
    lstat: seen('lstat', fs.lstat as (...args: never[]) => Promise<unknown>),
    readdir: seen('readdir', fs.readdir as (...args: never[]) => Promise<unknown>),
    open: seen('open', fs.open as (...args: never[]) => Promise<unknown>),
  };
});

const NOW = Date.parse('2026-11-19T10:00:00Z');
let base: string;
beforeEach(async () => {
  // The platform's way of reading a folder is worked out by the first read of the process: do that now, not inside a held call.
  const files = createOpenFiles();
  await enumerationMode(files);
  await files.closeAll();
  // Count calls to the resolved root as well, even when the temp directory is an alias.
  base = mkdtempSync(join(realpathSync(tmpdir()), 'live-roots-stop-'));
  seam.calls.length = 0;
  seam.hold = null;
});
afterEach(() => {
  seam.hold = null;
  rmSync(base, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Holds every call of `call` until released, and says when the first one is in. */
function holdFirst(call: string) {
  const entered = deferred();
  const until = deferred();
  seam.hold = { call, entered: entered.resolve, until: until.promise };
  return {
    entered: entered.promise,
    release: () => {
      seam.hold = null;
      until.resolve();
    },
  };
}

const touched = (below: string): string[] =>
  seam.calls.filter((entry) => entry.path.startsWith(below)).map((entry) => entry.call);

async function stopWhileHeld(feed: TranscriptFeed, hold: ReturnType<typeof holdFirst>) {
  feed.start();
  await hold.entered;
  let stopped = false;
  const stopping = feed.stop().then(() => {
    stopped = true;
  });
  await settle();
  const before = stopped;
  const mark = seam.calls.length;
  hold.release();
  await stopping;
  await settle();
  return { stoppedEarly: before, after: seam.calls.slice(mark) };
}

describe('stop during the first of several roots', () => {
  it('Claude: stop() waits for the lookup that is in flight and no later root is touched', async () => {
    const dirs = ['one', 'two', 'three'].map((name) => join(base, name));
    for (const dir of dirs) mkdirSync(join(dir, 'projects'), { recursive: true });
    const sleep = manualSleep();
    const feed = createClaudeFeed({
      configDirs: () => dirs,
      now: () => NOW,
      logger: memoryLogger('debug').logger,
      sleep,
    });
    const hold = holdFirst('realpath');
    const { stoppedEarly } = await stopWhileHeld(feed, hold);
    expect(stoppedEarly).toBe(false);
    expect(touched(dirs[0] as string)).toEqual(['realpath']);
    expect(touched(dirs[1] as string)).toEqual([]);
    expect(touched(dirs[2] as string)).toEqual([]);
    expect(feed.status()).toBe('stopped');
    expect(sleep.pending).toBe(0);
  });

  it('Claude: a stop during the listing of the first root touches no later root, and waits for the call in flight', async () => {
    const dirs = ['one', 'two'].map((name) => join(base, name));
    for (const dir of dirs) mkdirSync(join(dir, 'projects'), { recursive: true });
    const feed = createClaudeFeed({
      configDirs: () => dirs,
      now: () => NOW,
      logger: memoryLogger('debug').logger,
      sleep: manualSleep(),
    });
    const hold = holdFirst('readdir');
    const { stoppedEarly, after } = await stopWhileHeld(feed, hold);
    expect(stoppedEarly).toBe(false);
    // The lookup of the roots had finished; after the stop nothing at all is done below the second root.
    expect(after.filter((entry) => entry.path.startsWith(dirs[1] as string))).toEqual([]);
    expect(feed.status()).toBe('stopped');
  });

  it('Codex: stop() waits for the listing of the first root that is in flight and no later root is touched', async () => {
    const homes = ['one', 'two', 'three'].map((name) => join(base, name));
    for (const home of homes) mkdirSync(join(home, 'sessions'), { recursive: true });
    const sleep = manualSleep();
    const feed = createCodexFeed({
      homes: () => homes,
      now: () => NOW,
      logger: memoryLogger('debug').logger,
      sleep,
    });
    const hold = holdFirst('realpath');
    const { stoppedEarly } = await stopWhileHeld(feed, hold);
    expect(stoppedEarly).toBe(false);
    expect(touched(homes[0] as string)).toEqual(['realpath']);
    expect(touched(homes[1] as string)).toEqual([]);
    expect(touched(homes[2] as string)).toEqual([]);
    expect(feed.status()).toBe('stopped');
    expect(sleep.pending).toBe(0);
  });

  it('Codex: a stop during the read of the first root touches no later root', async () => {
    const homes = ['one', 'two'].map((name) => join(base, name));
    for (const home of homes) mkdirSync(join(home, 'sessions'), { recursive: true });
    const feed = createCodexFeed({
      homes: () => homes,
      now: () => NOW,
      logger: memoryLogger('debug').logger,
      sleep: manualSleep(),
    });
    const hold = holdFirst('readdir');
    const { stoppedEarly, after } = await stopWhileHeld(feed, hold);
    expect(stoppedEarly).toBe(false);
    expect(after.filter((entry) => entry.path.startsWith(homes[1] as string))).toEqual([]);
    expect(touched(homes[1] as string)).toEqual([]);
    expect(feed.status()).toBe('stopped');
  });
});
