import { describe, expect, it } from 'vitest';
import type { TranscriptAgent } from '../../../src/server/collectors/live/feed.ts';
import type { LiveAgent } from '../../../src/server/collectors/paseo/liveAgent.ts';
import {
  ROSTER_CAP,
  buildRoster,
  createKeyMemo,
  keyId,
  rosterId,
  type KeyMemo,
} from '../../../src/server/services/hq/roster.ts';
import { liveSessionKey } from '../../../src/server/db/queries/hq.ts';
import { HqAgent } from '../../../src/shared/contracts/hq.ts';
import { NOW, liveAgent } from '../../collectors/paseo/liveHelpers.ts';

// The roster with transcript sessions in it: the join with Paseo's agents, who is whose parent, which state wins, ids that do not change,
// the order and the cap, and the stored labels. Pure: no feed, no folder, no database.

const MIN = 60_000;

const transcript = (over: Partial<TranscriptAgent> & { sessionId: string }): TranscriptAgent => ({
  provider: 'claude',
  parentSessionId: null,
  cwd: '/work/invented/project',
  startedAt: null,
  state: 'working',
  activity: 'editing',
  waitReason: null,
  since: NOW - 2 * MIN,
  lastActivityAt: NOW - 5_000,
  ...over,
});

const build = (input: {
  paseo?: Parameters<typeof liveAgent>[0][];
  transcripts?: TranscriptAgent[];
  claudeParents?: Parameters<typeof buildRoster>[0]['claudeParents'];
  hooks?: Parameters<typeof buildRoster>[0]['hooks'];
  memo?: KeyMemo;
  labelsOf?: Parameters<typeof buildRoster>[0]['labelsOf'];
  now?: number;
}) =>
  buildRoster({
    agents: (input.paseo ?? []).map(liveAgent),
    transcripts: input.transcripts ?? [],
    claudeParents: input.claudeParents,
    hooks: input.hooks,
    now: input.now ?? NOW,
    memo: input.memo,
    labelsOf: input.labelsOf,
  });

