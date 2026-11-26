import { expect, it } from 'vitest';
import type { TranscriptAgent } from '../../../src/server/collectors/live/feed.ts';
import { createHookStore } from '../../../src/server/services/hq/hookStore.ts';
import { buildRoster } from '../../../src/server/services/hq/roster.ts';
import type { HqClaudeHookEvent } from '../../../src/shared/contracts/hq.ts';
import { NOW, liveAgent } from '../../collectors/paseo/liveHelpers.ts';

const MINUTE = 60_000;
const child: TranscriptAgent = {
  provider: 'claude',
  sessionId: 'parent:agent-alpha',
  parentSessionId: 'parent',
  cwd: '/work/project',
  startedAt: null,
  state: 'idle',
  activity: 'none',
  waitReason: null,
  since: NOW,
  lastActivityAt: NOW,
};

function setup() {
  let now = NOW;
  const hooks = createHookStore({ now: () => now });
  const stop = (
    observedAt = now,
    tasks: NonNullable<HqClaudeHookEvent['background_work']>['tasks'] = [
      { id: 'alpha', type: 'subagent', status: 'running' },
      { id: 'alpha', type: 'subagent', status: 'running' },
      { id: 'only-in-hook', type: 'subagent', status: 'running' },
      { id: 'job', type: 'shell', status: 'running' },
    ],
  ): HqClaudeHookEvent => ({
    hook_event_name: 'Stop',
    session_id: 'parent',
    cwd: '/work/project',
    background_work: { observed_at: observedAt, tasks },
  });
  const roster = (
    transcripts: TranscriptAgent[] = [],
    agents: ReturnType<typeof liveAgent>[] = [],
  ) =>
    buildRoster({
      agents,
      transcripts,
      now,
      hooks: hooks.read(),
      background: hooks.readBackground(),
    }).agents;
  return {
    hooks,
    stop,
    roster,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

it('ties a background subagent to its parent and preserves a last-reported summary after transcript expiry', () => {
  const { hooks, stop, roster, advance } = setup();
  hooks.record(stop());
  const agents = roster([
    child,
    { ...child, sessionId: 'other:agent-alpha', parentSessionId: 'other' },
  ]);
  const parent = agents.find((agent) => agent.kind === 'root');
  expect(parent?.backgroundWork).toEqual({
    subagents: 2,
    shellJobs: 1,
    monitors: 0,
    reportedAt: new Date(NOW).toISOString(),
    stale: false,
  });
  expect(agents.filter((agent) => agent.backgroundSubagent)).toEqual([
    expect.objectContaining({ parentId: parent?.id }),
  ]);
  expect(JSON.stringify(agents)).not.toContain('only-in-hook');
  advance(15 * MINUTE);
  expect(roster()).toEqual([
    expect.objectContaining({
      id: parent?.id,
      state: 'idle',
      backgroundWork: expect.objectContaining({ stale: true }),
    }),
  ]);
  advance(24 * 60 * MINUTE);
  expect(roster()).toEqual([]);
});

it('clears a confirmed empty, unavailable, ended or opted-out snapshot and rejects old snapshots', () => {
  const { hooks, stop, roster, advance } = setup();
  hooks.record(stop());
  advance(1_000);
  hooks.record(stop(NOW + 1_000, []));
  hooks.record(stop(NOW));
  expect(roster()[0]?.backgroundWork).toBeUndefined();
  advance(1_000);
  hooks.record(stop());
  advance(1_000);
  hooks.record(stop(NOW + 3_000, null));
  expect(roster()[0]?.backgroundWork).toBeUndefined();
  advance(1_000);
  hooks.record(stop());
  hooks.record({ hook_event_name: 'SessionEnd', session_id: 'parent' });
  hooks.record(stop());
  expect(roster()).toEqual([]);
  advance(1_000);
  hooks.record(stop());
  hooks.clearBackground();
  expect(roster()[0]?.backgroundWork).toBeUndefined();
});

it('uses the managed Paseo signal without adding a Claude count to it', () => {
  const { hooks, stop, roster } = setup();
  hooks.record(stop());
  expect(
    roster(
      [],
      [
        liveAgent({
          id: 'managed',
          provider: 'claude',
          sessionId: 'parent',
          backgroundWorkActive: true,
        }),
      ],
    ),
  ).toEqual([expect.objectContaining({ backgroundWorkActive: true })]);
  expect(
    roster(
      [],
      [
        liveAgent({
          id: 'managed',
          provider: 'claude',
          sessionId: 'parent',
          backgroundWorkActive: true,
        }),
      ],
    )[0]?.backgroundWork,
  ).toBeUndefined();
});

it('keeps a prior lifecycle’s delayed report from reviving work after the same session resumes', () => {
  const { hooks, stop, roster, advance } = setup();
  advance(1_000);
  hooks.record({ hook_event_name: 'SessionEnd', session_id: 'parent' });
  advance(1_000);
  hooks.record({ hook_event_name: 'SessionStart', session_id: 'parent' });
  hooks.record(stop(NOW));
  expect(roster()).toEqual([expect.objectContaining({ state: 'starting' })]);
  expect(roster()[0]?.backgroundWork).toBeUndefined();
  advance(1_000);
  hooks.record(stop());
  expect(roster()[0]?.backgroundWork?.subagents).toBe(2);
});
