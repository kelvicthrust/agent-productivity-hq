import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClaudeFeed } from '../../../src/server/collectors/live/claudeFeed.ts';
import { createCodexFeed } from '../../../src/server/collectors/live/codexFeed.ts';
import {
  createTranscriptFeed,
  type Tracker,
  type TranscriptAgent,
} from '../../../src/server/collectors/live/feed.ts';
import type { RecentFile } from '../../../src/server/collectors/live/recent.ts';
import { readLiveAgent } from '../../../src/server/collectors/paseo/liveAgent.ts';
import {
  MAX_LIVE_ID_CHARS,
  MAX_LIVE_PATH_CHARS,
  MAX_LIVE_TITLE_CHARS,
} from '../../../src/server/lib/liveText.ts';
import { buildRoster } from '../../../src/server/services/hq/roster.ts';
import { entry as paseoEntry, manualSleep } from '../paseo/liveHelpers.ts';
import { memoryLogger } from '../../server/helpers.ts';
import { R1, at } from './feedHelpers.ts';
import { claudePrompt, codexSessionMeta, codexTaskStarted, line } from './lines.ts';

// What one hostile line, file or value cannot do: stop the other files, take the answer down, or grow what is kept without bound.

const NOW = at(34);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'live-hostile-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function put(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  utimesSync(path, new Date(NOW - 1_000), new Date(NOW - 1_000));
  return path;
}

const agentOf = (sessionId: string): TranscriptAgent => ({
  provider: 'claude',
  sessionId,
  parentSessionId: null,
  cwd: null,
  startedAt: null,
  state: 'working',
  activity: 'thinking',
  waitReason: null,
  since: NOW - 1_000,
  lastActivityAt: NOW - 1_000,
});

describe('a tracker that throws', () => {
  function feedWith(tracker: (name: string) => Tracker) {
    return createTranscriptFeed({
      now: () => NOW,
      logger: memoryLogger('debug').logger,
      sleep: manualSleep(),
      source: {
        provider: 'claude',
        roots: () => [dir],
        accept: (rel) => rel.endsWith('.jsonl'),
        hotDirs: (followed: readonly RecentFile[]) => followed.map((file) => dirname(file.path)),
        start: (file) => Promise.resolve(tracker(file.rel)),
      },
    });
  }

  it('on one line does not stop the file: the lines after it are read, and the session still answers', async () => {
    put(join(dir, 'a.jsonl'), 'poison\nfine\nfine\n');
    let fine = 0;
    let unreadable = 0;
    const feed = feedWith(() => ({
      line: (text) => {
        if (text === 'poison') throw new Error('cannot read this');
        fine += 1;
      },
      overlong: () => {
        unreadable += 1;
      },
      agent: () => agentOf('a'),
    }));
    feed.start();
    await feed.ready();
    expect(feed.status()).toBe('live');
    expect(fine).toBe(2);
    expect(unreadable).toBe(1); // counted as a line that could not be read
    expect(feed.read().agents).toHaveLength(1);
    await feed.stop();
  });

  it('when asked for its state does not take the other sessions out of the answer', async () => {
    put(join(dir, 'a.jsonl'), '{}\n');
    put(join(dir, 'b.jsonl'), '{}\n');
    const feed = feedWith((name) => ({
      line: () => undefined,
      overlong: () => undefined,
      agent: () => {
        if (name === 'a.jsonl') throw new Error('broken');
        return agentOf(name);
      },
    }));
    feed.start();
    await feed.ready();
    expect(feed.read().agents.map((agent) => agent.sessionId)).toEqual(['b.jsonl']);
    await feed.stop();
  });
});

describe('text from outside is bounded', () => {
  it('a Claude working directory longer than a path can be is not kept', async () => {
    const long = `/${'d'.repeat(MAX_LIVE_PATH_CHARS)}`;
    const claudeDir = join(dir, '.claude');
    put(
      join(claudeDir, 'projects', '-p', 's1.jsonl'),
      `${line(claudePrompt(NOW - 2_000, { sessionId: 's1', cwd: long }))}\n`,
    );
    const feed = createClaudeFeed({
      configDirs: () => [claudeDir],
      now: () => NOW,
      logger: memoryLogger('debug').logger,
      sleep: manualSleep(),
    });
    feed.start();
    await feed.ready();
    expect(feed.read().agents.map((agent) => [agent.sessionId, agent.cwd])).toEqual([['s1', null]]);
    await feed.stop();
  });

  it('a Codex session id, parent id and working directory that are too long fall back to the file name and nothing', async () => {
    const home = join(dir, '.codex');
    put(
      join(home, 'sessions', '2026', '11', '19', `rollout-2026-11-19T09-59-00-${R1}.jsonl`),
      [
        line(
          codexSessionMeta(NOW - 3_000, {
            id: 'x'.repeat(MAX_LIVE_ID_CHARS + 1),
            cwd: `/${'d'.repeat(MAX_LIVE_PATH_CHARS)}`,
          }),
        ),
        line(codexTaskStarted(NOW - 2_000)),
      ].join('\n') + '\n',
    );
    const feed = createCodexFeed({
      homes: () => [home],
      now: () => NOW,
      logger: memoryLogger('debug').logger,
      sleep: manualSleep(),
    });
    feed.start();
    await feed.ready();
    expect(feed.read().agents.map((agent) => [agent.sessionId, agent.cwd])).toEqual([[R1, null]]);
    await feed.stop();
  });

  it('a Paseo agent with an id that is too long is not kept, and a title or workspace name is cut', () => {
    const long = 'z'.repeat(MAX_LIVE_TITLE_CHARS * 3);
    expect(readLiveAgent(paseoEntry({ id: 'i'.repeat(MAX_LIVE_ID_CHARS + 1) }), NOW)).toBeNull();
    const kept = readLiveAgent(paseoEntry({ id: 'p1', title: long }), NOW);
    expect(kept?.title).toHaveLength(MAX_LIVE_TITLE_CHARS);
    const named = readLiveAgent(
      paseoEntry({ id: 'p1', sessionId: 's'.repeat(MAX_LIVE_ID_CHARS + 1) }),
      NOW,
    );
    expect(named?.sessionId).toBeNull();
  });

  it('the roster cuts a workspace taken from a folder name', () => {
    const roster = buildRoster({
      agents: [],
      transcripts: [
        {
          ...agentOf('s1'),
          cwd: `/work/${'w'.repeat(MAX_LIVE_TITLE_CHARS * 2)}`,
        },
      ],
      now: NOW,
    });
    expect(roster.agents[0]?.workspace).toHaveLength(MAX_LIVE_TITLE_CHARS);
  });
});
