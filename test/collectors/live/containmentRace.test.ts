import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOpenFiles,
  enumerationMode,
  listWithin,
  readDirectoryWithin,
  type DirectoryHooks,
  type EnumerationMode,
} from '../../../src/server/collectors/live/confined.ts';
import { createRecent } from '../../../src/server/collectors/live/recent.ts';
import { settle } from '../paseo/liveHelpers.ts';

// A folder is read only through a handle whose identity was verified (confined.ts › readDirectoryWithin). Here the path of the folder
// (or of one of its ancestors) is swapped for a link to a decoy folder outside the root at each stage of the read, by the test seam
// (`hooks`): after the rule's check and before the open, after the open and before the read, and after the read. Whatever is swapped, no
// entry of the decoy may be returned, and no handle may be opened on anything in it. The file system is real.

const gates = vi.hoisted(() => ({
  opened: [] as FileHandle[],
  openedIdentities: [] as { dev: number; ino: number }[],
  /** Where each by-path read of a folder went (its real path at the moment of the call). */
  readdirTargets: [] as (string | null)[],
  hold: null as null | { entered: () => void; until: Promise<void> },
  failReaddir: false,
  failStat: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      const info = await handle.stat();
      gates.openedIdentities.push({ dev: info.dev, ino: info.ino });
      gates.opened.push(handle);
      if (gates.failStat)
        (handle as { stat: unknown }).stat = () =>
          Promise.reject(Object.assign(new Error('fstat'), { code: 'EIO' }));
      return handle;
    },
    readdir: async (...args: Parameters<typeof fs.readdir>) => {
      const path = String(args[0]);
      if (!path.startsWith('/dev/fd/') && !path.startsWith('/proc/self/fd/'))
        gates.readdirTargets.push(await fs.realpath(path).catch(() => null));
      if (gates.hold) {
        gates.hold.entered();
        await gates.hold.until;
      }
      if (gates.failReaddir) throw Object.assign(new Error('readdir'), { code: 'EIO' });
      return (fs.readdir as (...a: unknown[]) => Promise<unknown>)(...args);
    },
  };
});

let base: string;
let root: string;
let decoy: string;
/** Every inode in the decoy tree: a handle with one of these identities is a handle outside the root. */
let decoyInodes: Set<string>;

const idOf = (info: { dev: number; ino: number }): string => `${info.dev}:${info.ino}`;

function put(path: string, text = '{}\n'): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function inodesBelow(dir: string, into: Set<string>): void {
  into.add(idOf(statSync(dir)));
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) inodesBelow(path, into);
    else into.add(idOf(statSync(path)));
  }
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'live-race-')));
  root = join(base, 'root');
  decoy = join(base, 'decoy');
  put(join(root, 'proj/a.jsonl'));
  put(join(root, 'proj/sess/subagents/b.jsonl'));
  put(join(root, '2026/11/19/c.jsonl'));
  put(join(decoy, 'OUTSIDE.jsonl'));
  put(join(decoy, 'proj/OUTSIDE.jsonl'));
  put(join(decoy, 'proj/a.jsonl')); // the same name as in the root: still not the root's file
  put(join(decoy, 'proj/sess/subagents/OUTSIDE.jsonl'));
  put(join(decoy, '2026/11/19/OUTSIDE.jsonl'));
  decoyInodes = new Set();
  inodesBelow(decoy, decoyInodes);
  gates.opened.length = 0;
  gates.openedIdentities.length = 0;
  gates.readdirTargets.length = 0;
  gates.hold = null;
  gates.failReaddir = false;
  gates.failStat = false;
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const accept = (rel: string): boolean => rel.endsWith('.jsonl');
const insideDecoy = (path: string | null): boolean =>
  path !== null && (path === decoy || path.startsWith(`${decoy}/`));

/**
 * What no stage of any read may do, whichever way it ended: every handle is closed, and no FILE is opened (a listing opens none). A
 * swapped ANCESTOR makes the `open` of the folder's own path lead into the decoy folder: Node has no open relative to a verified parent, so
 * that one `open` cannot be prevented. The handle is then refused (its identity is not the one checked), closed at once, and not a single
 * name is read through it: that is what is asserted (no by-path read of the decoy at all in that stage).
 */
