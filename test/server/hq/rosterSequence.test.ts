import { describe, expect, it } from 'vitest';
import type { TranscriptAgent } from '../../../src/server/collectors/live/feed.ts';
import type { LiveAgent } from '../../../src/server/collectors/paseo/liveAgent.ts';
import {
  ROSTER_CAP,
  buildRoster,
  createKeyMemo,
  keyId,
  type KeyMemo,
  type Roster,
} from '../../../src/server/services/hq/roster.ts';
import { HqAgent } from '../../../src/shared/contracts/hq.ts';
import { NOW, liveAgent } from '../../collectors/paseo/liveHelpers.ts';

// The ownership rule, driven by sequences of polls: successive rosters built with one memo, and after every poll the invariants that
// must hold whatever happened before. An agent that stays visible keeps its id; an id never moves to another agent that is visible;
// ids are unique; a parent is an entry of the same answer; no cycles; and every entry satisfies the contract. Then a seeded random
// run over a small universe of agents and sessions asserts the same invariants on a few hundred generated sequences.

const MIN = 60_000;
const SECOND = 1_000;

interface PaseoDef {
  id: string;
  /** The provider session the agent names. */
  session?: string | null;
  status?: 'running' | 'idle';
  /** Milliseconds before the poll's time that Paseo says it was updated. */
  updatedAgo?: number;
  /** Paseo's own parent label. */
  parent?: string;
}
interface TranscriptDef {
  session: string;
  /** The native parent session. */
  parent?: string;
  state?: TranscriptAgent['state'];
}
interface PollDef {
  paseo?: PaseoDef[];
  transcripts?: TranscriptDef[];
  /** Filler sessions that outrank every idle agent, so the cap cuts the idle ones. */
  crowd?: number;
  /** Milliseconds this poll is after the one before. Default 2 s. */
  after?: number;
}

const paseoOf = (def: PaseoDef, now: number): LiveAgent =>
  liveAgent({
    id: def.id,
    provider: 'claude',
    title: `T-${def.id}`,
    cwd: `/w/P-${def.id}`,
    sessionId: def.session ?? null,
    status: def.status ?? 'idle',
    updatedAt: now - (def.updatedAgo ?? 5 * SECOND),
    ...(def.parent === undefined ? {} : { parentAgentId: def.parent }),
  });

const transcriptOf = (def: TranscriptDef, now: number): TranscriptAgent => ({
  provider: 'claude',
  sessionId: def.session,
  parentSessionId: def.parent ?? null,
  cwd: `/w/W-${def.session}`,
  startedAt: null,
  state: def.state ?? 'idle',
  activity: 'none',
  waitReason: null,
  since: now - 60 * SECOND,
  lastActivityAt: now - 30 * SECOND,
});

/** Who an answer's entry is, as far as a test can tell from outside: its Paseo title, or else the session's folder. */
const who = (agent: HqAgent): string =>
  agent.title !== null ? `p:${agent.title}` : `s:${agent.workspace}`;

interface Seen {
  roster: Roster;
  now: number;
}

/** Builds each poll with one memo and checks every invariant after each. */
function run(polls: PollDef[], memo: KeyMemo = createKeyMemo(), start = NOW): Seen[] {
  const seen: Seen[] = [];
  let now = start;
  for (const def of polls) {
    now += def.after ?? 2 * SECOND;
    const crowd = Array.from({ length: def.crowd ?? 0 }, (_, index) => ({
      ...transcriptOf({ session: `filler-${index}`, state: 'working' }, now),
      activity: 'editing' as const,
      lastActivityAt: now,
    }));
    const roster = buildRoster({
      agents: (def.paseo ?? []).map((agent) => paseoOf(agent, now)),
      transcripts: [...(def.transcripts ?? []).map((item) => transcriptOf(item, now)), ...crowd],
      now,
      memo,
    });
    seen.push({ roster, now });
    invariants(seen);
  }
  return seen;
}

