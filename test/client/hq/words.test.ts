import { describe, expect, it } from 'vitest';
import type { HqAgent } from '../../../src/shared/contracts/hq';
import {
  agentDisplayTitle,
  agentMeta,
  elapsed,
  feedName,
  providerName,
  sceneCaption,
  stateWords,
  summaryLine,
} from '../../../src/client/features/hq/copy';
import { buildSessions, groupSessions } from '../../../src/client/features/hq/sessions';
import { NOW } from '../../server/helpers';
import { agent, officeAgents } from '../../fixtures/hq/scripted';

// The words HQ speaks and the shape it gives the roster: pure, so no browser is needed.

const base = (over: Partial<HqAgent>): HqAgent =>
  agent(NOW, { id: 'a', provider: 'claude', ...over });

const backgroundWork = {
  subagents: 2,
  shellJobs: 1,
  monitors: 0,
  reportedAt: new Date(NOW - 8 * 60_000).toISOString(),
  stale: false,
};

it('distinguishes generic and unnamed subagents using the opaque roster id', () => {
  const child = base({ id: 'a123456789abc', kind: 'child', parentAway: true });
  expect(agentDisplayTitle(child)).toBe('Subagent · 789abc');
  expect(agentDisplayTitle({ ...child, title: 'general-purpose' })).toBe(
    'general-purpose · 789abc',
  );
  expect(agentDisplayTitle({ ...child, title: 'Explore' })).toBe('Explore');
  expect(agentDisplayTitle(base({}))).toBeNull();
});

describe('stateWords', () => {
  it.each([
    ['editing', 'Editing'],
    ['reading', 'Reading'],
    ['command', 'Running a command'],
    ['thinking', 'Thinking'],
    ['responding', 'Responding'],
    ['delegating', 'Delegating'],
    ['planning', 'Planning'],
    ['tool', 'Using a tool'],
    ['none', 'Working'],
  ] as const)('says "%s" work as "%s"', (activity, words) => {
    expect(stateWords(base({ state: 'working', activity }), NOW)).toBe(words);
  });

  it('says what a reported wait needs, and only "may be waiting" for an inferred one', () => {
    const waiting = { state: 'waiting', activity: 'none' } as const;
    expect(stateWords(base({ ...waiting, waitReason: 'permission' }), NOW)).toBe(
      'Needs you: permission',
    );
    expect(stateWords(base({ ...waiting, waitReason: 'question' }), NOW)).toBe(
      'Needs you: question',
    );
    expect(stateWords(base({ ...waiting, waitReason: 'plan_approval' }), NOW)).toBe(
      'Needs you: plan approval',
    );
    expect(stateWords(base({ ...waiting, waitReason: null }), NOW)).toBe('Needs you');
    expect(stateWords(base({ ...waiting, waitReason: null, confidence: 'inferred' }), NOW)).toBe(
      'May be waiting for you',
    );
    // An inferred wait never claims a reason it cannot know.
    expect(
      stateWords(base({ ...waiting, waitReason: 'permission', confidence: 'inferred' }), NOW),
    ).toBe('May be waiting for you');
  });

  it('measures idle time from when the state began, against the given clock', () => {
    const idle = base({
      state: 'idle',
      activity: 'none',
      since: new Date(NOW - 12 * 60_000).toISOString(),
    });
    expect(stateWords(idle, NOW)).toBe('Idle for 12 min');
    expect(stateWords(idle, NOW + 60 * 60_000)).toBe('Idle for 1 h 12 min');
  });

  it('shows the activity of a working state that was only inferred from a transcript, as it does a reported one', () => {
    expect(
      stateWords(base({ state: 'working', activity: 'reading', confidence: 'inferred' }), NOW),
    ).toBe('Reading');
    expect(
      stateWords(base({ state: 'working', activity: 'command', confidence: 'inferred' }), NOW),
    ).toBe('Running a command');
    expect(
      sceneCaption(base({ state: 'working', activity: 'editing', confidence: 'inferred' })),
    ).toBe('editing');
  });

  it('words the other states plainly', () => {
    expect(stateWords(base({ state: 'starting' }), NOW)).toBe('Starting');
    expect(stateWords(base({ state: 'finished' }), NOW)).toBe('Finished');
    expect(stateWords(base({ state: 'error' }), NOW)).toBe('Something went wrong');
  });

  it('describes unread completion independently of continuing background work', () => {
    const finished = base({ state: 'finished', reviewPending: true });
    expect(stateWords(finished, NOW)).toBe('Ready to review');
    expect(sceneCaption(finished)).toBe('review');
    expect(stateWords({ ...finished, backgroundWorkActive: true }, NOW)).toBe(
      'Ready to review · Background work running',
    );
  });

  it('shows the reported counts and age independently of foreground and live states', () => {
    const idle = base({ state: 'idle', backgroundWork });
    const report = '2 background subagents · 1 shell job · last reported 8 min ago';
    expect(stateWords(idle, NOW)).toBe(`Idle for 5 min · ${report}`);
    expect(stateWords({ ...idle, backgroundWorkActive: true }, NOW)).toBe(
      `Background work running · ${report}`,
    );
    expect(stateWords({ ...idle, state: 'waiting', waitReason: 'permission' }, NOW)).toBe(
      `Needs you: permission · ${report}`,
    );
    expect(
      stateWords(
        { ...idle, state: 'finished', backgroundWork: { ...backgroundWork, stale: true } },
        NOW,
      ),
    ).toBe(`Finished · ${report}`);
    expect(
      stateWords(
        { ...idle, backgroundWork: { ...backgroundWork, subagents: 0, shellJobs: 2, monitors: 1 } },
        NOW + 60_000,
      ),
    ).toBe('Idle for 6 min · 2 shell jobs · 1 monitor · last reported 9 min ago');
    expect(stateWords({ ...idle, backgroundWork: undefined, backgroundSubagent: true }, NOW)).toBe(
      'Background subagent reported',
    );
  });
});

