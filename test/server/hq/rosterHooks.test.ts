import { describe, expect, it } from 'vitest';
import type { TranscriptAgent } from '../../../src/server/collectors/live/feed.ts';
import { FINISHED_VISIBLE_MS } from '../../../src/server/collectors/live/heuristics.ts';
import { liveSessionKey } from '../../../src/server/db/queries/hq.ts';
import type { HookRecord } from '../../../src/server/services/hq/hookStore.ts';
import { createHookStore, HOOK_KEEP_MS } from '../../../src/server/services/hq/hookStore.ts';
import {
  HOOK_FUTURE_SKEW_MS,
  HOOK_START_VISIBLE_MS,
  buildRoster,
  createKeyMemo,
  keyId,
} from '../../../src/server/services/hq/roster.ts';
import { HqAgent } from '../../../src/shared/contracts/hq.ts';
import { NOW, liveAgent } from '../../collectors/paseo/liveHelpers.ts';

// Claude Code's hook events as the roster's fourth input (data-and-sources › Claude Code hooks › Precedence). Pure.

const SEC = 1_000;

const transcript = (over: Partial<TranscriptAgent> = {}): TranscriptAgent => ({
  provider: 'claude',
  sessionId: 's1',
  parentSessionId: null,
  cwd: '/work/invented/project',
  startedAt: null,
  state: 'working',
  activity: 'editing',
  waitReason: null,
  since: NOW - 60 * SEC,
  lastActivityAt: NOW - 20 * SEC,
  ...over,
});
const hook = (kind: HookRecord['kind'], at: number, cwd: string | null = null): HookRecord => ({
  kind,
  at,
  cwd,
});
const build = (input: {
  transcripts?: TranscriptAgent[];
  hooks?: Record<string, HookRecord>;
  paseo?: Parameters<typeof liveAgent>[0][];
  now?: number;
}) =>
  buildRoster({
    agents: (input.paseo ?? []).map(liveAgent),
    transcripts: input.transcripts ?? [],
    hooks: new Map(Object.entries(input.hooks ?? {})),
    now: input.now ?? NOW,
  });
const only = (roster: ReturnType<typeof buildRoster>) => {
  expect(roster.agents).toHaveLength(1);
  return HqAgent.parse(roster.agents[0]);
};

describe('a permission request', () => {
  it('beats the transcript: waiting for permission, reported, since the request', () => {
    const agent = only(
      build({
        transcripts: [transcript()],
        hooks: { s1: hook('permission', NOW - 5 * SEC) },
      }),
    );
    expect(agent).toMatchObject({
      state: 'waiting',
      waitReason: 'permission',
      confidence: 'reported',
      activity: 'none',
      since: new Date(NOW - 5 * SEC).toISOString(),
      lastActivityAt: new Date(NOW - 5 * SEC).toISOString(),
      seenBy: { paseo: false, transcript: true },
    });
  });

  it('keeps the transcript’s own reason for a question or a plan, now reported', () => {
    for (const reason of ['question', 'plan_approval'] as const) {
      const agent = only(
        build({
          transcripts: [
            transcript({ state: 'waiting', waitReason: reason, since: NOW - 10 * SEC }),
          ],
          hooks: { s1: hook('permission', NOW - 5 * SEC) },
        }),
      );
      expect(agent).toMatchObject({ state: 'waiting', waitReason: reason, confidence: 'reported' });
    }
  });

  it('is cleared by any later transcript line: a tool result, a prompt, assistant output', () => {
    for (const state of ['working', 'idle', 'finished'] as const) {
      const agent = only(
        build({
          transcripts: [transcript({ state, lastActivityAt: NOW - 1 * SEC })],
          hooks: { s1: hook('permission', NOW - 5 * SEC) },
        }),
      );
      expect(agent).toMatchObject({ state, confidence: 'inferred' });
    }
  });

  it('speaks when the transcript’s last line is the same instant or older', () => {
    const same = only(
      build({
        transcripts: [transcript({ lastActivityAt: NOW - 5 * SEC })],
        hooks: { s1: hook('permission', NOW - 5 * SEC) },
      }),
    );
    expect(same.state).toBe('waiting');
  });

  it('shows a session no transcript has been read for yet (the transcript lags the prompt)', () => {
    const agent = only(
      build({ hooks: { s1: hook('permission', NOW - 3 * SEC, '/work/invented/widgets') } }),
    );
    expect(agent).toMatchObject({
      id: keyId('claude:s1'),
      provider: 'claude',
      kind: 'root',
      state: 'waiting',
      waitReason: 'permission',
      confidence: 'reported',
      workspace: 'widgets',
      title: null,
      seenBy: { paseo: false, transcript: false },
      startedAt: null,
    });
  });

  it('keeps the id the session has when its transcript appears', () => {
    const memo = createKeyMemo();
    const first = buildRoster({
      agents: [],
      hooks: new Map([['s1', hook('permission', NOW - 3 * SEC)]]),
      now: NOW,
      memo,
    });
    const second = buildRoster({
      agents: [],
      transcripts: [transcript({ lastActivityAt: NOW - 20 * SEC })],
      hooks: new Map([['s1', hook('permission', NOW - 3 * SEC)]]),
      now: NOW + SEC,
      memo,
    });
    expect(second.agents[0]!.id).toBe(first.agents[0]!.id);
  });
});

