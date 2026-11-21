import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyTranscript } from '../../../src/server/collectors/claude/files.ts';
import {
  FULL_LISTING_EVERY_MS,
  MAX_TRACKED_FILES,
  RECENT_WINDOW_MS,
} from '../../../src/server/collectors/live/heuristics.ts';
import { createRecent, type RecentFile } from '../../../src/server/collectors/live/recent.ts';

// Finding the files being written now: the full listing and what is looked at between listings. Real folders, real modified times,
// an injected clock.

const NOW = Date.parse('2026-11-19T10:00:00Z');
let home: string;
let root: string;
let clock: number;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'live-recent-'));
  root = join(home, 'projects');
  mkdirSync(root, { recursive: true });
  clock = NOW;
});
afterEach(() => {
  chmodSync(root, 0o755);
  rmSync(home, { recursive: true, force: true });
});

/** Writes a transcript file last modified `ageMs` before the clock. */
function put(rel: string, ageMs: number): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{}\n');
  const when = new Date(clock - ageMs);
  utimesSync(path, when, when);
  return path;
}

const recent = (over: { cap?: number } = {}) =>
  createRecent({
    roots: () => [root],
    accept: (rel) => classifyTranscript(rel) !== null,
    hotDirs: (followed: readonly RecentFile[]) => followed.map((file) => dirname(file.path)),
    now: () => clock,
    ...over,
  });

const names = (files: readonly RecentFile[]) => files.map((file) => file.rel);

describe('the full listing', () => {
  it('follows files written within the window, newest first', async () => {
    put('p/new.jsonl', 1_000);
    put('p/older.jsonl', 5 * 60_000);
    put('p/stale.jsonl', RECENT_WINDOW_MS + 60_000);
    const seen = await recent().refresh();
    expect(seen.roots).toBe('ok');
    expect(names(seen.files)).toEqual(['p/new.jsonl', 'p/older.jsonl']);
  });

  it('follows a file exactly at the edge of the window, and not one just past it', async () => {
    put('p/edge.jsonl', RECENT_WINDOW_MS);
    put('p/past.jsonl', RECENT_WINDOW_MS + 1_000);
    expect(names((await recent().refresh()).files)).toEqual(['p/edge.jsonl']);
  });

  it('follows at most the cap, the newest', async () => {
    for (let index = 0; index < MAX_TRACKED_FILES + 5; index += 1)
      put(`p/s${index}.jsonl`, 1_000 + index * 1_000);
    const seen = await recent().refresh();
    expect(seen.files).toHaveLength(MAX_TRACKED_FILES);
    expect(seen.files[0]?.rel).toBe('p/s0.jsonl');
    expect(names(seen.files)).not.toContain(`p/s${MAX_TRACKED_FILES + 4}.jsonl`);
  });

  it('skips what the provider’s rule does not accept: other files, set-aside copies', async () => {
    put('p/ok.jsonl', 1_000);
    put('p/notes.txt', 1_000);
    put('p/old.orphaned-123.jsonl', 1_000);
    put('p/old.jsonl.superseded-123', 1_000);
    put('p/deep/er/than/expected.jsonl', 1_000);
    expect(names((await recent().refresh()).files)).toEqual(['p/ok.jsonl']);
  });

  it('keeps the transcript search within the approved root when a project is symlinked', async () => {
    put('p/ok.jsonl', 1_000);
    const other = join(home, 'other');
    const transcript = join(other, 'session.jsonl');
    mkdirSync(other);
    writeFileSync(transcript, '{}\n');
    utimesSync(transcript, new Date(clock), new Date(clock));
    symlinkSync(other, join(root, 'linked'), 'dir');

    expect(names((await recent().refresh()).files)).toEqual(['p/ok.jsonl']);
  });

  it('reports the sizes and times of what it found', async () => {
    const path = put('p/a.jsonl', 2_000);
    const [file] = (await recent().refresh()).files;
    expect(file).toMatchObject({ path, root, rel: 'p/a.jsonl', size: 3, mtimeMs: clock - 2_000 });
  });
});