describe('elapsed', () => {
  it('is coarse, never negative', () => {
    expect(elapsed(NOW, NOW)).toBe('under a minute');
    expect(elapsed(NOW + 5_000, NOW)).toBe('under a minute');
    expect(elapsed(NOW - 59 * 60_000, NOW)).toBe('59 min');
    expect(elapsed(NOW - 2 * 3_600_000, NOW)).toBe('2 h');
    expect(elapsed(NOW - 49 * 3_600_000, NOW)).toBe('2 d');
  });
});

describe('summaryLine', () => {
  it('counts what is happening, leaving zeros out', () => {
    expect(summaryLine(officeAgents(NOW))).toBe('6 working · 1 needs you');
    expect(summaryLine([])).toBe('');
  });

  it('says "may need you" for an inferred wait', () => {
    expect(
      summaryLine([
        { state: 'waiting', confidence: 'inferred' },
        { state: 'working', confidence: 'reported' },
        { state: 'error', confidence: 'reported' },
      ]),
    ).toBe('1 working · 1 may need you · 1 with an error');
  });

  it('counts background work, review and actionable errors without counting idle sessions', () => {
    expect(
      summaryLine([
        base({ state: 'finished', backgroundWorkActive: true, reviewPending: true }),
        base({ state: 'error', reviewPending: false }),
        base({ state: 'error', reviewPending: true }),
        base({ state: 'idle' }),
      ]),
    ).toBe('1 working · 1 ready to review · 1 with an error');
  });

  it('describes recent snapshot-only agents separately from working agents', () => {
    expect(
      summaryLine([
        base({ state: 'idle', backgroundWork }),
        base({ state: 'idle', backgroundSubagent: true }),
        base({ state: 'idle', backgroundWork: { ...backgroundWork, stale: true } }),
        base({ state: 'idle', backgroundWork, backgroundWorkActive: true }),
      ]),
    ).toBe('1 working · 1 with background work reported');
  });
});

describe('names', () => {
  it('uses the product’s provider and feed names', () => {
    expect(providerName('codex')).toBe('Codex');
    expect(providerName('claude')).toBe('Claude Code');
    expect(providerName('other')).toBe('Other agent');
    expect(feedName({ id: 'paseo', status: 'live' })).toBe('Paseo');
  });

  it('puts where an agent works after its provider, preferring the repo', () => {
    expect(agentMeta(base({ provider: 'codex', repo: 'a/b', workspace: 'w' }))).toBe('Codex · a/b');
    expect(agentMeta(base({ workspace: 'w', parentAway: true }))).toBe(
      'Claude Code · w · Started by an agent that isn’t listed',
    );
    expect(agentMeta(base({ workspace: 'Scratch workspace', title: 'Scratch workspace' }))).toBe(
      'Claude Code',
    );
  });
});