describe('the other events', () => {
  it('an idle prompt: the turn is over and it is the owner’s move, idle, reported', () => {
    const agent = only(
      build({
        transcripts: [transcript({ state: 'finished', lastActivityAt: NOW - 61 * SEC })],
        hooks: { s1: hook('idle', NOW - 1 * SEC) },
      }),
    );
    expect(agent).toMatchObject({
      state: 'idle',
      confidence: 'reported',
      activity: 'none',
      waitReason: null,
      since: new Date(NOW - 1 * SEC).toISOString(),
    });
  });

  it('an idle prompt with no transcript shows the session as idle (it exists, and it is the owner’s move)', () => {
    expect(
      only(build({ hooks: { s1: hook('idle', NOW - SEC, '/work/invented/widgets') } })),
    ).toMatchObject({
      state: 'idle',
      confidence: 'reported',
      title: null,
      workspace: 'widgets',
      since: new Date(NOW - SEC).toISOString(),
      seenBy: { paseo: false, transcript: false },
    });
  });

  it('a stop: finished, reported, for the finished window; then idle', () => {
    const finished = only(
      build({
        transcripts: [transcript({ lastActivityAt: NOW - 30 * SEC })],
        hooks: { s1: hook('stop', NOW - 10 * SEC) },
      }),
    );
    expect(finished).toMatchObject({ state: 'finished', confidence: 'reported' });
    const later = only(
      build({
        transcripts: [transcript({ lastActivityAt: NOW - 200 * SEC })],
        hooks: { s1: hook('stop', NOW - 100 * SEC) },
      }),
    );
    expect(later).toMatchObject({
      state: 'idle',
      since: new Date(NOW - 100 * SEC + FINISHED_VISIBLE_MS).toISOString(),
    });
    // With no transcript either, the session is finished for the window and idle after it (until its end or its event is forgotten).
    expect(build({ hooks: { s1: hook('stop', NOW - 10 * SEC) } }).agents[0]?.state).toBe(
      'finished',
    );
    expect(only(build({ hooks: { s1: hook('stop', NOW - 100 * SEC) } }))).toMatchObject({
      state: 'idle',
      confidence: 'reported',
      since: new Date(NOW - 100 * SEC + FINISHED_VISIBLE_MS).toISOString(),
    });
  });

  it('a new prompt after a stop (a later transcript line) is working again', () => {
    const agent = only(
      build({
        transcripts: [transcript({ lastActivityAt: NOW - 2 * SEC })],
        hooks: { s1: hook('stop', NOW - 10 * SEC) },
      }),
    );
    expect(agent.state).toBe('working');
  });

  it('a session start with no transcript is starting, for a short while only', () => {
    const agent = only(build({ hooks: { s1: hook('start', NOW - 2 * SEC, '/work/a') } }));
    expect(agent).toMatchObject({
      state: 'starting',
      confidence: 'reported',
      startedAt: new Date(NOW - 2 * SEC).toISOString(),
    });
    expect(
      build({ hooks: { s1: hook('start', NOW - HOOK_START_VISIBLE_MS - SEC) } }).agents,
    ).toEqual([]);
  });

  it('a session start leaves a session that has a transcript as the transcript reads it (a compaction restarts a session)', () => {
    const agent = only(
      build({ transcripts: [transcript()], hooks: { s1: hook('start', NOW - 2 * SEC) } }),
    );
    expect(agent).toMatchObject({ state: 'working', confidence: 'inferred' });
  });

  it('a session end takes the agent off the roster at once, however recent its transcript', () => {
    expect(
      build({
        transcripts: [transcript({ lastActivityAt: NOW - 3 * SEC })],
        hooks: { s1: hook('end', NOW - 2 * SEC) },
      }).agents,
    ).toEqual([]);
    expect(build({ hooks: { s1: hook('end', NOW - 2 * SEC) } }).agents).toEqual([]);
  });

  it('a session that is used again after it ended (a later line) is back', () => {
    const agent = only(
      build({
        transcripts: [transcript({ lastActivityAt: NOW - 1 * SEC })],
        hooks: { s1: hook('end', NOW - 10 * SEC) },
      }),
    );
    expect(agent.state).toBe('working');
  });

  it('other sessions are not touched by a session’s event', () => {
    const roster = build({
      transcripts: [transcript({ sessionId: 's1' }), transcript({ sessionId: 's2' })],
      hooks: { s1: hook('end', NOW - SEC), s2: hook('permission', NOW - SEC) },
    });
    expect(roster.agents).toHaveLength(1);
    expect(roster.agents[0]).toMatchObject({
      id: keyId(liveSessionKey('claude', 's2')),
      state: 'waiting',
    });
  });

  it('ignores a Codex session with the same id, and a subagent transcript (the parent is the one that waits)', () => {
    const codex = build({
      transcripts: [transcript({ provider: 'codex', sessionId: 's1' })],
      hooks: { s1: hook('end', NOW - SEC) },
    });
    expect(codex.agents).toHaveLength(1);
    const sub = build({
      transcripts: [
        transcript({ sessionId: 's1:agent-a', parentSessionId: 's1' }),
        transcript({ sessionId: 's1' }),
      ],
      hooks: { s1: hook('permission', NOW - SEC) },
    });
    expect(sub.agents.find((a) => a.parentId !== null)?.state).toBe('working');
    expect(sub.agents.find((a) => a.parentId === null)?.state).toBe('waiting');
  });
});