function expectNothingOutsideOpened(): void {
  expect(gates.opened.every((handle) => handle.fd === -1)).toBe(true);
}

/** A handle on a decoy folder exists only where an ANCESTOR was swapped before the open (see above); never otherwise. */
function expectNoHandleInDecoy(swapIsAncestor: boolean, stage: (typeof STAGES)[number]): void {
  if (swapIsAncestor && stage === 'beforeOpen') return;
  for (const identity of gates.openedIdentities)
    expect(decoyInodes.has(idOf(identity))).toBe(false);
}

function swap(path: string, to: string): void {
  renameSync(path, `${path}.moved`);
  symlinkSync(to, path);
}

/** The mode this platform reads in; the by-path mode is forced as well on every platform so that its rule is always exercised. */
async function platformMode(): Promise<EnumerationMode> {
  const files = createOpenFiles();
  try {
    return await enumerationMode(files);
  } finally {
    await files.closeAll();
  }
}

const STAGES = ['beforeOpen', 'beforeRead', 'afterRead'] as const;

/** The folder being read, and the path that is swapped (the folder itself, or one of its ancestors) for the decoy's counterpart. */
const CASES = [
  { name: 'the root', read: '', swap: '' },
  { name: 'a project folder', read: 'proj', swap: 'proj' },
  { name: 'a subagents folder', read: 'proj/sess/subagents', swap: 'proj/sess/subagents' },
  { name: 'a Codex date folder', read: '2026/11/19', swap: '2026/11/19' },
  { name: 'an ancestor of a subagents folder', read: 'proj/sess/subagents', swap: 'proj' },
  { name: 'an ancestor of a Codex date folder', read: '2026/11/19', swap: '2026' },
] as const;

function hookAt(stage: (typeof STAGES)[number], read: string, doSwap: () => void): DirectoryHooks {
  const wanted = read === '' ? root : join(root, read);
  let done = false;
  const act = (path: string) => {
    if (done || path !== wanted) return;
    done = true;
    doSwap();
  };
  return { [stage]: act };
}

const swapOf = (swapRel: string) => () =>
  swap(swapRel === '' ? root : join(root, swapRel), swapRel === '' ? decoy : join(decoy, swapRel));

describe.each([['recheck'], ['descriptor']] as const)(
  'the names a folder read returns, folders read in the %s mode',
  (forced) => {
    beforeEach(async (context) => {
      if (forced === 'descriptor' && (await platformMode()) !== 'descriptor') context.skip();
    });

    for (const c of CASES) {
      for (const stage of STAGES) {
        it(`${c.name} swapped, ${stage}: the read is refused or gives only the folder's own names, never the decoy's`, async () => {
          const files = createOpenFiles();
          const path = c.read === '' ? root : join(root, c.read);
          const own = new Set(readdirSync(path)); // the names the real folder has, before anything is swapped
          let names: string[] | null = null;
          try {
            const entries = await readDirectoryWithin({ root, realRoot: root }, path, files, {
              ...hookAt(stage, c.read, swapOf(c.swap)),
              mode: forced,
            });
            names = entries.map((entry) => entry.name);
          } catch {
            // refused: nothing is returned at all
          }
          if (names !== null) for (const name of names) expect(own.has(name)).toBe(true);
          expect(names?.includes('OUTSIDE.jsonl') ?? false).toBe(false);
          // Where a swap comes after the check, the read must have been refused (by path) or have given the real folder (descriptor).
          if (forced === 'recheck' && stage !== 'beforeOpen' && c.swap !== '')
            expect(names).toBeNull();
          expect(files.count()).toBe(0);
          expectNothingOutsideOpened();
        });
      }
    }
  },
);