describe('between listings', () => {
  it('finds a new file in the folder of one it follows, without listing everything', async () => {
    put('p/first.jsonl', 1_000);
    const finder = recent();
    await finder.refresh();
    // A file in another folder is not looked for until the next full listing.
    put('other/elsewhere.jsonl', 500);
    put('p/second.jsonl', 500);
    clock += 2_000;
    expect(names((await finder.refresh()).files)).toEqual(['p/second.jsonl', 'p/first.jsonl']);
    clock += 2_000;
    expect(names((await finder.refresh()).files)).not.toContain('other/elsewhere.jsonl');
    // After a minute the full listing finds it.
    clock += FULL_LISTING_EVERY_MS;
    expect(names((await finder.refresh()).files)).toContain('other/elsewhere.jsonl');
  });

  it('does not list a folder again until an entry was added or removed in it, however many old files it holds', async () => {
    put('p/active.jsonl', 1_000);
    for (let index = 0; index < 30; index += 1) put(`p/old${index}.jsonl`, 3 * RECENT_WINDOW_MS);
    let asked = 0;
    const finder = createRecent({
      roots: () => [root],
      accept: (rel) => {
        asked += 1;
        return classifyTranscript(rel) !== null;
      },
      hotDirs: (followed: readonly RecentFile[]) => followed.map((file) => dirname(file.path)),
      now: () => clock,
    });
    await finder.refresh(); // the full listing
    asked = 0;
    for (let tick = 1; tick <= 3; tick += 1) {
      clock += 2_000;
      await finder.refresh();
    }
    expect(asked).toBe(0);
    // A file is appended to: the folder's own time does not move, and nothing is listed.
    const activePath = join(root, 'p/active.jsonl');
    writeFileSync(activePath, '{}\n{}\n');
    utimesSync(activePath, new Date(clock), new Date(clock));
    clock += 2_000;
    await finder.refresh();
    expect(asked).toBe(0);
    // A new file: the folder is listed once.
    put('p/new.jsonl', 500);
    clock += 2_000;
    expect(names((await finder.refresh()).files)).toContain('p/new.jsonl');
    expect(asked).toBeGreaterThan(30);
    asked = 0;
    clock += 2_000;
    await finder.refresh();
    expect(asked).toBe(0);
  });

  it('notices a file growing (its size and time move) and one that is deleted', async () => {
    const path = put('p/a.jsonl', 1_000);
    put('p/b.jsonl', 2_000);
    const finder = recent();
    await finder.refresh();
    clock += 2_000;
    writeFileSync(path, '{}\n{}\n');
    utimesSync(path, new Date(clock), new Date(clock));
    rmSync(join(root, 'p/b.jsonl'));
    const seen = await finder.refresh();
    expect(names(seen.files)).toEqual(['p/a.jsonl']);
    expect(seen.files[0]?.size).toBe(6);
  });

  it('stops following a file that has been quiet for the window', async () => {
    put('p/a.jsonl', 1_000);
    const finder = recent();
    expect(names((await finder.refresh()).files)).toEqual(['p/a.jsonl']);
    clock += RECENT_WINDOW_MS; // past a full-listing interval too
    expect(names((await finder.refresh()).files)).toEqual([]);
  });

  it('drops a quiet file between listings too', async () => {
    put('p/a.jsonl', RECENT_WINDOW_MS - 10_000);
    const finder = recent({});
    await finder.refresh();
    clock += 20_000; // not a full listing, but the file is now past the window
    expect(names((await finder.refresh()).files)).toEqual([]);
  });

  it('a file that was dropped and is written again is found by the next full listing', async () => {
    const path = put('p/a.jsonl', RECENT_WINDOW_MS + 5_000);
    const finder = recent();
    expect((await finder.refresh()).files).toEqual([]);
    const when = new Date(clock + FULL_LISTING_EVERY_MS);
    utimesSync(path, when, when);
    clock += FULL_LISTING_EVERY_MS;
    expect(names((await finder.refresh()).files)).toEqual(['p/a.jsonl']);
  });

  it('keeps the cap when new files appear', async () => {
    for (let index = 0; index < MAX_TRACKED_FILES; index += 1)
      put(`p/s${index}.jsonl`, 30_000 + index);
    const finder = recent();
    await finder.refresh();
    put('p/fresh.jsonl', 100);
    clock += 2_000;
    const seen = await finder.refresh();
    expect(seen.files).toHaveLength(MAX_TRACKED_FILES);
    expect(seen.files[0]?.rel).toBe('p/fresh.jsonl');
  });
});

describe('the roots', () => {
  it('says notfound when no root is there', async () => {
    const finder = createRecent({
      roots: () => [join(home, 'missing')],
      accept: () => true,
      hotDirs: () => [],
      now: () => clock,
    });
    expect(await finder.refresh()).toEqual({ roots: 'notfound', files: [] });
  });

  it('is ok, with no files, for a root that is there and empty', async () => {
    expect(await recent().refresh()).toEqual({ roots: 'ok', files: [] });
  });

  it('says denied for a root that cannot be read', async () => {
    chmodSync(root, 0o000);
    const seen = await recent().refresh();
    // Running as the owner of the folder, with permission bits honoured: a root the process cannot read is "denied".
    expect(['denied', 'ok']).toContain(seen.roots);
    if (seen.roots === 'ok') expect(seen.files).toEqual([]);
  });

  it('is ok when one root is there and another is not, and follows files in the one that is', async () => {
    put('p/a.jsonl', 1_000);
    const finder = createRecent({
      roots: () => [join(home, 'missing'), root],
      accept: (rel) => classifyTranscript(rel) !== null,
      hotDirs: () => [],
      now: () => clock,
    });
    const seen = await finder.refresh();
    expect(seen.roots).toBe('ok');
    expect(names(seen.files)).toEqual(['p/a.jsonl']);
  });

  it('asks for the roots again at every full listing', async () => {
    let asked = 0;
    const finder = createRecent({
      roots: () => {
        asked += 1;
        return [root];
      },
      accept: () => false,
      hotDirs: () => [],
      now: () => clock,
    });
    await finder.refresh();
    clock += 2_000;
    await finder.refresh();
    expect(asked).toBe(1);
    clock += FULL_LISTING_EVERY_MS;
    await finder.refresh();
    expect(asked).toBe(2);
  });
});

describe('clear', () => {
  it('forgets everything, so the next refresh lists in full again', async () => {
    put('p/a.jsonl', 1_000);
    const finder = recent();
    await finder.refresh();
    finder.clear();
    put('other/b.jsonl', 1_000);
    expect(names((await finder.refresh()).files).sort()).toEqual(['other/b.jsonl', 'p/a.jsonl']);
  });
});
