import { describe, expect, it } from 'vitest';
import type { TranscriptAgent } from '../../../src/server/collectors/live/feed.ts';
import {
  buildRoster,
  createKeyMemo,
  keyId,
  rosterId,
  type KeyMemo,
} from '../../../src/server/services/hq/roster.ts';
import { NOW, liveAgent } from '../../collectors/paseo/liveHelpers.ts';

// An agent has one id whichever feed sees it, as soon as its provider session is known, and the id it was shown with does not change.
// Pure: no feed, no folder, no database.

const MIN = 60_000;

const transcript = (over: Partial<TranscriptAgent> & { sessionId: string }): TranscriptAgent => ({
  provider: 'codex',
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

type PaseoSpec = Parameters<typeof liveAgent>[0];
const build = (input: {
  paseo?: PaseoSpec[];
  transcripts?: TranscriptAgent[];
  memo?: KeyMemo;
  now?: number;
}) =>
  buildRoster({
    agents: (input.paseo ?? []).map(liveAgent),
    transcripts: input.transcripts ?? [],
    now: input.now ?? NOW,
    memo: input.memo,
  });

const p1 = { id: 'p1', provider: 'codex', sessionId: 'T', status: 'running' } as const;
const t1 = () => transcript({ sessionId: 'T' });

describe('a feed handoff keeps the id', () => {
  it('the transcript first, Paseo later', () => {
    const memo = createKeyMemo();
    const first = build({ transcripts: [t1()], memo }).agents[0]?.id;
    expect(first).toBe(keyId('codex:T'));
    expect(build({ paseo: [p1], transcripts: [t1()], memo }).agents[0]?.id).toBe(first);
    expect(build({ paseo: [p1], memo }).agents[0]?.id).toBe(first);
  });

  it('Paseo first, then the transcript alone, then both, then Paseo alone, then the transcript alone again', () => {
    const memo = createKeyMemo();
    const first = build({ paseo: [p1], memo }).agents[0]?.id;
    for (const feeds of [
      { transcripts: [t1()] },
      { paseo: [p1], transcripts: [t1()] },
      { paseo: [p1] },
      { transcripts: [t1()] },
    ])
      expect(build({ ...feeds, memo }).agents.map((agent) => agent.id)).toEqual([first]);
  });

  it('a Paseo agent whose session only becomes known later keeps the id it was shown with', () => {
    const memo = createKeyMemo();
    const unknown = { id: 'p1', provider: 'codex', sessionId: null, status: 'running' } as const;
    const first = build({ paseo: [unknown], memo }).agents[0]?.id;
    expect(first).toBe(rosterId('p1'));
    // The session becomes known, with a transcript and without one.
    expect(build({ paseo: [p1], transcripts: [t1()], memo }).agents[0]?.id).toBe(first);
    expect(build({ paseo: [p1], memo }).agents[0]?.id).toBe(first);
    // And now the transcript alone, during an outage.
    expect(build({ transcripts: [t1()], memo }).agents[0]?.id).toBe(first);
  });

  it('a Paseo agent whose session is known at once has the id the transcript has, with no memory at all', () => {
    expect(build({ paseo: [p1] }).agents[0]?.id).toBe(build({ transcripts: [t1()] }).agents[0]?.id);
  });

  it('ids are deterministic after the memory was dropped (a stop and a start), whichever feed sees the agent first', () => {
    const memo = createKeyMemo();
    const before = build({ paseo: [p1], memo }).agents[0]?.id;
    const afterByTranscript = build({ transcripts: [t1()], memo: createKeyMemo() }).agents[0]?.id;
    const afterByPaseo = build({ paseo: [p1], memo: createKeyMemo() }).agents[0]?.id;
    expect(afterByTranscript).toBe(before);
    expect(afterByPaseo).toBe(before);
  });
});

describe('two Paseo agents naming one session', () => {
  const p2 = { id: 'p2', provider: 'codex', sessionId: 'T', status: 'running' } as const;

  it('are two entries with two ids, and the transcript joins exactly one of them', () => {
    const roster = build({ paseo: [p1, p2], transcripts: [t1()] });
    expect(roster.agents).toHaveLength(2);
    expect(new Set(roster.agents.map((agent) => agent.id)).size).toBe(2);
    expect(roster.agents.filter((agent) => agent.seenBy.transcript)).toHaveLength(1);
  });

  it('the one that has the session does not change with the order Paseo lists them in', () => {
    const memo = createKeyMemo();
    const a = build({ paseo: [p1, p2], transcripts: [t1()], memo }).agents;
    const b = build({ paseo: [p2, p1], transcripts: [t1()], memo }).agents;
    expect(b.map((agent) => [agent.id, agent.seenBy.transcript]).sort()).toEqual(
      a.map((agent) => [agent.id, agent.seenBy.transcript]).sort(),
    );
  });

  it('an agent that already had the session’s id keeps it when the other one is updated more recently', () => {
    const memo = createKeyMemo();
    const alone = build({ paseo: [p1], memo }).agents[0]?.id;
    const both = build({
      paseo: [p1, { ...p2, updatedAt: NOW - 100 }],
      transcripts: [t1()],
      memo,
    }).agents;
    const first = both.find((agent) => agent.seenBy.transcript);
    expect(first?.id).toBe(alone);
    expect(both).toHaveLength(2);
    expect(new Set(both.map((agent) => agent.id)).size).toBe(2);
  });

  it('when the owner goes, the other takes the session and keeps the id it had', () => {
    const memo = createKeyMemo();
    const both = build({ paseo: [p1, p2], transcripts: [t1()], memo }).agents;
    const second = both.find((agent) => !agent.seenBy.transcript)?.id;
    const next = build({ paseo: [p2], transcripts: [t1()], memo }).agents;
    expect(next).toHaveLength(1);
    expect(next[0]?.id).toBe(second);
  });

  it('keeps a visible agent’s id when an earlier claimant returns', () => {
    const memo = createKeyMemo();
    const first = { ...p1, title: 'First agent' };
    const second = { ...p2, title: 'Second agent' };
    build({ paseo: [first], transcripts: [t1()], memo });
    const [visible] = build({ paseo: [second], transcripts: [t1()], memo }).agents;
    expect(visible?.title).toBe('Second agent');

    const next = build({ paseo: [first, second], transcripts: [t1()], memo }).agents;
    expect(next).toHaveLength(2);
    expect(next.find((agent) => agent.title === 'Second agent')?.id).toBe(visible?.id);
  });
});

describe('the memory', () => {
  it('remembers every key of an agent together', () => {
    const memo = createKeyMemo();
    build({ paseo: [p1], memo });
    expect([...memo.ids.keys()].sort()).toEqual(['codex:T', 'paseo:p1']);
  });

  it('forgets a key not seen for half an hour, and the agent then has its deterministic id again', () => {
    const memo = createKeyMemo();
    const unknown = { id: 'p1', provider: 'codex', sessionId: null, status: 'running' } as const;
    const first = build({ paseo: [unknown], memo }).agents[0]?.id;
    // Half an hour and a bit later the same Paseo agent now names a session: the old key was forgotten, but the id comes from the session.
    const later = build({ paseo: [p1], memo, now: NOW + 31 * MIN }).agents[0]?.id;
    expect(first).toBe(rosterId('p1'));
    expect(later).toBe(keyId('codex:T'));
  });

  it('stays bounded however many different sessions pass through', () => {
    const memo = createKeyMemo();
    for (let round = 0; round < 12; round += 1)
      build({
        transcripts: Array.from({ length: 60 }, (_, index) =>
          transcript({ sessionId: `s-${round}-${index}` }),
        ),
        memo,
        now: NOW + round * 1_000,
      });
    expect(memo.ids.size).toBeLessThanOrEqual(500);
  });

  it('an id is never given to two entries in one answer', () => {
    const roster = build({
      paseo: [p1, { ...p1, id: 'p2' }, { ...p1, id: 'p3' }],
      transcripts: [t1(), transcript({ sessionId: 'U' })],
    });
    expect(new Set(roster.agents.map((agent) => agent.id)).size).toBe(roster.agents.length);
  });
});