/** Every invariant of the last answer, and of the step from the answer before it. */
function invariants(history: Seen[]): void {
  const { roster } = history[history.length - 1] as Seen;
  const agents = roster.agents;
  const ids = agents.map((agent) => agent.id);
  expect(new Set(ids).size, 'ids are unique').toBe(ids.length);
  expect(new Set(agents.map(who)).size, 'entries are different agents').toBe(agents.length);
  for (const agent of agents) {
    expect(HqAgent.safeParse(agent).success, 'the contract').toBe(true);
    if (agent.parentId !== null) {
      expect(ids, 'a parent is in the same answer').toContain(agent.parentId);
      expect(agent.kind).toBe('child');
      expect(agent.parentAway).toBe(false);
    }
    if (agent.parentBasis !== null) expect(agent.kind).toBe('child');
  }
  const parentOf = new Map(agents.map((agent) => [agent.id, agent.parentId]));
  for (const agent of agents) {
    const seen = new Set<string>();
    for (let at: string | null | undefined = agent.id; at; at = parentOf.get(at)) {
      expect(seen.has(at), 'no cycle').toBe(false);
      seen.add(at);
    }
  }
  expect(agents.length).toBeLessThanOrEqual(ROSTER_CAP);

  const previous = history.at(-2);
  // A gap longer than the memo's keep time is a break, not a continuation: the memo has forgotten everything by design.
  if (previous === undefined || (history.at(-1) as Seen).now - previous.now > 30 * MIN) return;
  const before = previous.roster.agents;
  const nowBy = new Map(agents.map((agent) => [who(agent), agent.id]));
  const nowById = new Map(agents.map((agent) => [agent.id, who(agent)]));
  for (const old of before) {
    const same = nowBy.get(who(old));
    if (same !== undefined)
      expect(same, `${who(old)} keeps its id while it stays visible`).toBe(old.id);
    const heldBy = nowById.get(old.id);
    if (heldBy !== undefined && heldBy !== who(old))
      expect(
        nowBy.has(who(old)),
        `${old.id} moved from ${who(old)} to ${heldBy} while ${who(old)} is still visible`,
      ).toBe(false);
  }
}

const idOf = (seen: Seen, identity: string): string | undefined =>
  seen.roster.agents.find((agent) => who(agent) === identity)?.id;

const P = (id: string, session: string | null, more: Partial<PaseoDef> = {}): PaseoDef => ({
  id,
  session,
  ...more,
});
const T = (session: string, more: Partial<TranscriptDef> = {}): TranscriptDef => ({
  session,
  ...more,
});

