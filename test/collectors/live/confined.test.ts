import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyTranscript } from '../../../src/server/collectors/claude/files.ts';
import { createClaudeFeed } from '../../../src/server/collectors/live/claudeFeed.ts';
import { createCodexFeed } from '../../../src/server/collectors/live/codexFeed.ts';
import { listWithin, openWithin } from '../../../src/server/collectors/live/confined.ts';
import { createRecent, type RecentFile } from '../../../src/server/collectors/live/recent.ts';
import { tailFile } from '../../../src/server/collectors/live/tail.ts';
import { memoryLogger } from '../../server/helpers.ts';
import { manualSleep, settle } from '../paseo/liveHelpers.ts';
import { R1, at, stamp } from './feedHelpers.ts';
import { claudePrompt, codexSessionMeta, codexTaskStarted, line } from './lines.ts';

// HQ's transcript reads stay inside the approved roots: real paths, no link below a root followed, regular files only, and a path that
// is swapped between the listing and the read is refused. Real folders and links in a temp folder, no mocks.

const NOW = Date.parse('2026-11-19T10:00:00Z');
let home: string;
let root: string;
let outside: string;
let clock: number;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'live-confined-'));
  root = join(home, 'projects');
  outside = join(home, 'outside');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  clock = NOW;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function put(base: string, rel: string, body = '{}\n', ageMs = 1_000): string {
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
    accept: (rel) => classifyTranscript(rel) !== null,
    hotDirs: (followed: readonly RecentFile[]) => followed.map((file) => dirname(file.path)),
    now: () => clock,
    fullEveryMs: 60_000,
  });
const names = (files: readonly RecentFile[]) => files.map((file) => file.rel);

describe('listing', () => {
  it('does not follow a linked file, a linked folder, or a link that points inside the root', async () => {
    put(root, 'p/ok.jsonl');
    const target = put(outside, 'secret.jsonl');
    symlinkSync(target, join(root, 'p', 'linked-file.jsonl'));
    symlinkSync(outside, join(root, 'linked-dir'), 'dir');
    symlinkSync(join(root, 'p'), join(root, 'inner-link'), 'dir');
    expect(names((await recent().refresh()).files)).toEqual(['p/ok.jsonl']);
  });

  it('does not follow a linked subagents folder or a linked Codex-style date folder', async () => {
    put(root, 'p/s1.jsonl');
    put(outside, 'agent-a.jsonl');
    mkdirSync(join(root, 'p', 's1'), { recursive: true });
    symlinkSync(outside, join(root, 'p', 's1', 'subagents'), 'dir');
    expect(names((await recent().refresh()).files)).toEqual(['p/s1.jsonl']);
  });

  it('accepts a root that is itself a link: it is the approved place, and what it points to is the root', async () => {
    const real = join(home, 'real-projects');
    put(real, 'p/ok.jsonl');
    rmSync(root, { recursive: true });
    symlinkSync(real, root, 'dir');
    const seen = await recent().refresh();
    expect(seen.roots).toBe('ok');
    expect(names(seen.files)).toEqual(['p/ok.jsonl']);
  });

  it('refuses a folder whose real path is outside the root, and a socket or FIFO is not a file', async () => {
    put(root, 'p/ok.jsonl');
    mkdirSync(join(root, 'q'));
    try {
      execFileSync('mkfifo', [join(root, 'q', 'pipe.jsonl')]);
    } catch {
      return; // no mkfifo here: nothing to check
    }
    const listing = await listWithin(root, () => true, new AbortController().signal);
    expect(listing.files.map((file) => file.path)).toEqual([join(root, 'p', 'ok.jsonl')]);
  });

  it('stops at the next entry once aborted', async () => {
    for (let i = 0; i < 20; i += 1) put(root, `p${i}/s.jsonl`);
    const controller = new AbortController();
    controller.abort();
    expect((await listWithin(root, () => true, controller.signal)).files).toEqual([]);
  });
});

describe('between listings', () => {
  it('does not pick up a file that appears in a followed folder as a link to another place', async () => {
    put(root, 'p/ok.jsonl');
    const feed = recent();
    await feed.refresh();
    const target = put(outside, 'secret.jsonl');
    symlinkSync(target, join(root, 'p', 'new.jsonl'));
    // The folder's own time moved, so it is listed again: the link is skipped.
    const bump = new Date(clock + 5_000);
    utimesSync(join(root, 'p'), bump, bump);
    clock += 5_000;
    expect(names((await feed.refresh()).files)).toEqual(['p/ok.jsonl']);
  });

  it('drops a followed file that was swapped for a link to another place', async () => {
    const path = put(root, 'p/ok.jsonl');
    const feed = recent();
    await feed.refresh();
    const target = put(outside, 'secret.jsonl');
    rmSync(path);
    symlinkSync(target, path);
    clock += 2_000;
    expect((await feed.refresh()).files).toEqual([]);
  });

  it('does not list a hot folder that was swapped for a link to another place', async () => {
    put(root, 'p/ok.jsonl');
    const feed = recent();
    await feed.refresh();
    put(outside, 'intruder.jsonl');
    rmSync(join(root, 'p'), { recursive: true });
    symlinkSync(outside, join(root, 'p'), 'dir');
    clock += 2_000;
    expect(names((await feed.refresh()).files)).toEqual([]);
  });

  it('commits nothing when the look is aborted: a late scan cannot put files back', async () => {
    put(root, 'p/ok.jsonl');
    const controller = new AbortController();
    const feed = createRecent({
      roots: () => {
        controller.abort(); // the feed stopped while the roots were being worked out
        return [root];
      },
      accept: (rel) => classifyTranscript(rel) !== null,
      hotDirs: (followed: readonly RecentFile[]) => followed.map((file) => dirname(file.path)),
      now: () => clock,
    });
    const seen = await feed.refresh(controller.signal);
    expect(seen.files).toEqual([]);
    expect(seen.roots).toBe('notfound');
    // The next look, with a live signal, starts from scratch with a full listing: nothing from the aborted one was kept.
    expect(names((await feed.refresh()).files)).toEqual(['p/ok.jsonl']);
  });
});