describe.each([
  ['by path, checked again (macOS and any platform without a descriptor path)', 'recheck'],
  ['through the descriptor (where the platform has one)', 'descriptor'],
] as const)('the full listing, folders read %s', (_label, forced) => {
  beforeEach(async (context) => {
    if (forced === 'descriptor' && (await platformMode()) !== 'descriptor') context.skip();
  });

  for (const c of CASES) {
    for (const stage of STAGES) {
      it(`${c.name} swapped for a link to a folder outside the root, ${stage}: nothing outside is returned or opened`, async () => {
        const listing = await listWithin(
          root,
          accept,
          new AbortController().signal,
          createOpenFiles(),
          { ...hookAt(stage, c.read, swapOf(c.swap)), mode: forced },
        );
        for (const file of listing.files) {
          expect(file.path).not.toContain('OUTSIDE');
          expect(file.path.startsWith(`${root}/`)).toBe(true);
          expect(insideDecoy(realpathSync(file.path))).toBe(false);
        }
        // The by-path mode may have asked the decoy folder for its names (it cannot do otherwise); they were thrown away.
        if (forced === 'descriptor' || stage === 'beforeOpen')
          expect(gates.readdirTargets.filter(insideDecoy)).toEqual([]);
        expectNothingOutsideOpened();
        expectNoHandleInDecoy(c.swap !== c.read, stage);
      });
    }
  }
});

describe.each([
  ['by path, checked again', 'recheck'],
  ['through the descriptor', 'descriptor'],
] as const)('the incremental look, folders read %s', (_label, forced) => {
  beforeEach(async (context) => {
    if (forced === 'descriptor' && (await platformMode()) !== 'descriptor') context.skip();
  });

  for (const c of CASES.filter((entry) => entry.read !== '')) {
    for (const stage of STAGES) {
      it(`${c.name} swapped, ${stage}: nothing outside is followed or opened`, async () => {
        const state = { armed: false, swapped: false };
        const wanted = join(root, c.read);
        const doSwap = swapOf(c.swap);
        const hooks: DirectoryHooks = {
          mode: forced,
          [stage]: (path: string) => {
            if (!state.armed || state.swapped || path !== wanted) return;
            state.swapped = true;
            doSwap();
          },
        };
        const finder = createRecent({
          roots: () => [root],
          accept,
          hotDirs: () => [
            join(root, 'proj'),
            join(root, 'proj/sess/subagents'),
            join(root, '2026/11/19'),
          ],
          now: () => Date.now(),
          hooks,
        });
        const first = await finder.refresh(); // the full listing: nothing swapped yet
        expect(first.files.map((file) => file.rel).sort()).toEqual([
          '2026/11/19/c.jsonl',
          'proj/a.jsonl',
          'proj/sess/subagents/b.jsonl',
        ]);
        // A new file appears where the look will read: the folder's time moves, so the next look reads it.
        put(join(wanted, 'new.jsonl'));
        const later = new Date(Date.now() + 5_000);
        utimesSync(wanted, later, later);
        state.armed = true;
        const second = await finder.refresh();
        expect(state.swapped).toBe(true);
        // A file that was followed before the swap was checked then; what must never appear is anything the swapped path leads to.
        for (const file of second.files) {
          expect(file.path).not.toContain('OUTSIDE');
          expect(['2026/11/19/c.jsonl', 'proj/a.jsonl', 'proj/sess/subagents/b.jsonl']).toContain(
            file.rel,
          );
        }
        expect(second.files.some((file) => file.rel.endsWith('new.jsonl'))).toBe(false);
        if (forced === 'descriptor' || stage === 'beforeOpen')
          expect(gates.readdirTargets.filter(insideDecoy)).toEqual([]);
        expectNothingOutsideOpened();
        expectNoHandleInDecoy(c.swap !== c.read, stage);
      });
    }
  }
});

describe('the platform', () => {
  it('reads folders through the descriptor only where that follows the handle, not the path', async () => {
    const mode = await platformMode();
    const files = createOpenFiles();
    const opened = await files.openDirectory(join(root, 'proj'));
    try {
      const through =
        process.platform === 'linux'
          ? `/proc/self/fd/${opened.handle.fd}`
          : `/dev/fd/${opened.handle.fd}`;
      const { readdir } = await import('node:fs/promises');
      const via = await readdir(through).then(
        (names) => names.sort(),
        (error: NodeJS.ErrnoException) => error.code,
      );
      swap(join(root, 'proj'), join(decoy, 'proj')); // the path now leads to the decoy folder
      if (mode === 'descriptor') {
        // Where the platform can, the handle's own folder is read, whatever the path leads to now.
        const after = (await readdir(through)).sort();
        expect(after).toEqual(['a.jsonl', 'sess']);
        expect(after).toEqual(via);
        expect((await readdir(join(root, 'proj'))).sort()).toContain('OUTSIDE.jsonl'); // what a by-path read would have given
      } else {
        // macOS answers ENOTDIR to a directory at /dev/fd/<fd>: the platform has no way to read through the handle, so the by-path mode
        // (check, read with the handle held, check again, discard on a difference) is the one in use here.
        expect(typeof via).toBe('string');
        expect(process.platform).not.toBe('linux');
      }
    } finally {
      await opened.close();
      await files.closeAll();
    }
  });
});