describe('claimants of one session', () => {
  it('two claimants take turns in both orders and every agent that stays visible keeps its id', () => {
    const turns = run([
      { paseo: [P('a', 'S')], transcripts: [T('S')] },
      { paseo: [P('b', 'S')], transcripts: [T('S')] },
      { paseo: [P('a', 'S'), P('b', 'S')], transcripts: [T('S')] },
      { paseo: [P('a', 'S')], transcripts: [T('S')] },
      { paseo: [P('b', 'S'), P('a', 'S')], transcripts: [T('S')] },
      { paseo: [P('b', 'S')], transcripts: [T('S')] },
      { paseo: [P('b', 'S'), P('a', 'S')], transcripts: [T('S')] },
    ]);
    // b was visible alone, a came back: b is the one that has the session and its id.
    expect(idOf(turns[1] as Seen, 'p:T-b')).toBe(idOf(turns[2] as Seen, 'p:T-b'));
    expect(idOf(turns[2] as Seen, 'p:T-a')).not.toBe(idOf(turns[2] as Seen, 'p:T-b'));
    expect(turns[2]?.roster.agents.find((agent) => agent.title === 'T-b')?.seenBy.transcript).toBe(
      true,
    );
    expect(turns[2]?.roster.agents.find((agent) => agent.title === 'T-a')?.seenBy.transcript).toBe(
      false,
    );
  });

  it('three claimants: the owner stays, whatever the others do, and a returning one gets an id of its own', () => {
    const [a, b, c] = [P('a', 'S'), P('b', 'S'), P('c', 'S')] as [PaseoDef, PaseoDef, PaseoDef];
    const turns = run([
      { paseo: [a, b, c], transcripts: [T('S')] },
      { paseo: [b, c], transcripts: [T('S')] }, // a leaves: b is chosen (most recent, lowest id)
      { paseo: [a, b, c], transcripts: [T('S')] },
      { paseo: [a, b], transcripts: [T('S')] },
      { paseo: [a, b, c], transcripts: [T('S')] },
      { paseo: [b], transcripts: [T('S')] },
      { paseo: [c, b, a], transcripts: [T('S')] },
    ]);
    const owner = (turn: Seen) => turn.roster.agents.find((agent) => agent.seenBy.transcript);
    for (const turn of turns.slice(1)) expect(owner(turn)?.title).toBe('T-b');
    expect(new Set(turns[6]?.roster.agents.map((agent) => agent.id)).size).toBe(3);
    // c was visible in turns 4 and 6 apart from turn 5: the id it had comes back, and a different one is never given to b's session.
    expect(idOf(turns[4] as Seen, 'p:T-c')).toBe(idOf(turns[6] as Seen, 'p:T-c'));
  });

  it('the owner leaves and returns while another claimant has the session: it does not take it back', () => {
    const turns = run([
      { paseo: [P('a', 'S'), P('b', 'S')], transcripts: [T('S')] },
      { paseo: [P('b', 'S')], transcripts: [T('S')] },
      { paseo: [P('b', 'S')], transcripts: [T('S')] },
      { paseo: [P('a', 'S'), P('b', 'S')], transcripts: [T('S')] },
    ]);
    const owner = turns[3]?.roster.agents.find((agent) => agent.seenBy.transcript);
    expect(owner?.title).toBe('T-b');
  });

  it('the owner leaves for a while with nobody else there and gets the session and its id back', () => {
    const turns = run([
      { paseo: [P('a', 'S')], transcripts: [T('S')] },
      { transcripts: [T('S')] }, // Paseo is away
      { transcripts: [T('S')] },
      { paseo: [P('a', 'S'), P('b', 'S')], transcripts: [T('S')] },
    ]);
    const idBefore = idOf(turns[0] as Seen, 'p:T-a');
    expect(idOf(turns[1] as Seen, 's:W-S')).toBe(idBefore); // the transcript alone has the same id
    expect(idOf(turns[3] as Seen, 'p:T-a')).toBe(idBefore);
    expect(turns[3]?.roster.agents.find((agent) => agent.seenBy.transcript)?.title).toBe('T-a');
  });

  it('a claimant that stops naming the session keeps its id, and the transcript is then shown alone with an id of its own', () => {
    const turns = run([
      { paseo: [P('a', 'S')], transcripts: [T('S')] },
      { paseo: [P('a', null)], transcripts: [T('S')] },
      { paseo: [P('a', 'S')], transcripts: [T('S')] },
    ]);
    expect(idOf(turns[1] as Seen, 'p:T-a')).toBe(idOf(turns[0] as Seen, 'p:T-a'));
    expect(idOf(turns[1] as Seen, 's:W-S')).not.toBe(idOf(turns[1] as Seen, 'p:T-a'));
    expect(turns[1]?.roster.agents).toHaveLength(2);
    expect(turns[2]?.roster.agents).toHaveLength(1);
  });
});