describe('a transcript-only agent', () => {
  it('is shown, inferred, with the activity the transcript says, and seen by the transcript alone', () => {
    const roster = build({
      transcripts: [
        transcript({ sessionId: 's1', startedAt: NOW - 30 * MIN, cwd: '/work/invented/widgets' }),
      ],
    });
    expect(roster.agents).toHaveLength(1);
    const [agent] = roster.agents;
    expect(HqAgent.parse(agent)).toEqual({
      id: keyId('claude:s1'),
      provider: 'claude',
      kind: 'root',
      parentId: null,
      parentBasis: null,
      parentAway: false,
      title: null,
      repo: null,
      workspace: 'widgets',
      state: 'working',
      activity: 'editing',
      waitReason: null,
      confidence: 'inferred',
      since: new Date(NOW - 2 * MIN).toISOString(),
      lastActivityAt: new Date(NOW - 5_000).toISOString(),
      startedAt: new Date(NOW - 30 * MIN).toISOString(),
      seenBy: { paseo: false, transcript: true },
    });
  });

  it('shows no activity for a state that is not working, and keeps an inferred wait inferred', () => {
    const [agent] = build({
      transcripts: [
        transcript({
          sessionId: 's1',
          provider: 'codex',
          state: 'waiting',
          activity: 'none',
          waitReason: 'permission',
        }),
      ],
    }).agents;
    expect(agent).toMatchObject({
      provider: 'codex',
      state: 'waiting',
      activity: 'none',
      waitReason: 'permission',
      confidence: 'inferred',
    });
  });

  it('takes the repo from the working directory with the lookup, and the title from a stored label when the session is known', () => {
    const labels = new Map([
      [
        liveSessionKey('claude', 'known'),
        { title: 'A stored name', repo: 'acme/stored', workspace: 'stored ws' },
      ],
    ]);
    const roster = build({
      transcripts: [
        transcript({ sessionId: 'known' }),
        transcript({ sessionId: 'new', cwd: '/work/invented/other' }),
      ],
      labelsOf: () => labels,
    });
    const byKey = (key: string) =>
      roster.agents.find((agent) => agent.id === keyId(`claude:${key}`));
    expect(byKey('known')).toMatchObject({ title: 'A stored name', repo: 'acme/stored' });
    expect(byKey('new')).toMatchObject({ title: null, repo: null, workspace: 'other' });
  });

  it('asks for labels once, by session keys, and not at all when nothing has a session id', () => {
    const asked: unknown[] = [];
    build({
      transcripts: [
        transcript({ sessionId: 's1' }),
        transcript({ sessionId: 's2', provider: 'codex' }),
      ],
      paseo: [{ id: 'p', status: 'running', provider: 'claude', sessionId: 'c1' }],
      labelsOf: (keys) => {
        asked.push(keys);
        return new Map();
      },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toEqual(
      expect.arrayContaining([
        { provider: 'claude', sessionId: 's1' },
        { provider: 'codex', sessionId: 's2' },
        { provider: 'claude', sessionId: 'c1' },
      ]),
    );
    const none: unknown[] = [];
    build({
      paseo: [{ id: 'p', status: 'running' }],
      labelsOf: (keys) => (none.push(keys), new Map()),
    });
    expect(none).toEqual([]);
  });
});

describe('the join with Paseo', () => {
  const paseoClaude = {
    id: 'p1',
    provider: 'claude',
    sessionId: 'S',
    status: 'running',
    title: 'From Paseo',
    updatedAt: NOW - 3_000,
  };

  it('one agent seen by both is one roster entry with seenBy both', () => {
    const roster = build({
      paseo: [paseoClaude],
      transcripts: [transcript({ sessionId: 'S', lastActivityAt: NOW - 1_000 })],
    });
    expect(roster.agents).toHaveLength(1);
    expect(roster.agents[0]).toMatchObject({
      id: keyId('claude:S'),
      title: 'From Paseo',
      seenBy: { paseo: true, transcript: true },
    });
  });

  it('joins only within a provider: the same id under another provider is another agent', () => {
    const roster = build({
      paseo: [paseoClaude],
      transcripts: [transcript({ sessionId: 'S', provider: 'codex' })],
    });
    expect(roster.agents).toHaveLength(2);
  });

  it('does not join an agent whose Paseo provider is neither Claude nor Codex', () => {
    const roster = build({
      paseo: [{ id: 'p1', provider: 'opencode', sessionId: 'S', status: 'running' }],
      transcripts: [transcript({ sessionId: 'S' })],
    });
    expect(roster.agents).toHaveLength(2);
  });

  it('a Paseo agent with no session id yet is not joined, and a session can be joined by only one Paseo agent', () => {
    const roster = build({
      paseo: [
        { id: 'p0', provider: 'claude', sessionId: null, status: 'running' },
        { id: 'p1', provider: 'claude', sessionId: 'S', status: 'running' },
        { id: 'p2', provider: 'claude', sessionId: 'S', status: 'running' },
      ],
      transcripts: [transcript({ sessionId: 'S' })],
    });
    expect(roster.agents).toHaveLength(3);
    expect(roster.agents.filter((agent) => agent.seenBy.transcript)).toHaveLength(1);
  });

  it('a Paseo agent Paseo itself does not show (idle for long) does not claim the transcript', () => {
    const roster = build({
      paseo: [
        {
          id: 'p1',
          provider: 'claude',
          sessionId: 'S',
          status: 'idle',
          updatedAt: NOW - 2 * 60 * MIN,
        },
      ],
      transcripts: [transcript({ sessionId: 'S' })],
    });
    expect(roster.agents).toHaveLength(1);
    expect(roster.agents[0]).toMatchObject({
      seenBy: { paseo: false, transcript: true },
      confidence: 'inferred',
    });
  });
});

describe('which state wins', () => {
  const joined = (paseo: Partial<LiveAgent>, transcriptOver: Partial<TranscriptAgent> = {}) =>
    build({
      paseo: [{ id: 'p1', provider: 'claude', sessionId: 'S', ...paseo }],
      transcripts: [transcript({ sessionId: 'S', ...transcriptOver })],
    }).agents[0];

  it('Paseo running: the state stays Paseo’s (reported) and the transcript supplies the activity', () => {
    expect(joined({ status: 'running', turnStartedAt: NOW - MIN })).toMatchObject({
      state: 'working',
      activity: 'editing',
      confidence: 'reported',
      since: new Date(NOW - MIN).toISOString(),
    });
  });

  it('Paseo running while the transcript says it is not working: no activity is invented', () => {
    expect(joined({ status: 'running' }, { state: 'finished', activity: 'none' })).toMatchObject({
      state: 'working',
      activity: 'none',
      confidence: 'reported',
    });
    // An inferred wait in the transcript does not turn a running Paseo agent into a waiting one.
    expect(
      joined(
        { status: 'running' },
        { state: 'waiting', activity: 'none', waitReason: 'permission' },
      ),
    ).toMatchObject({ state: 'working', activity: 'none', waitReason: null });
  });

  it.each([
    [
      'a reported wait',
      { pendingPermissionKind: 'plan' },
      { state: 'waiting', waitReason: 'plan_approval' },
    ],
    ['an error', { status: 'error' }, { state: 'error' }],
    ['starting', { status: 'initializing' }, { state: 'starting' }],
    ['closed', { status: 'closed', updatedAt: NOW - 10_000 }, { state: 'finished' }],
    ['idle', { status: 'idle' }, { state: 'idle' }],
  ])(
    'Paseo says %s: Paseo wins, and the transcript’s activity is not used',
    (_name, paseo, expected) => {
      expect(joined(paseo)).toMatchObject({
        ...expected,
        activity: 'none',
        confidence: 'reported',
      });
    },
  );

  it('the last activity is the later of the two, and the start Paseo’s when it has one', () => {
    expect(
      joined(
        { status: 'running', updatedAt: NOW - 20_000, createdAt: NOW - 50 * MIN },
        { lastActivityAt: NOW - 1_000, startedAt: NOW - 10 * MIN },
      ),
    ).toMatchObject({
      lastActivityAt: new Date(NOW - 1_000).toISOString(),
      startedAt: new Date(NOW - 50 * MIN).toISOString(),
    });
    expect(
      joined({ status: 'running', createdAt: null }, { startedAt: NOW - 10 * MIN }),
    ).toMatchObject({
      startedAt: new Date(NOW - 10 * MIN).toISOString(),
    });
  });
});

describe('parents', () => {
  it('keeps an expired Paseo parent for a native child without taking ownership from an active transcript', () => {
    const memo = createKeyMemo();
    const child = transcript({ sessionId: 'helper', parentSessionId: 'main' });
    const parent = {
      id: 'parent',
      provider: 'claude',
      sessionId: 'main',
      updatedAt: NOW - 31 * MIN,
    };
    const withContext = build({ paseo: [parent], transcripts: [child], memo });
    const parentId = keyId('claude:main');
    expect(withContext.agents).toHaveLength(2);
    expect(withContext.agents[0]).toMatchObject({ parentId, parentBasis: 'native' });

    const withActivity = build({
      paseo: [parent],
      transcripts: [child, transcript({ sessionId: 'main' })],
      memo,
    });
    expect(withActivity.agents).toHaveLength(2);
    expect(withActivity.agents.find((agent) => agent.id === parentId)?.seenBy).toEqual({
      paseo: false,
      transcript: true,
    });
    expect(withActivity.agents.find((agent) => agent.id === keyId('claude:helper'))?.parentId).toBe(
      parentId,
    );
  });

  it('retains the exact expired Paseo parent while preserving a native parent on the active transcript', () => {
    const memo = createKeyMemo();
    const parent = { id: 'parent', title: 'Paseo parent', provider: 'claude', sessionId: 'main' };
    const nativeChild = transcript({ sessionId: 'native-child', parentSessionId: 'main' });
    const labeledChild = { id: 'paseo-child', status: 'running', parentAgentId: parent.id };
    build({ paseo: [parent, labeledChild], transcripts: [nativeChild], memo });
    const roster = build({
      paseo: [{ ...parent, updatedAt: NOW - 31 * MIN }, labeledChild],
      transcripts: [nativeChild, transcript({ sessionId: 'main' })],
      memo,
    });
    const providerOwner = roster.agents.find((agent) => agent.id === keyId('claude:main'))!;
    const paseoParent = roster.agents.find((agent) => agent.title === parent.title)!;
    expect(providerOwner.seenBy).toEqual({ paseo: false, transcript: true });
    expect(paseoParent.id).not.toBe(providerOwner.id);
    expect(roster.agents.find((agent) => agent.id === keyId('claude:native-child'))?.parentId).toBe(
      providerOwner.id,
    );
    expect(roster.agents.find((agent) => agent.id === rosterId(labeledChild.id))?.parentId).toBe(
      paseoParent.id,
    );
  });

  it('a Claude subagent is a native child of its session', () => {
    const roster = build({
      transcripts: [
        transcript({ sessionId: 'main' }),
        transcript({ sessionId: 'main:agent-1', parentSessionId: 'main', state: 'working' }),
      ],
    });
    const child = roster.agents.find((agent) => agent.id === keyId('claude:main:agent-1'));
    expect(child).toMatchObject({
      kind: 'child',
      parentId: keyId('claude:main'),
      parentBasis: 'native',
      parentAway: false,
    });
  });

  it('a Codex thread is a native child of the thread that spawned it, and away when that one is not on the roster', () => {
    const roster = build({
      transcripts: [transcript({ sessionId: 'kid', provider: 'codex', parentSessionId: 'gone' })],
    });
    expect(roster.agents[0]).toMatchObject({
      kind: 'child',
      parentId: null,
      parentBasis: 'native',
      parentAway: true,
    });
  });

  it('the native parent of a joined agent resolves to the roster id the parent already has', () => {
    const roster = build({
      paseo: [{ id: 'pp', provider: 'claude', sessionId: 'main', status: 'running' }],
      transcripts: [
        transcript({ sessionId: 'main' }),
        transcript({ sessionId: 'main:agent-1', parentSessionId: 'main' }),
      ],
    });
    expect(roster.agents).toHaveLength(2);
    const child = roster.agents.find((agent) => agent.seenBy.paseo === false);
    expect(child).toMatchObject({ parentId: keyId('claude:main'), parentBasis: 'native' });
  });

  it('Paseo fills a gap: a transcript with no native parent takes the label’s parent, basis paseo', () => {
    const roster = build({
      paseo: [
        { id: 'boss', provider: 'claude', sessionId: 'boss-s', status: 'running' },
        {
          id: 'worker',
          provider: 'claude',
          sessionId: 'w-s',
          status: 'running',
          parentAgentId: 'boss',
        },
      ],
      transcripts: [transcript({ sessionId: 'w-s' }), transcript({ sessionId: 'boss-s' })],
    });
    const worker = roster.agents.find((agent) => agent.id === keyId('claude:w-s'));
    expect(worker).toMatchObject({
      kind: 'child',
      parentId: keyId('claude:boss-s'),
      parentBasis: 'paseo',
    });
  });

  it('native wins over Paseo: when the provider names a parent, Paseo’s label is not used, even if the native parent is away', () => {
    const roster = build({
      paseo: [
        { id: 'other', provider: 'claude', sessionId: 'o-s', status: 'running' },
        {
          id: 'worker',
          provider: 'codex',
          sessionId: 'w-s',
          status: 'running',
          parentAgentId: 'other',
        },
      ],
      transcripts: [
        transcript({ sessionId: 'w-s', provider: 'codex', parentSessionId: 'nowhere' }),
      ],
    });
    const worker = roster.agents.find((agent) => agent.id === keyId('codex:w-s'));
    expect(worker).toMatchObject({
      kind: 'child',
      parentId: null,
      parentBasis: 'native',
      parentAway: true,
    });
  });

  it('never invents an edge: a root session with no claim has no parent', () => {
    const roster = build({
      transcripts: [transcript({ sessionId: 'a' }), transcript({ sessionId: 'b' })],
    });
    for (const agent of roster.agents)
      expect(agent).toMatchObject({
        kind: 'root',
        parentId: null,
        parentBasis: null,
        parentAway: false,
      });
  });

  it('marks a native parent as away when the cap keeps only a different claimant', () => {
    const roster = build({
      paseo: [
        { id: 'parent', provider: 'claude', sessionId: 'main', status: 'idle', updatedAt: NOW },
        {
          id: 'claimant',
          provider: 'claude',
          sessionId: 'main',
          status: 'running',
          updatedAt: NOW - 1_000,
        },
      ],
      transcripts: [
        transcript({ sessionId: 'main', state: 'idle' }),
        transcript({ sessionId: 'main:helper', parentSessionId: 'main' }),
        ...Array.from({ length: ROSTER_CAP - 2 }, (_, i) =>
          transcript({ sessionId: `filler-${i}` }),
        ),
      ],
    });

    expect(roster.truncated).toBe(true);
    expect(roster.agents).toHaveLength(ROSTER_CAP);
    const child = roster.agents.find((agent) => agent.id === keyId('claude:main:helper'));
    expect(child).toMatchObject({
      kind: 'child',
      parentBasis: 'native',
      parentAway: true,
      parentId: null,
    });
  });

  it('refuses a native cycle, and a session that names itself', () => {
    const roster = build({
      transcripts: [
        transcript({ sessionId: 'a', parentSessionId: 'b' }),
        transcript({ sessionId: 'b', parentSessionId: 'a' }),
        transcript({ sessionId: 'c', parentSessionId: 'c' }),
        transcript({ sessionId: 'd', parentSessionId: 'a' }),
      ],
    });
    expect(roster.agents).toHaveLength(4);
    for (const agent of roster.agents) {
      expect(agent).toMatchObject({
        kind: 'root',
        parentId: null,
        parentBasis: null,
        parentAway: false,
      });
    }
  });

  it('refuses a loop made of a native edge and a Paseo one', () => {
    const roster = build({
      paseo: [
        { id: 'a', provider: 'claude', sessionId: 'a-s', status: 'running', parentAgentId: 'b' },
        { id: 'b', provider: 'claude', sessionId: 'b-s', status: 'running' },
      ],
      transcripts: [transcript({ sessionId: 'b-s', parentSessionId: 'a-s' })],
    });
    expect(roster.agents.every((agent) => agent.parentId === null)).toBe(true);
  });
});

describe('an aged-out Claude parent', () => {
  const parent = {
    sessionId: 'main',
    cwd: '/work/invented/parent-project',
    lastActivityAt: NOW - 35 * MIN,
  };
  const child = transcript({ sessionId: 'main:helper', parentSessionId: parent.sessionId });
  const parentId = keyId('claude:main');
  const childId = keyId('claude:main:helper');

  it('provides idle context for an actionable child and keeps its identity when it resumes', () => {
    const memo = createKeyMemo();
    const contextual = build({
      transcripts: [child],
      claudeParents: [parent, parent],
      memo,
    });
    expect(contextual.agents).toHaveLength(2);
    expect(contextual.agents.find((agent) => agent.id === parentId)).toMatchObject({
      provider: 'claude',
      kind: 'root',
      state: 'idle',
      activity: 'none',
      waitReason: null,
      confidence: 'inferred',
      workspace: 'parent-project',
      lastActivityAt: new Date(parent.lastActivityAt).toISOString(),
      seenBy: { paseo: false, transcript: true },
    });
    expect(contextual.agents.find((agent) => agent.id === childId)).toMatchObject({
      kind: 'child',
      parentId,
      parentBasis: 'native',
      parentAway: false,
    });

    const resumed = build({
      transcripts: [child, transcript({ sessionId: parent.sessionId })],
      claudeParents: [parent],
      memo,
    });
    expect(resumed.agents).toHaveLength(2);
    expect(resumed.agents.find((agent) => agent.id === parentId)).toMatchObject({
      state: 'working',
      activity: 'editing',
      workspace: 'project',
    });
    expect(resumed.agents.find((agent) => agent.id === childId)?.parentId).toBe(parentId);
  });

  it('drops the context once the child is idle or gone', () => {
    const claudeParents = [parent];
    const memo = createKeyMemo();
    expect(build({ transcripts: [child], claudeParents, memo }).agents).toHaveLength(2);
    const idle = build({
      transcripts: [{ ...child, state: 'idle', activity: 'none' }],
      claudeParents,
      memo,
    });
    expect(idle.agents).toHaveLength(1);
    expect(idle.agents[0]).toMatchObject({ id: childId, parentId: null, parentAway: true });
    expect(build({ claudeParents, memo }).agents).toEqual([]);
  });

  it('honors SessionEnd unless a subsequent parent transcript line clears it', () => {
    const at = parent.lastActivityAt;
    const ended = build({
      transcripts: [child],
      claudeParents: [parent],
      hooks: new Map([[parent.sessionId, { kind: 'end', at, cwd: null }]]),
    });
    expect(ended.agents).toHaveLength(1);
    expect(ended.agents[0]).toMatchObject({ id: childId, parentId: null, parentAway: true });

    const laterEvidence = build({
      transcripts: [child],
      claudeParents: [parent],
      hooks: new Map([[parent.sessionId, { kind: 'end', at: at - MIN, cwd: null }]]),
    });
    expect(laterEvidence.agents.find((agent) => agent.id === parentId)?.state).toBe('idle');
    expect(laterEvidence.agents.find((agent) => agent.id === childId)?.parentId).toBe(parentId);
  });

  it('uses an eligible expired Paseo parent or a live hook before the transcript context', () => {
    const withPaseo = build({
      paseo: [
        {
          id: 'paseo-main',
          provider: 'claude',
          sessionId: parent.sessionId,
          title: 'Paseo parent',
          updatedAt: NOW - 31 * MIN,
        },
      ],
      transcripts: [child],
      claudeParents: [parent],
    });
    expect(withPaseo.agents).toHaveLength(2);
    expect(withPaseo.agents.find((agent) => agent.id === parentId)).toMatchObject({
      title: 'Paseo parent',
      state: 'idle',
      seenBy: { paseo: true, transcript: false },
    });
    expect(withPaseo.agents.find((agent) => agent.id === childId)?.parentId).toBe(parentId);

    const withHook = build({
      transcripts: [child],
      claudeParents: [parent],
      hooks: new Map([[parent.sessionId, { kind: 'permission', at: NOW - 1_000, cwd: null }]]),
    });
    expect(withHook.agents).toHaveLength(2);
    expect(withHook.agents.find((agent) => agent.id === parentId)).toMatchObject({
      state: 'waiting',
      waitReason: 'permission',
      confidence: 'reported',
    });
    expect(withHook.agents.find((agent) => agent.id === childId)?.parentId).toBe(parentId);
  });

  it('keeps the context ahead of unrelated idle sessions within the existing cap', () => {
    const transcripts = [
      child,
      ...Array.from({ length: ROSTER_CAP - 2 }, (_, i) => transcript({ sessionId: `filler-${i}` })),
    ];
    const last = transcript({ sessionId: 'other' });
    const claudeParents = [parent];
    const withRoom = build({
      transcripts: [...transcripts, { ...last, state: 'idle', activity: 'none' }],
      claudeParents,
    });
    expect(withRoom.truncated).toBe(true);
    expect(withRoom.agents).toHaveLength(ROSTER_CAP);
    expect(withRoom.agents.find((agent) => agent.id === childId)?.parentId).toBe(parentId);
    expect(withRoom.agents.some((agent) => agent.id === keyId('claude:other'))).toBe(false);

    const full = build({ transcripts: [...transcripts, last], claudeParents });
    expect(full.truncated).toBe(true);
    expect(full.agents).toHaveLength(ROSTER_CAP);
    expect(full.agents.some((agent) => agent.id === parentId)).toBe(false);
    expect(full.agents.find((agent) => agent.id === childId)).toMatchObject({
      parentId: null,
      parentBasis: 'native',
      parentAway: true,
    });
  });
});

describe('stable ids', () => {
  it('claude:<sid> and paseo:<id> resolve to one id once they are known to be the same agent, and a shown id does not change', () => {
    const memo = createKeyMemo();
    // First the transcript is seen alone: its id comes from its own key.
    const alone = build({ transcripts: [transcript({ sessionId: 'S' })], memo }).agents[0]?.id;
    expect(alone).toBe(keyId('claude:S'));
    // Then Paseo's agent appears and is the same one: the id already shown is kept.
    const both = build({
      paseo: [{ id: 'p1', provider: 'claude', sessionId: 'S', status: 'running' }],
      transcripts: [transcript({ sessionId: 'S' })],
      memo,
    }).agents;
    expect(both).toHaveLength(1);
    expect(both[0]?.id).toBe(alone);
    // And later, with only Paseo seeing it, still the same.
    expect(
      build({ paseo: [{ id: 'p1', provider: 'claude', sessionId: 'S', status: 'running' }], memo })
        .agents[0]?.id,
    ).toBe(alone);
  });

  it('an agent Paseo showed first keeps its id when its transcript joins (the id comes from the provider session once that is known)', () => {
    const memo = createKeyMemo();
    const paseo = [{ id: 'p1', provider: 'codex', sessionId: 'T', status: 'running' }];
    const first = build({ paseo, memo }).agents[0]?.id;
    expect(first).toBe(keyId('codex:T'));
    const joined = build({
      paseo,
      transcripts: [transcript({ sessionId: 'T', provider: 'codex' })],
      memo,
    }).agents;
    expect(joined).toHaveLength(1);
    expect(joined[0]?.id).toBe(first);
  });

  it('keeps the agent id when its transcript appears during a Paseo outage', () => {
    const memo = createKeyMemo();
    const paseo = [{ id: 'p1', provider: 'codex', sessionId: 'T', status: 'running' }];
    const first = build({ paseo, memo }).agents[0]?.id;
    const transcripts = [transcript({ sessionId: 'T', provider: 'codex' })];

    const duringOutage = build({ transcripts, memo }).agents;
    expect(duringOutage).toHaveLength(1);
    expect(duringOutage[0]?.id).toBe(first);

    const recovered = build({ paseo, transcripts, memo }).agents;
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.id).toBe(first);
  });

  it('without a memory the id of a Paseo-only agent is the same as before (rosterId)', () => {
    expect(build({ paseo: [{ id: 'x' }] }).agents[0]?.id).toBe(rosterId('x'));
  });

  it('two entities never get one id, and the ids are kept from poll to poll', () => {
    const memo = createKeyMemo();
    const first = build({
      paseo: [{ id: 'p1', provider: 'claude', sessionId: 'S', status: 'running' }],
      transcripts: [transcript({ sessionId: 'S' })],
      memo,
    });
    // Paseo's agent now reports another session; the old transcript is an agent of its own, and must not share the id.
    const second = build({
      paseo: [{ id: 'p1', provider: 'claude', sessionId: 'S2', status: 'running' }],
      transcripts: [transcript({ sessionId: 'S' })],
      memo,
    });
    expect(second.agents).toHaveLength(2);
    expect(new Set(second.agents.map((agent) => agent.id)).size).toBe(2);
    expect(second.agents.map((agent) => agent.id)).toContain(first.agents[0]?.id);
  });

  it('forgets a key not seen for half an hour', () => {
    const memo = createKeyMemo();
    build({ transcripts: [transcript({ sessionId: 'S' })], memo });
    expect(memo.ids.has('claude:S')).toBe(true);
    build({ transcripts: [], memo, now: NOW + 31 * MIN });
    expect(memo.ids.has('claude:S')).toBe(false);
  });
});

describe('order and cap', () => {
  it('orders waiting, error, working, then the rest, across both sources, most recent first', () => {
    const roster = build({
      paseo: [{ id: 'paseo-working', status: 'running', updatedAt: NOW - 10_000 }],
      transcripts: [
        transcript({
          sessionId: 't-idle',
          state: 'idle',
          activity: 'none',
          lastActivityAt: NOW - 1_000,
        }),
        transcript({ sessionId: 't-working', lastActivityAt: NOW - 2_000 }),
        transcript({
          sessionId: 't-wait',
          state: 'waiting',
          activity: 'none',
          waitReason: 'permission',
        }),
        transcript({ sessionId: 't-error', state: 'error', activity: 'none' }),
      ],
    });
    expect(roster.agents.map((agent) => agent.state)).toEqual([
      'waiting',
      'error',
      'working',
      'working',
      'idle',
    ]);
    const working = roster.agents.filter((agent) => agent.state === 'working');
    expect(working[0]?.id).toBe(keyId('claude:t-working'));
    expect(working[1]?.id).toBe(rosterId('paseo-working'));
  });

  it(`shows at most ${ROSTER_CAP} agents and says the list was cut`, () => {
    const transcripts = Array.from({ length: ROSTER_CAP + 5 }, (_, index) =>
      transcript({ sessionId: `s${index}`, lastActivityAt: NOW - index * 1000 }),
    );
    const roster = build({ transcripts });
    expect(roster.agents).toHaveLength(ROSTER_CAP);
    expect(roster.truncated).toBe(true);
    expect(roster.agents[0]?.id).toBe(keyId('claude:s0'));
  });

  it('is not truncated by the transcripts below the cap', () => {
    expect(build({ transcripts: [transcript({ sessionId: 's' })] }).truncated).toBe(false);
  });
});