describe('Paseo keeps its precedence', () => {
  it('a Paseo agent that owns the session shows Paseo’s state, whatever the hooks say', () => {
    const roster = build({
      paseo: [{ id: 'a1', provider: 'claude', sessionId: 's1', status: 'running' }],
      transcripts: [transcript()],
      hooks: { s1: hook('permission', NOW - SEC) },
    });
    expect(roster.agents).toHaveLength(1);
    expect(roster.agents[0]).toMatchObject({
      state: 'working',
      confidence: 'reported',
      seenBy: { paseo: true },
    });
    const ended = build({
      paseo: [{ id: 'a1', provider: 'claude', sessionId: 's1', status: 'running' }],
      hooks: { s1: hook('end', NOW - SEC) },
    });
    expect(ended.agents).toHaveLength(1);
    expect(ended.agents[0]!.state).toBe('working');
  });

  it('does not add a second agent for a session Paseo owns that no transcript shows', () => {
    const roster = build({
      paseo: [{ id: 'a1', provider: 'claude', sessionId: 's1', status: 'idle' }],
      hooks: { s1: hook('permission', NOW - SEC) },
    });
    expect(roster.agents).toHaveLength(1);
    expect(roster.agents[0]!.seenBy).toEqual({ paseo: true, transcript: false });
  });
});