describe('what an agent knows and when', () => {
  it('a session id that is learned late: the agent keeps the id it was shown with', () => {
    const turns = run([
      { paseo: [P('a', null)] },
      { paseo: [P('a', null)], transcripts: [T('S')] },
      { paseo: [P('a', 'S')], transcripts: [T('S')] },
      { paseo: [P('a', 'S')] },
    ]);
    expect(idOf(turns[0] as Seen, 'p:T-a')).toBe(keyId('paseo:a'));
    expect(idOf(turns[3] as Seen, 'p:T-a')).toBe(keyId('paseo:a'));
  });

  it('a transcript that appears and disappears around a Paseo agent that has the session', () => {
    const turns = run([
      { paseo: [P('a', 'S')] },
      { paseo: [P('a', 'S')], transcripts: [T('S')] },
      { paseo: [P('a', 'S')] },
      { paseo: [P('a', 'S')], transcripts: [T('S')] },
    ]);
    const ids = turns.map((turn) => idOf(turn, 'p:T-a'));
    expect(new Set(ids).size).toBe(1);
  });

  it('a Paseo outage leaves the transcript alone with the id the agent had, and the agent returns to it', () => {
    const turns = run([
      { paseo: [P('a', 'S', { status: 'running' })], transcripts: [T('S')] },
      { transcripts: [T('S')] },
      { paseo: [P('a', 'S', { status: 'running' })], transcripts: [T('S')] },
    ]);
    expect(new Set([0, 2].map((index) => idOf(turns[index] as Seen, 'p:T-a'))).size).toBe(1);
    expect(turns[1]?.roster.agents[0]?.id).toBe(idOf(turns[0] as Seen, 'p:T-a'));
  });

  it('after a stop and a start the ids come from the sessions again, whichever feed sees the agent first', () => {
    const before = run([{ paseo: [P('a', 'S')], transcripts: [T('S')] }]);
    const after = run([{ transcripts: [T('S')] }], createKeyMemo());
    const alone = run([{ paseo: [P('a', 'S')] }], createKeyMemo());
    expect(idOf(before[0] as Seen, 'p:T-a')).toBe(keyId('claude:S'));
    expect(after[0]?.roster.agents[0]?.id).toBe(keyId('claude:S'));
    expect(alone[0]?.roster.agents[0]?.id).toBe(keyId('claude:S'));
  });
});