describe('a folder read that is refused or fails leaves no handle', () => {
  const scopeOf = () => ({ root, realRoot: root });

  it('reads the names of a plain folder, and nothing is held afterwards', async () => {
    const files = createOpenFiles();
    const entries = await readDirectoryWithin(scopeOf(), join(root, 'proj'), files);
    expect(entries.map((entry) => `${entry.name}:${entry.kind}`).sort()).toEqual([
      'a.jsonl:file',
      'sess:directory',
    ]);
    expect(files.count()).toBe(0);
    expectNothingOutsideOpened();
  });

  it('open succeeds and fstat fails: the handle is closed and the read refused', async () => {
    const files = createOpenFiles();
    gates.failStat = true;
    await expect(readDirectoryWithin(scopeOf(), join(root, 'proj'), files)).rejects.toMatchObject({
      code: 'EIO',
    });
    gates.failStat = false;
    expect(files.count()).toBe(0);
    expect(gates.opened.at(-1)?.fd).toBe(-1);
    expectNothingOutsideOpened();
  });

  it('the listing with a failing fstat: states a failure, keeps nothing, holds nothing', async () => {
    const files = createOpenFiles();
    await platformMode();
    gates.failStat = true;
    const listing = await listWithin(root, accept, new AbortController().signal, files);
    gates.failStat = false;
    expect(listing).toEqual({ state: 'failed', realRoot: null, files: [] });
    expect(files.count()).toBe(0);
    expectNothingOutsideOpened();
  });

  it('readdir throws: the handle is closed and the folder is skipped', async () => {
    const files = createOpenFiles();
    await platformMode();
    gates.failReaddir = true;
    await expect(readDirectoryWithin(scopeOf(), join(root, 'proj'), files)).rejects.toMatchObject({
      code: 'EIO',
    });
    const listing = await listWithin(root, accept, new AbortController().signal, files);
    gates.failReaddir = false;
    expect(listing.files).toEqual([]);
    expect(files.count()).toBe(0);
    expectNothingOutsideOpened();
  });

  it('the identity is not the one that was checked: refused with ESTALE and closed', async () => {
    const files = createOpenFiles();
    await expect(
      readDirectoryWithin(scopeOf(), join(root, 'proj'), files, {
        beforeOpen: () => swap(join(root, 'proj'), join(root, '2026')), // a link in the last place
      }),
    ).rejects.toBeDefined();
    expect(files.count()).toBe(0);
    expectNothingOutsideOpened();
  });

  it('an abort in the middle of the enumeration: the walk ends, and the handle is closed when the call that was in flight ends', async () => {
    const files = createOpenFiles();
    await platformMode();
    const entered = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => (resolve = done));
      return { promise, resolve };
    })();
    const until = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => (resolve = done));
      return { promise, resolve };
    })();
    gates.hold = { entered: entered.resolve, until: until.promise };
    const controller = new AbortController();
    const listing = listWithin(root, accept, controller.signal, files);
    await entered.promise;
    expect(files.count()).toBe(1); // the handle is open while the names are being read
    controller.abort();
    await settle();
    gates.hold = null;
    until.resolve();
    await listing;
    expect(files.count()).toBe(0);
    expectNothingOutsideOpened();
  });

  it('a stop while a folder is being opened closes the handle and refuses the read', async () => {
    const files = createOpenFiles();
    await platformMode();
    const closing = files.closeAll();
    await expect(readDirectoryWithin(scopeOf(), join(root, 'proj'), files)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await closing;
    expect(files.count()).toBe(0);
    expectNothingOutsideOpened();
  });
});