describe('hostile or odd input', () => {
  it('a hook time outside the window HQ keeps is left out and counted as repaired; one bad record never fails the answer', () => {
    const roster = build({
      transcripts: [transcript()],
      hooks: { s1: hook('permission', Number.NaN), s2: hook('permission', NOW - SEC) },
    });
    expect(roster.repaired).toBeGreaterThan(0);
    expect(roster.agents.map((a) => a.state).sort()).toEqual(['waiting', 'working']);
  });

  it('shows at most the cap, like any other agent', () => {
    const hooks = Object.fromEntries(
      Array.from({ length: 80 }, (_, i) => [`s${i}`, hook('permission', NOW - i * 10)] as const),
    );
    const roster = build({ hooks });
    expect(roster.agents).toHaveLength(60);
    expect(roster.truncated).toBe(true);
  });
});

// ---- Precedence, every ordering ---------------------------------------------------------------------------------------------------
// data-and-sources › Claude Code hooks › Precedence. Each row is a session at NOW with what each source last said and when; the row
// names what the roster shows. `t` is how long before NOW. A transcript's own reading is `working` (a tool call in flight) unless the row says.

describe('precedence: every ordering of the sources', () => {
  type Shows = { state: string; confidence: string; waitReason?: string | null } | 'absent';
  const rows: {
    name: string;
    transcript?: Partial<TranscriptAgent> | null;
    hook?: HookRecord;
    paseo?: 'running' | 'idle';
    shows: Shows;
  }[] = [
    {
      name: 'a permission request, no later line: the hook waits (reported)',
      transcript: { lastActivityAt: NOW - 60 * SEC },
      hook: hook('permission', NOW - 10 * SEC),
      shows: { state: 'waiting', confidence: 'reported', waitReason: 'permission' },
    },
    {
      name: 'a permission request, then a later transcript line: the transcript wins',
      transcript: { lastActivityAt: NOW - 5 * SEC },
      hook: hook('permission', NOW - 10 * SEC),
      shows: { state: 'working', confidence: 'inferred' },
    },
    {
      name: 'a permission request and a transcript line at the same instant: the hook speaks',
      transcript: { lastActivityAt: NOW - 10 * SEC },
      hook: hook('permission', NOW - 10 * SEC),
      shows: { state: 'waiting', confidence: 'reported' },
    },
    {
      name: 'a stop, then a later transcript line (a new prompt): the transcript wins',
      transcript: { lastActivityAt: NOW - 5 * SEC },
      hook: hook('stop', NOW - 10 * SEC),
      shows: { state: 'working', confidence: 'inferred' },
    },
    {
      name: 'an idle prompt, then a later transcript line: the transcript wins',
      transcript: { lastActivityAt: NOW - 5 * SEC },
      hook: hook('idle', NOW - 10 * SEC),
      shows: { state: 'working', confidence: 'inferred' },
    },
    {
      name: 'a stop after the last line: finished (reported)',
      transcript: { lastActivityAt: NOW - 30 * SEC },
      hook: hook('stop', NOW - 10 * SEC),
      shows: { state: 'finished', confidence: 'reported' },
    },
    {
      name: 'a session end after the last line: gone',
      transcript: { lastActivityAt: NOW - 30 * SEC },
      hook: hook('end', NOW - 10 * SEC),
      shows: 'absent',
    },
    {
      name: 'a session end, then a later line (the same id used again): back, as the transcript reads it',
      transcript: { lastActivityAt: NOW - 5 * SEC },
      hook: hook('end', NOW - 10 * SEC),
      shows: { state: 'working', confidence: 'inferred' },
    },
    {
      name: 'a session end with no transcript: gone',
      transcript: null,
      hook: hook('end', NOW - 10 * SEC),
      shows: 'absent',
    },
    {
      name: 'Paseo owns the session: Paseo’s state, whatever the hook says (permission)',
      transcript: { lastActivityAt: NOW - 60 * SEC },
      hook: hook('permission', NOW - 10 * SEC),
      paseo: 'idle',
      shows: { state: 'idle', confidence: 'reported' },
    },
    {
      name: 'Paseo owns the session: a session end does not remove it',
      transcript: { lastActivityAt: NOW - 60 * SEC },
      hook: hook('end', NOW - 10 * SEC),
      paseo: 'running',
      shows: { state: 'working', confidence: 'reported' },
    },
    {
      name: 'the event is gone (expired): the transcript’s own reading stands, inferred',
      transcript: { lastActivityAt: NOW - 60 * SEC },
      shows: { state: 'working', confidence: 'inferred' },
    },
    {
      name: 'the hooks alone (the transcript feed is stopped): a permission wait shows',
      transcript: null,
      hook: hook('permission', NOW - 10 * SEC),
      shows: { state: 'waiting', confidence: 'reported' },
    },
    {
      name: 'the hooks alone: a start shows as starting',
      transcript: null,
      hook: hook('start', NOW - 10 * SEC),
      shows: { state: 'starting', confidence: 'reported' },
    },
    {
      name: 'the hooks alone: an idle prompt shows the session as idle',
      transcript: null,
      hook: hook('idle', NOW - 10 * SEC),
      shows: { state: 'idle', confidence: 'reported' },
    },
  ];

  it.each(rows)('$name', ({ transcript: over, hook: record, paseo, shows }) => {
    const roster = build({
      transcripts: over === null ? [] : [transcript(over)],
      ...(record === undefined ? {} : { hooks: { s1: record } }),
      ...(paseo === undefined
        ? {}
        : { paseo: [{ id: 'a1', provider: 'claude', sessionId: 's1', status: paseo }] }),
    });
    if (shows === 'absent') {
      expect(roster.agents).toEqual([]);
      return;
    }
    expect(roster.agents).toHaveLength(1);
    expect(roster.agents[0]).toMatchObject(shows);
  });

  it('a later hook event wins over an earlier one, whatever they were (the store keeps only the latest)', () => {
    const kinds = [
      ['PermissionRequest', 'permission'],
      ['Stop', 'stop'],
      ['SessionStart', 'start'],
    ] as const;
    for (const [first] of kinds)
      for (const [second, kind] of kinds) {
        const clock = { now: NOW - 30 * SEC };
        const store = createHookStore({ now: () => clock.now });
        store.record({ hook_event_name: first, session_id: 's1' });
        clock.now = NOW - 10 * SEC;
        store.record({ hook_event_name: second, session_id: 's1' });
        expect(store.read().get('s1')?.kind).toBe(kind);
        const agent = only(
          buildRoster({
            agents: [],
            transcripts: [transcript({ lastActivityAt: NOW - 60 * SEC })],
            hooks: store.read(),
            now: NOW,
          }),
        );
        expect(agent.state).toBe(
          kind === 'permission' ? 'waiting' : kind === 'stop' ? 'finished' : 'working',
        );
      }
  });

  it('a permission wait, then an idle prompt, then a session end, each replaces the one before', () => {
    const clock = { now: NOW - 40 * SEC };
    const store = createHookStore({ now: () => clock.now });
    const show = () =>
      buildRoster({
        agents: [],
        transcripts: [transcript({ lastActivityAt: NOW - 60 * SEC })],
        hooks: store.read(),
        now: NOW,
      }).agents;
    store.record({ hook_event_name: 'PermissionRequest', session_id: 's1' });
    expect(show()[0]?.state).toBe('waiting');
    clock.now = NOW - 30 * SEC;
    store.record({
      hook_event_name: 'Notification',
      session_id: 's1',
      notification_type: 'idle_prompt',
    });
    expect(show()[0]?.state).toBe('idle');
    clock.now = NOW - 20 * SEC;
    store.record({ hook_event_name: 'SessionEnd', session_id: 's1' });
    expect(show()).toEqual([]);
  });

  it('after the event expires (15 minutes) the hook is gone and the transcript’s own reading stands', () => {
    const clock = { now: NOW - 5 * SEC };
    const store = createHookStore({ now: () => clock.now });
    store.record({ hook_event_name: 'PermissionRequest', session_id: 's1' });
    const at = (now: number) =>
      buildRoster({
        agents: [],
        transcripts: [transcript({ lastActivityAt: NOW - 60 * SEC })],
        hooks: store.read(),
        now,
      }).agents[0];
    clock.now = NOW;
    expect(at(NOW)).toMatchObject({ state: 'waiting', confidence: 'reported' });
    clock.now = NOW - 5 * SEC + HOOK_KEEP_MS;
    expect(at(clock.now)).toMatchObject({ state: 'working', confidence: 'inferred' });
  });

  it('starts empty after an app restart: a new store holds nothing, so the transcript alone is read', () => {
    const before = createHookStore({ now: () => NOW });
    before.record({ hook_event_name: 'PermissionRequest', session_id: 's1' });
    const after = createHookStore({ now: () => NOW });
    expect(after.read().size).toBe(0);
    expect(after.delivered('s1')).toBe(false);
    const agent = only(
      buildRoster({ agents: [], transcripts: [transcript()], hooks: after.read(), now: NOW }),
    );
    expect(agent).toMatchObject({ state: 'working', confidence: 'inferred' });
  });
});

