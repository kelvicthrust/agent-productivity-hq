import { execFileSync } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkBelow,
  folderWithin,
  listWithin,
  openWithin,
  statWithin,
  type Scope,
} from '../../../src/server/collectors/live/confined.ts';
import { createRecent, type RecentFile } from '../../../src/server/collectors/live/recent.ts';

// The one containment rule, at each of the three places that apply it: below a provider root no path component may be a symbolic link,
// ever. A path is acceptable only when its real path is exactly the real root plus its path below the root, and `lstat` says a regular
// file (or a directory, for a folder). Each case is run through the full listing, the incremental look (a followed file or hot folder
// that is changed after it was followed) and the open. Real folders, links, a FIFO and a socket in a temp folder; no mocks.

const NOW = Date.parse('2026-11-19T10:00:00Z');
const signal = () => new AbortController().signal;
let home: string;
let root: string;
let outside: string;
let clock: number;
const servers: Server[] = [];

beforeEach(() => {
  // A short folder name: a socket's path has a length limit.
  home = mkdtempSync(join(tmpdir(), 'cr-'));
  root = join(home, 'projects');
  outside = join(home, 'outside');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  clock = NOW;
});
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
  rmSync(home, { recursive: true, force: true });
});

function put(base: string, rel: string, body = '{"a":1}\n', ageMs = 1_000): string {
  const path = join(base, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  const when = new Date(clock - ageMs);
  utimesSync(path, when, when);
  return path;
}

const recent = () =>
  createRecent({
    roots: () => [root],
    accept: (rel) => rel.endsWith('.jsonl'),
    hotDirs: (followed: readonly RecentFile[]) => followed.map((file) => dirname(file.path)),
    now: () => clock,
    fullEveryMs: 60_000,
  });
const rels = (files: readonly { path: string }[]) =>
  files.map((file) => file.path.slice(root.length + 1)).sort();
const scopeOf = (): Scope => ({ root, realRoot: realpathSync(root) });

/** The listing's own record of a file, to open it as the feed would. */
async function listed(path: string) {
  const listing = await listWithin(root, () => true, signal());
  const file = listing.files.find((candidate) => candidate.path === path);
  if (!file) throw new Error('not listed');
  return file;
}

/** Moves the second look past the folder's own modified time so it is listed again, and past the follow window's tick. */
function nextLook(...dirs: string[]): void {
  clock += 5_000;
  for (const dir of dirs) utimesSync(dir, new Date(clock), new Date(clock));
}

describe('the rule itself (checkBelow)', () => {
  it('accepts a regular file and a directory below the root, and the root itself as a directory', async () => {
    const file = put(root, 'p/ok.jsonl');
    expect((await checkBelow(scopeOf(), file, 'file')).kind).toBe('ok');
    expect((await checkBelow(scopeOf(), join(root, 'p'), 'directory')).kind).toBe('ok');
    expect((await checkBelow(scopeOf(), root, 'directory')).kind).toBe('ok');
  });

  it('refuses a path that is not below the root, however it is written', async () => {
    const file = put(outside, 'x.jsonl');
    expect((await checkBelow(scopeOf(), file, 'file')).kind).toBe('refused');
    expect((await checkBelow(scopeOf(), join(root, '..', 'outside', 'x.jsonl'), 'file')).kind).toBe(
      'refused',
    );
    expect((await checkBelow(scopeOf(), root + '-sibling', 'directory')).kind).toBe('refused');
  });

  it('refuses a kind that is not the wanted one, and says gone for a path that is not there', async () => {
    put(root, 'p/ok.jsonl');
    expect((await checkBelow(scopeOf(), join(root, 'p'), 'file')).kind).toBe('refused');
    expect((await checkBelow(scopeOf(), join(root, 'p', 'ok.jsonl'), 'directory')).kind).toBe(
      'refused',
    );
    expect((await checkBelow(scopeOf(), join(root, 'p', 'none.jsonl'), 'file')).kind).toBe('gone');
    expect((await checkBelow(scopeOf(), join(root, 'q', 'none.jsonl'), 'file')).kind).toBe('gone');
  });

  it('refuses a dangling link and a link loop without throwing', async () => {
    mkdirSync(join(root, 'p'));
    symlinkSync(join(outside, 'not-there'), join(root, 'p', 'dangling.jsonl'));
    symlinkSync(join(root, 'p', 'b.jsonl'), join(root, 'p', 'a.jsonl'));
    symlinkSync(join(root, 'p', 'a.jsonl'), join(root, 'p', 'b.jsonl'));
    for (const name of ['dangling.jsonl', 'a.jsonl', 'b.jsonl'])
      expect((await checkBelow(scopeOf(), join(root, 'p', name), 'file')).kind).toBe('refused');
  });
});

describe('a symbolic link to another file inside the root', () => {
  it('is not listed', async () => {
    put(root, 'p/real.jsonl');
    symlinkSync(join(root, 'p', 'real.jsonl'), join(root, 'p', 'link.jsonl'));
    const listing = await listWithin(root, () => true, signal());
    expect(rels(listing.files)).toEqual(['p/real.jsonl']);
  });

  it('drops a followed file that was swapped for an in-root link, at the next look', async () => {
    const path = put(root, 'p/ok.jsonl');
    const other = put(root, 'p/other.jsonl');
    const feed = recent();
    expect(rels((await feed.refresh()).files)).toEqual(['p/ok.jsonl', 'p/other.jsonl']);
    rmSync(path);
    symlinkSync(other, path);
    clock += 2_000;
    expect(rels((await feed.refresh()).files)).toEqual(['p/other.jsonl']);
    expect(await statWithin(scopeOf(), path)).toBeNull();
  });

  it('is not picked up when it appears in a followed folder', async () => {
    put(root, 'p/real.jsonl');
    const feed = recent();
    await feed.refresh();
    symlinkSync(join(root, 'p', 'real.jsonl'), join(root, 'p', 'new.jsonl'));
    nextLook(join(root, 'p'));
    expect(rels((await feed.refresh()).files)).toEqual(['p/real.jsonl']);
  });

  it('is refused when opened, after the file was listed and then swapped', async () => {
    const path = put(root, 'p/ok.jsonl');
    const other = put(root, 'p/other.jsonl');
    const file = await listed(path);
    rmSync(path);
    symlinkSync(other, path);
    await expect(openWithin(file)).rejects.toMatchObject({ code: 'EACCES' });
  });
});

describe('a symbolic link to a folder inside the root', () => {
  it('is not descended into by the listing', async () => {
    put(root, 'p/real.jsonl');
    symlinkSync(join(root, 'p'), join(root, 'alias'), 'dir');
    const listing = await listWithin(root, () => true, signal());
    expect(rels(listing.files)).toEqual(['p/real.jsonl']);
  });

  it('drops the files of a hot folder that was swapped for an in-root link, and does not list the link', async () => {
    put(root, 'p/ok.jsonl');
    put(root, 'q/other.jsonl');
    const feed = recent();
    await feed.refresh();
    renameSync(join(root, 'p'), join(root, 'p-moved'));
    symlinkSync(join(root, 'q'), join(root, 'p'), 'dir');
    nextLook(join(root, 'p'));
    const seen = rels((await feed.refresh()).files);
    expect(seen).not.toContain('p/ok.jsonl');
    expect(seen).not.toContain('p/other.jsonl');
    expect(seen).toEqual(['q/other.jsonl']);
    expect(await folderWithin(scopeOf(), join(root, 'p'))).toBeNull();
  });

  it('is refused when the file is opened through it', async () => {
    const path = put(root, 'p/ok.jsonl');
    const file = await listed(path);
    renameSync(join(root, 'p'), join(root, 'moved'));
    symlinkSync(join(root, 'moved'), join(root, 'p'), 'dir'); // the same file, through a link inside the root
    await expect(openWithin(file)).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('is refused one level up too: a linked folder in the middle of the path', async () => {
    const path = put(root, 'a/b/ok.jsonl');
    const file = await listed(path);
    renameSync(join(root, 'a', 'b'), join(root, 'a', 'b2'));
    symlinkSync(join(root, 'a', 'b2'), join(root, 'a', 'b'), 'dir');
    await expect(openWithin(file)).rejects.toMatchObject({ code: 'EACCES' });
    expect(await statWithin(scopeOf(), path)).toBeNull();
  });
});

describe('a symbolic link to somewhere outside the root', () => {
  it('is not listed, not a folder, and a followed file swapped for one is dropped', async () => {
    const path = put(root, 'p/ok.jsonl');
    const secret = put(outside, 'secret.jsonl');
    symlinkSync(secret, join(root, 'p', 'linked.jsonl'));
    symlinkSync(outside, join(root, 'dir-link'), 'dir');
    const feed = recent();
    expect(rels((await feed.refresh()).files)).toEqual(['p/ok.jsonl']);
    rmSync(path);
    symlinkSync(secret, path);
    clock += 2_000;
    expect((await feed.refresh()).files).toEqual([]);
  });

  it('is refused when opened', async () => {
    const path = put(root, 'p/ok.jsonl');
    const file = await listed(path);
    const secret = put(outside, 'secret.jsonl', '{"secret":1}\n');
    rmSync(path);
    symlinkSync(secret, path);
    await expect(openWithin(file)).rejects.toMatchObject({ code: 'EACCES' });
  });
});

describe('what is accepted', () => {
  it('a regular file, a hard link to one, and a folder of them, at all three places', async () => {
    const path = put(root, 'p/ok.jsonl');
    linkSync(path, join(root, 'p', 'hard.jsonl'));
    const listing = await listWithin(root, () => true, signal());
    expect(rels(listing.files)).toEqual(['p/hard.jsonl', 'p/ok.jsonl']);

    const feed = recent();
    expect(rels((await feed.refresh()).files)).toEqual(['p/hard.jsonl', 'p/ok.jsonl']);
    clock += 2_000;
    expect(rels((await feed.refresh()).files)).toEqual(['p/hard.jsonl', 'p/ok.jsonl']);

    const file = listing.files.find((candidate) => candidate.path === path);
    const handle = await openWithin(file ?? { path });
    expect((await handle.readFile()).toString()).toBe('{"a":1}\n');
    await handle.close();
  });

  it('a root that is itself a link: its target is the root, at all three places', async () => {
    const real = join(home, 'real-projects');
    put(real, 'p/ok.jsonl');
    rmSync(root, { recursive: true });
    symlinkSync(real, root, 'dir');
    const path = join(root, 'p', 'ok.jsonl');
    const listing = await listWithin(root, () => true, signal());
    expect(listing.state).toBe('ok');
    expect(rels(listing.files)).toEqual(['p/ok.jsonl']);

    const feed = recent();
    expect(rels((await feed.refresh()).files)).toEqual(['p/ok.jsonl']);
    clock += 2_000;
    expect(rels((await feed.refresh()).files)).toEqual(['p/ok.jsonl']);

    const file = listing.files.find((candidate) => candidate.path === path);
    const handle = await openWithin(file ?? { path });
    await handle.close();
  });
});

describe('what is not a regular file where a file is expected', () => {
  it('a FIFO is not listed, not followed and not opened, and opening it does not wait for a writer', async () => {
    put(root, 'p/ok.jsonl');
    const pipe = join(root, 'p', 'pipe.jsonl');
    try {
      execFileSync('mkfifo', [pipe]);
    } catch {
      return; // no mkfifo here
    }
    expect(rels((await listWithin(root, () => true, signal())).files)).toEqual(['p/ok.jsonl']);
    expect(await statWithin(scopeOf(), pipe)).toBeNull();
    const guard = { ...scopeOf(), dev: 0, ino: 0 };
    await expect(openWithin({ path: pipe, guard })).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('a socket is not listed, not followed and not opened', async () => {
    put(root, 'p/ok.jsonl');
    const socket = join(root, 'p', 's.jsonl');
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socket, resolve);
      });
    } catch {
      return; // no unix sockets here
    }
    servers.push(server);
    expect(rels((await listWithin(root, () => true, signal())).files)).toEqual(['p/ok.jsonl']);
    expect(await statWithin(scopeOf(), socket)).toBeNull();
    const guard = { ...scopeOf(), dev: 0, ino: 0 };
    await expect(openWithin({ path: socket, guard })).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('a directory named like a file is not a file, and is still a folder to look in', async () => {
    put(root, 'p/ok.jsonl');
    const inner = put(root, 'p/dir.jsonl/inner.jsonl');
    const dir = join(root, 'p', 'dir.jsonl');
    expect(rels((await listWithin(root, () => true, signal())).files)).toEqual([
      'p/dir.jsonl/inner.jsonl',
      'p/ok.jsonl',
    ]);
    expect(inner).toBeTruthy();
    expect(await statWithin(scopeOf(), dir)).toBeNull();
    const guard = { ...scopeOf(), dev: 0, ino: 0 };
    await expect(openWithin({ path: dir, guard })).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('a followed file replaced by a directory is dropped', async () => {
    const path = put(root, 'p/ok.jsonl');
    const feed = recent();
    await feed.refresh();
    rmSync(path);
    mkdirSync(path);
    clock += 2_000;
    expect((await feed.refresh()).files).toEqual([]);
  });
});

describe('a dangling link', () => {
  it('is skipped by the listing, the look and the open, and nothing throws', async () => {
    put(root, 'p/ok.jsonl');
    const dangling = join(root, 'p', 'dangling.jsonl');
    symlinkSync(join(outside, 'nowhere.jsonl'), dangling);
    expect(rels((await listWithin(root, () => true, signal())).files)).toEqual(['p/ok.jsonl']);
    expect(await statWithin(scopeOf(), dangling)).toBeNull();
    const feed = recent();
    expect(rels((await feed.refresh()).files)).toEqual(['p/ok.jsonl']);
    nextLook(join(root, 'p'));
    expect(rels((await feed.refresh()).files)).toEqual(['p/ok.jsonl']);
    const guard = { ...scopeOf(), dev: 0, ino: 0 };
    await expect(openWithin({ path: dangling, guard })).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('a followed file replaced by one is dropped', async () => {
    const path = put(root, 'p/ok.jsonl');
    const feed = recent();
    await feed.refresh();
    rmSync(path);
    symlinkSync(join(outside, 'nowhere.jsonl'), path);
    clock += 2_000;
    expect((await feed.refresh()).files).toEqual([]);
  });
});

describe('the open itself', () => {
  it('opens the original path, and refuses a file that is not the one the check saw or the one listed', async () => {
    const path = put(root, 'p/ok.jsonl', '{"n":1}\n');
    const file = await listed(path);
    const handle = await openWithin(file);
    expect((await handle.readFile()).toString()).toBe('{"n":1}\n');
    await handle.close();
    renameSync(put(root, 'p/other.jsonl', '{"n":2}\n'), path);
    await expect(openWithin(file)).rejects.toMatchObject({ code: 'ESTALE' });
  });

  it('says the file has gone when it has, and nothing about where it was', async () => {
    const path = put(root, 'p/ok.jsonl');
    const file = await listed(path);
    rmSync(path);
    const error: unknown = await openWithin(file).then(
      () => null,
      (rejected: unknown) => rejected,
    );
    expect(error).toMatchObject({ code: 'ENOENT' });
    expect(String((error as Error).message)).not.toContain(home);
  });
});