describe('opening for a read', () => {
  async function listed(path: string): Promise<RecentFile> {
    const seen = await recent().refresh();
    const file = seen.files.find((candidate) => candidate.path === path);
    if (!file) throw new Error('not listed');
    return file;
  }
  const handlers = (lines: string[] = []) => ({
    begin: () => undefined,
    line: (text: string) => void lines.push(text),
    overlong: () => undefined,
  });

  it('refuses a path swapped for a link to a file outside the root after it was listed', async () => {
    const path = put(root, 'p/ok.jsonl', '{"a":1}\n');
    const file = await listed(path);
    const target = put(outside, 'secret.jsonl', '{"secret":1}\n');
    rmSync(path);
    symlinkSync(target, path);
    const seen: string[] = [];
    await expect(
      tailFile(file, null, handlers(seen), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'EACCES' });
    expect(seen).toEqual([]);
  });

  it('refuses a folder on the way swapped for a link to another place', async () => {
    const path = put(root, 'p/ok.jsonl', '{"a":1}\n');
    const file = await listed(path);
    put(outside, 'ok.jsonl', '{"secret":1}\n');
    renameSync(join(root, 'p'), join(home, 'moved'));
    symlinkSync(outside, join(root, 'p'), 'dir');
    const seen: string[] = [];
    await expect(
      tailFile(file, null, handlers(seen), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'EACCES' });
    expect(seen).toEqual([]);
  });

  it('refuses a different file at the same path (another identity), even inside the root', async () => {
    const path = put(root, 'p/ok.jsonl', '{"a":1}\n');
    const file = await listed(path);
    renameSync(put(root, 'p/other.jsonl', '{"b":2}\n'), path);
    await expect(
      tailFile(file, null, handlers(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'ESTALE' });
  });

  it('refuses a FIFO without waiting for a writer', async () => {
    const pipe = join(root, 'p.jsonl');
    try {
      execFileSync('mkfifo', [pipe]);
    } catch {
      return;
    }
    const guard = { root, realRoot: realpathSync(root), dev: 0, ino: 0 };
    await expect(openWithin({ path: pipe, guard })).rejects.toMatchObject({ code: 'EACCES' });
    await expect(openWithin({ path: pipe })).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('reads a file that is where it was listed, and keeps reading it as it grows', async () => {
    const path = put(root, 'p/ok.jsonl', '{"n":1}\n');
    const seen: string[] = [];
    const first = await tailFile(
      await listed(path),
      null,
      handlers(seen),
      new AbortController().signal,
    );
    expect(seen).toEqual(['{"n":1}']);
    appendFileSync(path, '{"n":2}\n');
    clock += 1_000;
    utimesSync(path, new Date(clock), new Date(clock));
    const second = await tailFile(
      await listed(path),
      first?.state ?? null,
      handlers(seen),
      new AbortController().signal,
    );
    expect(seen).toEqual(['{"n":1}', '{"n":2}']);
    expect(second?.reset).toBe(false);
  });
});

describe('the feeds', () => {
  const sleep = manualSleep();
  const logger = memoryLogger('debug').logger;

  it('a Claude Code project folder that is a link to another place leads nowhere', async () => {
    const claudeDir = join(home, '.claude');
    const projects = join(claudeDir, 'projects');
    mkdirSync(projects, { recursive: true });
    const stolen = put(
      outside,
      'stolen.jsonl',
      line(claudePrompt(at(30), { sessionId: 'stolen' })) + '\n',
    );
    stamp(stolen, at(30));
    symlinkSync(outside, join(projects, 'linked'), 'dir');
    const feed = createClaudeFeed({
      configDirs: () => [claudeDir],
      now: () => at(32),
      logger,
      sleep,
    });
    feed.start();
    await feed.ready();
    await settle();
    expect(feed.status()).toBe('live');
    expect(feed.read()).toEqual({ agents: [], files: 0 });
    await feed.stop();
  });

  it('a Codex rollout reached through a linked date folder is not followed or read for its identity', async () => {
    const codexHome = join(home, '.codex');
    const sessions = join(codexHome, 'sessions', '2026');
    mkdirSync(sessions, { recursive: true });
    const rollout = put(
      outside,
      `rollout-2026-11-19T09-59-00-${R1}.jsonl`,
      [line(codexSessionMeta(at(29), { id: R1 })), line(codexTaskStarted(at(30)))].join('\n') +
        '\n',
    );
    stamp(rollout, at(30));
    symlinkSync(outside, join(sessions, '11'), 'dir');
    const feed = createCodexFeed({
      homes: () => [codexHome],
      now: () => at(32),
      logger,
      sleep,
    });
    feed.start();
    await feed.ready();
    await settle();
    expect(feed.read()).toEqual({ agents: [], files: 0 });
    await feed.stop();
  });
});