describe('a transcript line dated in the future', () => {
  it('within the skew still counts as later than a hook event before it', () => {
    const agent = only(
      build({
        transcripts: [transcript({ lastActivityAt: NOW + HOOK_FUTURE_SKEW_MS })],
        hooks: { s1: hook('permission', NOW - 5 * SEC) },
      }),
    );
    expect(agent).toMatchObject({ state: 'working', confidence: 'inferred' });
  });

  it('beyond the skew (an hour ahead) does not hide a hook permission event, now or later', () => {
    const future = transcript({ lastActivityAt: NOW + 60 * 60_000, state: 'working' });
    for (const now of [NOW, NOW + 30 * SEC, NOW + 10 * 60_000]) {
      const agent = only(
        build({ now, transcripts: [future], hooks: { s1: hook('permission', now - 5 * SEC) } }),
      );
      expect(agent).toMatchObject({ state: 'waiting', waitReason: 'permission' });
      // The time shown is never the impossible one the transcript named.
      expect(Date.parse(agent.lastActivityAt)).toBeLessThanOrEqual(now);
    }
  });

  it('beyond the skew, a session end and a stop still speak too', () => {
    const future = transcript({ lastActivityAt: NOW + 60 * 60_000 });
    expect(build({ transcripts: [future], hooks: { s1: hook('end', NOW - SEC) } }).agents).toEqual(
      [],
    );
    expect(
      only(build({ transcripts: [future], hooks: { s1: hook('stop', NOW - SEC) } })).state,
    ).toBe('finished');
  });
});