describe('the cap', () => {
  it('cuts the owner of a session, and its child says the parent is away rather than naming a claimant', () => {
    const turns = run([
      {
        paseo: [
          P('owner', 'S'),
          P('claimant', 'S', { status: 'running', updatedAgo: 10 * SECOND }),
        ],
        transcripts: [T('S'), T('S:child', { parent: 'S', state: 'working' })],
        crowd: ROSTER_CAP - 2,
      },
    ]);
    const roster = (turns[0] as Seen).roster;
    expect(roster.truncated).toBe(true);
    const child = roster.agents.find((agent) => agent.workspace === 'W-S:child');
    expect(child).toMatchObject({ kind: 'child', parentId: null, parentAway: true });
    expect(roster.agents.find((agent) => agent.title === 'T-claimant')?.seenBy.transcript).toBe(
      false,
    );
  });

  it('cuts a claimant, the owner and the child stay linked', () => {
    const turns = run([
      {
        paseo: [
          P('owner', 'S', { status: 'running' }),
          P('claimant', 'S', { updatedAgo: 20 * MIN }),
        ],
        transcripts: [T('S'), T('S:child', { parent: 'S', state: 'working' })],
        crowd: ROSTER_CAP - 3,
      },
    ]);
    const roster = (turns[0] as Seen).roster;
    const owner = roster.agents.find((agent) => agent.title === 'T-owner');
    const child = roster.agents.find((agent) => agent.workspace === 'W-S:child');
    expect(owner).toBeDefined();
    expect(child).toMatchObject({ kind: 'child', parentId: owner?.id, parentAway: false });
  });

  it('cuts a child while its parent is shown, and a parent while its children are shown, in later polls with the same ids', () => {
    const base: PollDef = {
      paseo: [P('parent', 'S', { status: 'running' })],
      transcripts: [T('S'), T('S:child', { parent: 'S', state: 'idle' })],
    };
    const turns = run([
      base,
      { ...base, crowd: ROSTER_CAP },
      base,
      { ...base, crowd: ROSTER_CAP - 1 },
      base,
    ]);
    expect(turns[0]?.roster.agents).toHaveLength(2);
    expect(turns[2]?.roster.agents).toHaveLength(2);
    expect(idOf(turns[0] as Seen, 'p:T-parent')).toBe(idOf(turns[4] as Seen, 'p:T-parent'));
  });

  it('a Paseo parent label whose agent was cut is away, not another agent', () => {
    const turns = run([
      {
        paseo: [P('boss', null), P('worker', null, { status: 'running', parent: 'boss' })],
        crowd: ROSTER_CAP - 1,
      },
    ]);
    const worker = turns[0]?.roster.agents.find((agent) => agent.title === 'T-worker');
    expect(worker).toMatchObject({
      kind: 'child',
      parentBasis: 'paseo',
      parentId: null,
      parentAway: true,
    });
  });

  it('ids are decided before the cap: an agent that was cut and comes back has the id it would have had', () => {
    const turns = run([
      { paseo: [P('a', 'S'), P('b', 'S')], transcripts: [T('S')] },
      { paseo: [P('a', 'S'), P('b', 'S')], transcripts: [T('S')], crowd: ROSTER_CAP },
      { paseo: [P('a', 'S'), P('b', 'S')], transcripts: [T('S')] },
    ]);
    expect(turns[1]?.roster.agents.every((agent) => agent.workspace?.startsWith('W-filler'))).toBe(
      true,
    );
    expect(idOf(turns[0] as Seen, 'p:T-a')).toBe(idOf(turns[2] as Seen, 'p:T-a'));
    expect(idOf(turns[0] as Seen, 'p:T-b')).toBe(idOf(turns[2] as Seen, 'p:T-b'));
  });
});

describe('native parents resolve to the owner of the session', () => {
  it('to the owner, even when a claimant that joined later is the more recently updated, and with no transcript for the parent', () => {
    const child = T('S:child', { parent: 'S', state: 'working' });
    const turns = run([
      { paseo: [P('owner', 'S')], transcripts: [child] },
      {
        paseo: [P('owner', 'S'), P('claimant', 'S', { status: 'running', updatedAgo: 1 })],
        transcripts: [child],
      },
    ]);
    const roster = (turns[1] as Seen).roster;
    const owner = roster.agents.find((agent) => agent.title === 'T-owner');
    const linked = roster.agents.find((agent) => agent.workspace === 'W-S:child');
    expect(owner).toBeDefined();
    expect(linked).toMatchObject({ parentId: owner?.id, parentAway: false });
  });

  it('refuses a session that names itself and a loop between sessions', () => {
    const turns = run([
      { transcripts: [T('A', { parent: 'A' }), T('B', { parent: 'C' }), T('C', { parent: 'B' })] },
    ]);
    for (const agent of (turns[0] as Seen).roster.agents) expect(agent.parentId).toBeNull();
  });
});