describe('buildSessions', () => {
  it('makes one session per root, the waiting one first, with children nested under their parent', () => {
    const sessions = buildSessions(officeAgents(NOW));
    expect(sessions.map((s) => s.root.agent.id)).toEqual([
      'hq-sync',
      'hq-solo-claude',
      'hq-build',
      'hq-solo-codex',
    ]);
    expect(sessions.map((s) => s.size)).toEqual([2, 1, 4, 1]);
    expect(sessions.map((s) => s.waiting)).toEqual([true, false, false, false]);
    const build = sessions[2]!;
    expect(build.root.children.map((c) => c.agent.id)).toEqual([
      'hq-build-review',
      'hq-build-checks',
      'hq-build-plan',
    ]);
  });

  it('marks a session waiting when a child is the one waiting, and sorts it first', () => {
    const agents = officeAgents(NOW).map((a) =>
      a.id === 'hq-build-plan' ? { ...a, state: 'waiting' as const, activity: 'none' as const } : a,
    );
    const sessions = buildSessions(agents);
    // Both waiting sessions come before every other, the newer root first.
    expect(sessions.map((session) => session.waiting)).toEqual([true, true, false, false]);
    expect(sessions[1]!.root.agent.id).toBe('hq-build');
    expect(sessions[1]!.size).toBe(4);
  });

  it('gives an agent whose parent is not on the roster a session of its own', () => {
    const orphan = base({ id: 'o', kind: 'child', parentId: null, parentAway: true });
    const sessions = buildSessions([orphan]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.root.agent.parentAway).toBe(true);
    // A parentId that names nobody on the roster is treated the same.
    const dangling = buildSessions([{ ...orphan, parentId: 'gone' }]);
    expect(dangling).toHaveLength(1);
  });

  it('keeps nesting deeper than two levels, and never loses an agent to a parent cycle', () => {
    const chain = buildSessions([
      base({ id: 'r' }),
      base({ id: 'c', kind: 'child', parentId: 'r' }),
      base({ id: 'g', kind: 'child', parentId: 'c' }),
    ]);
    expect(chain).toHaveLength(1);
    expect(chain[0]!.size).toBe(3);
    const cycle = buildSessions([
      base({ id: 'x', kind: 'child', parentId: 'y' }),
      base({ id: 'y', kind: 'child', parentId: 'x' }),
    ]);
    expect(cycle.reduce((sum, s) => sum + s.size, 0)).toBe(2);
  });

  it('keeps the order between polls when only the clock moves', () => {
    const a = buildSessions(officeAgents(NOW)).map((s) => s.id);
    const b = buildSessions(officeAgents(NOW + 90_000)).map((s) => s.id);
    expect(b).toEqual(a);
  });
});

describe('groupSessions', () => {
  it('keeps a crew in focus for any member and orders idle sessions by recent activity across their crews', () => {
    const grouped = groupSessions([
      base({ id: 'parent', state: 'idle', confirmedEmpty: true }),
      base({
        id: 'empty-helper',
        kind: 'child',
        parentId: 'parent',
        state: 'idle',
        confirmedEmpty: true,
      }),
      base({
        id: 'review-helper',
        kind: 'child',
        parentId: 'parent',
        state: 'finished',
        reviewPending: true,
      }),
      base({ id: 'background', state: 'finished', backgroundWorkActive: true }),
      base({ id: 'error', state: 'error' }),
      base({ id: 'empty', state: 'idle', confirmedEmpty: true }),
      base({ id: 'idle', state: 'idle', lastActivityAt: new Date(NOW - 500).toISOString() }),
      base({
        id: 'read',
        state: 'error',
        reviewPending: false,
        lastActivityAt: new Date(NOW - 2000).toISOString(),
      }),
      base({
        id: 'read-helper',
        kind: 'child',
        parentId: 'read',
        state: 'idle',
        lastActivityAt: new Date(NOW - 100).toISOString(),
      }),
    ]);

    expect(grouped.focus.map(({ id }) => id)).toEqual(['error', 'background', 'parent']);
    const parent = grouped.focus[2]!;
    expect(parent.size).toBe(2);
    expect(parent.root.children.map(({ agent }) => agent.id)).toEqual(['review-helper']);
    expect(grouped.recentIdle.map(({ id }) => id)).toEqual(['read', 'idle']);
  });

  it('keeps empty starting agents only as context for a visible descendant', () => {
    const empty = base({ id: 'empty', state: 'starting', confirmedEmpty: true });
    const parent = { ...empty, id: 'parent' };
    const idle = base({ id: 'recent', kind: 'child', parentId: 'parent', state: 'idle' });
    expect(summaryLine([empty, parent, idle])).toBe('');
    const grouped = groupSessions([empty, parent, idle]);
    expect(grouped.focus).toEqual([]);
    expect(grouped.recentIdle.map(({ id, size }) => [id, size])).toEqual([['parent', 2]]);
  });

  it('keeps a crew in focus for a fresh snapshot or marked child', () => {
    const parent = base({ id: 'parent', state: 'idle', backgroundWork });
    const child = base({ id: 'child', kind: 'child', parentId: 'parent', state: 'finished' });
    expect(groupSessions([parent, child]).focus.map(({ id }) => id)).toEqual(['parent']);

    const stale = { ...parent, backgroundWork: { ...backgroundWork, stale: true } };
    expect(groupSessions([stale, child]).recentIdle.map(({ id }) => id)).toEqual(['parent']);
    expect(
      groupSessions([stale, { ...child, backgroundSubagent: true }]).focus.map(({ id }) => id),
    ).toEqual(['parent']);
  });
});