describe('a hook event for a session id never reaches another provider’s or owner’s entity', () => {
  it('a Codex session, a Paseo-owned Codex session and a Paseo agent whose own id is the session id are untouched', () => {
    const hooks = { s1: hook('permission', NOW - SEC) };
    // The hook is for the CLAUDE session s1 (not read yet): it shows as its own entry, and the Codex session is as its transcript reads.
    const codex = build({
      transcripts: [transcript({ provider: 'codex', sessionId: 's1' })],
      hooks,
    });
    expect(codex.agents.filter((a) => a.provider === 'codex')).toHaveLength(1);
    expect(codex.agents.find((a) => a.provider === 'codex')).toMatchObject({
      state: 'working',
      confidence: 'inferred',
    });
    expect(codex.agents.find((a) => a.provider === 'claude')).toMatchObject({
      state: 'waiting',
      seenBy: { paseo: false, transcript: false },
    });

    const paseoCodex = build({
      paseo: [{ id: 'a1', provider: 'codex', sessionId: 's1', status: 'running' }],
      transcripts: [transcript({ provider: 'codex', sessionId: 's1' })],
      hooks,
    });
    expect(paseoCodex.agents.find((a) => a.seenBy.paseo)).toMatchObject({
      provider: 'codex',
      state: 'working',
      confidence: 'reported',
    });

    const sameAsAgentId = build({
      paseo: [{ id: 's1', provider: 'claude', sessionId: 'another', status: 'running' }],
      hooks,
    });
    // The hook's session shows as its own (unowned) session beside Paseo's agent; Paseo's agent keeps Paseo's state.
    const paseoOne = sameAsAgentId.agents.find((a) => a.seenBy.paseo);
    expect(paseoOne).toMatchObject({ state: 'working', confidence: 'reported' });
    expect(sameAsAgentId.agents.filter((a) => !a.seenBy.paseo)).toHaveLength(1);
  });

  it('a hook for a session id does not end or change a Codex session of that id', () => {
    const roster = build({
      transcripts: [transcript({ provider: 'codex', sessionId: 's1' })],
      hooks: { s1: hook('end', NOW - SEC) },
    });
    expect(roster.agents).toHaveLength(1);
    expect(roster.agents[0]).toMatchObject({ provider: 'codex', state: 'working' });
  });

  it('a hook whose id equals a subagent’s own session id does not speak for the subagent', () => {
    const roster = build({
      transcripts: [
        transcript({ sessionId: 's1' }),
        transcript({ sessionId: 's1:agent-a', parentSessionId: 's1' }),
      ],
      hooks: { 's1:agent-a': hook('permission', NOW - SEC) },
    });
    expect(roster.agents.find((a) => a.parentId !== null)?.state).toBe('working');
    expect(roster.agents.find((a) => a.parentId === null)?.state).toBe('working');
    expect(roster.agents).toHaveLength(2);
  });
});