describe('the memory', () => {
  const alone = { paseo: [P('a', 'S')], transcripts: [T('S')] } satisfies PollDef;

  it('keeps a key that was seen exactly 30 minutes ago and forgets one seen 30 minutes and a millisecond ago', () => {
    for (const [gap, kept] of [
      [30 * MIN, true],
      [30 * MIN + 1, false],
    ] as const) {
      const memo = createKeyMemo();
      const first = run([alone], memo);
      expect(memo.ids.size).toBeGreaterThan(0);
      run([{ after: gap, paseo: [P('z', null)] }], memo, first[0]?.now);
      expect(memo.ids.has('paseo:a')).toBe(kept);
      expect(memo.owners.has('claude:S')).toBe(kept);
    }
  });

  it('an agent that was forgotten and comes back has its derivable id, and a kept one its remembered id', () => {
    const memo = createKeyMemo();
    const firstRun = run([{ paseo: [P('a', null)] }], memo);
    const wasShown = idOf(firstRun[0] as Seen, 'p:T-a');
    const back = run(
      [{ after: 30 * MIN + 1, paseo: [P('a', 'S')], transcripts: [T('S')] }],
      memo,
      firstRun[0]?.now,
    );
    expect(wasShown).toBe(keyId('paseo:a'));
    expect(idOf(back[0] as Seen, 'p:T-a')).toBe(keyId('claude:S'));
  });

  it('stays bounded in keys and owners however many sessions pass through, and never drops what the poll just wrote', () => {
    const memo = createKeyMemo();
    for (let round = 0; round < 15; round += 1)
      run(
        [
          {
            paseo: Array.from({ length: 40 }, (_, i) => P(`r${round}-${i}`, `s${round}-${i}`)),
            transcripts: Array.from({ length: 40 }, (_, i) => T(`s${round}-${i}`)),
          },
        ],
        memo,
        NOW + round * 3 * SECOND,
      );
    expect(memo.ids.size).toBeLessThanOrEqual(500);
    expect(memo.owners.size).toBeLessThanOrEqual(500);
    // The last poll's agents all kept their keys.
    expect(memo.ids.has('paseo:r14-39')).toBe(true);
    expect(memo.owners.has('claude:s14-39')).toBe(true);
  });
});

// ---- a seeded random run ---------------------------------------------------------------------------------------------------

/** mulberry32: a small seeded generator, so a failure repeats. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('random sequences', () => {
  const AGENTS = ['a', 'b', 'c', 'd'];
  const SESSIONS = ['s0', 's1', 's2', 's3'];

  function poll(random: () => number): PollDef {
    const pick = <X>(items: readonly X[]): X => items[Math.floor(random() * items.length)] as X;
    const paseo = AGENTS.filter(() => random() < 0.6).map((id) =>
      P(id, random() < 0.2 ? null : pick(SESSIONS), {
        status: random() < 0.5 ? 'running' : 'idle',
        updatedAgo: pick([SECOND, 5 * SECOND, 20 * SECOND, 5 * MIN]),
        ...(random() < 0.25 ? { parent: pick(AGENTS) } : {}),
      }),
    );
    const transcripts = SESSIONS.filter(() => random() < 0.6).map((session) =>
      T(session, {
        state: random() < 0.5 ? 'working' : 'idle',
        ...(random() < 0.3 ? { parent: pick([...SESSIONS, 's-missing']) } : {}),
      }),
    );
    return {
      paseo,
      transcripts,
      after: pick([SECOND, 2 * SECOND, 2 * SECOND, 10 * SECOND, 31 * MIN]),
      ...(random() < 0.15 ? { crowd: pick([ROSTER_CAP - 2, ROSTER_CAP]) } : {}),
    };
  }

  it('hold every invariant over 300 generated sequences of 14 polls', () => {
    const random = seeded(20261119);
    for (let sequence = 0; sequence < 300; sequence += 1) {
      const polls = Array.from({ length: 14 }, () => poll(random));
      try {
        const forward = run(polls);
        // The order the daemon and the feeds list things in changes nothing.
        const reversed = run(
          polls.map((def) => ({
            ...def,
            paseo: [...(def.paseo ?? [])].reverse(),
            transcripts: [...(def.transcripts ?? [])].reverse(),
          })),
        );
        const view = (seen: Seen[]) =>
          seen.map((turn) => turn.roster.agents.map((agent) => [who(agent), agent.id]));
        expect(view(reversed)).toEqual(view(forward));
      } catch (error) {
        throw new Error(`sequence ${sequence} failed: ${(error as Error).message}`, {
          cause: error,
        });
      }
    }
  });
});