// The documented table (data-and-sources › Claude Code hooks › What the events mean for the roster): every event against every
// combination of sources, and what happens when the hook store forgets an event.
describe('the event table: every event in every combination of sources', () => {
  type Kind = HookRecord['kind'];
  const KINDS: Kind[] = ['permission', 'idle', 'stop', 'start', 'end'];
  const paseoAgent = { id: 'a1', provider: 'claude', sessionId: 's1', status: 'running' } as const;
  const quiet = (over: Partial<TranscriptAgent> = {}) =>
    transcript({ state: 'working', lastActivityAt: NOW - 3_000 * SEC, ...over });
  /** A hook event that arrived `ago` seconds ago, for a session in the given sources. */
  const roster = (
    kind: Kind | null,
    ago: number,
    sources: 'hook' | 'transcript' | 'paseo' | 'all',
  ) =>
    build({
      ...(sources === 'paseo' || sources === 'all' ? { paseo: [paseoAgent] } : {}),
      ...(sources === 'transcript' || sources === 'all' ? { transcripts: [quiet()] } : {}),
      ...(kind === null
        ? {}
        : { hooks: { s1: hook(kind, NOW - ago * SEC, '/work/invented/widgets') } }),
    });

  it('hook only: permission and idle speak, a stop is finished then idle, a start is shown briefly, an end shows nothing', () => {
    expect(only(roster('permission', 5, 'hook'))).toMatchObject({
      state: 'waiting',
      waitReason: 'permission',
      confidence: 'reported',
      title: null,
      workspace: 'widgets',
      seenBy: { paseo: false, transcript: false },
    });
    expect(only(roster('idle', 5, 'hook'))).toMatchObject({
      state: 'idle',
      confidence: 'reported',
      title: null,
      workspace: 'widgets',
    });
    // An idle prompt stays until the hook store forgets it, however long ago.
    expect(only(roster('idle', 14 * 60, 'hook')).state).toBe('idle');
    expect(only(roster('stop', 10, 'hook')).state).toBe('finished');
    expect(only(roster('stop', 100, 'hook'))).toMatchObject({
      state: 'idle',
      since: new Date(NOW - 100 * SEC + FINISHED_VISIBLE_MS).toISOString(),
    });
    expect(only(roster('stop', 14 * 60, 'hook')).state).toBe('idle');
    expect(only(roster('start', 5, 'hook')).state).toBe('starting');
    expect(roster('start', HOOK_START_VISIBLE_MS / SEC + 1, 'hook').agents).toEqual([]);
    expect(roster('end', 5, 'hook').agents).toEqual([]);
  });

  it('hook and transcript: the event speaks while it is not older than the transcript’s last line; a start never does', () => {
    expect(only(roster('permission', 5, 'transcript'))).toMatchObject({
      state: 'waiting',
      confidence: 'reported',
      seenBy: { paseo: false, transcript: true },
    });
    expect(only(roster('idle', 5, 'transcript'))).toMatchObject({
      state: 'idle',
      confidence: 'reported',
    });
    expect(only(roster('stop', 10, 'transcript')).state).toBe('finished');
    expect(only(roster('stop', 100, 'transcript')).state).toBe('idle');
    expect(only(roster('start', 5, 'transcript'))).toMatchObject({
      state: 'working',
      confidence: 'inferred',
    });
    expect(roster('end', 5, 'transcript').agents).toEqual([]);
  });

  it('hook and Paseo, and all three: Paseo’s reported state stands and no hook event is read, for every event', () => {
    for (const sources of ['paseo', 'all'] as const) {
      const baseline = roster(null, 0, sources);
      expect(baseline.agents).toHaveLength(1);
      for (const kind of KINDS) {
        const withHook = roster(kind, 5, sources);
        expect(withHook.agents, `${sources} ${kind}`).toEqual(baseline.agents);
        expect(withHook.agents[0]).toMatchObject({ state: 'working', confidence: 'reported' });
      }
    }
  });

  it('when the hook store forgets the event (no event for 15 minutes) a hook-only row goes, and a transcript speaks alone', () => {
    const clock = { now: NOW };
    const store = createHookStore({ now: () => clock.now });
    for (const [name, notification] of [
      ['Notification', 'idle_prompt'],
      ['Stop', undefined],
      ['PermissionRequest', undefined],
    ] as const) {
      store.record({
        hook_event_name: name,
        session_id: 's1',
        ...(notification === undefined ? {} : { notification_type: notification }),
      });
      const at = (offset: number, transcripts: TranscriptAgent[] = []) => {
        clock.now = NOW + offset;
        return buildRoster({
          agents: [],
          transcripts,
          hooks: store.read(),
          now: clock.now,
        }).agents;
      };
      expect(at(HOOK_KEEP_MS - SEC), name).toHaveLength(1);
      expect(at(HOOK_KEEP_MS), name).toEqual([]);
      expect(
        at(HOOK_KEEP_MS, [quiet({ lastActivityAt: NOW + HOOK_KEEP_MS - 5 * SEC })])[0],
      ).toMatchObject({
        state: 'working',
        confidence: 'inferred',
      });
      clock.now = NOW;
    }
  });

  it('a session end after an idle prompt takes the hook-only row away at once', () => {
    const clock = { now: NOW };
    const store = createHookStore({ now: () => clock.now });
    store.record({
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
      session_id: 's1',
    });
    expect(buildRoster({ agents: [], hooks: store.read(), now: NOW }).agents).toHaveLength(1);
    store.record({ hook_event_name: 'SessionEnd', session_id: 's1' });
    expect(buildRoster({ agents: [], hooks: store.read(), now: NOW }).agents).toEqual([]);
  });
});
