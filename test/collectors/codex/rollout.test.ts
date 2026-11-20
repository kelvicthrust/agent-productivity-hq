import { describe, expect, it } from 'vitest';
import {
  RolloutParser,
  classifySource,
  eventKey,
  type ParsedRollout,
} from '../../../src/server/collectors/codex/rollout.ts';
import { metaLine, snapshotLine, spawnedFrom, turnLine } from './helpers.ts';

// The rules of one rollout, on invented lines (the draft fixture folders are read by the adapter tests). Counts are
// [input, cached, output, reasoning]; a snapshot is cumulative, an event is the difference from the one before.

const parse = (...rows: string[]): ParsedRollout => {
  const parser = new RolloutParser();
  for (const row of rows) parser.push(row);
  return parser.finish();
};

const T = (second: number): string => `2026-10-20T10:00:${String(second).padStart(2, '0')}.000Z`;
const ID = '11111111-aaaa-4aaa-8aaa-000000000001';

describe('cumulative snapshots become deltas', () => {
  it('[X2] takes each event as the difference from the snapshot before it when there is no last_token_usage, in Codex’s own categories', () => {
    const { events, meta } = parse(
      metaLine(ID, T(0)),
      turnLine(T(1), 'gpt-5-codex'),
      snapshotLine(T(5), [1200, 800, 150, 40]),
      snapshotLine(T(9), [2500, 1900, 400, 90]),
    );
    expect(meta?.id).toBe(ID);
    expect(events).toMatchObject([
      { input: 1200, cached: 800, output: 150, reasoning: 40, providerTotal: 1350 },
      { input: 1300, cached: 1100, output: 250, reasoning: 50, providerTotal: 1550 },
    ]);
    expect(events.map((e) => e.model)).toEqual(['gpt-5-codex', 'gpt-5-codex']);
  });

  it('keeps providerTotal as input + output, not the sum of every category', () => {
    const [event] = parse(metaLine(ID, T(0)), snapshotLine(T(5), [1000, 600, 100, 30])).events;
    expect(event?.providerTotal).toBe(1100);
  });

  it('ignores a snapshot that repeats the one before it', () => {
    const { events, unreadable } = parse(
      metaLine(ID, T(0)),
      snapshotLine(T(5), [100, 0, 10, 0]),
      snapshotLine(T(6), [100, 0, 10, 0]),
      snapshotLine(T(7), [160, 0, 20, 0]),
    );
    expect(events.map((e) => e.providerTotal)).toEqual([110, 70]);
    expect(unreadable).toBe(0);
  });

  it('uses the model of the latest turn_context, and unknown before there is one', () => {
    const { events } = parse(
      metaLine(ID, T(0)),
      snapshotLine(T(2), [10, 0, 1, 0]),
      turnLine(T(3), 'gpt-5'),
      snapshotLine(T(4), [20, 0, 2, 0]),
      turnLine(T(5), 'gpt-5-codex'),
      snapshotLine(T(6), [30, 0, 3, 0]),
    );
    expect(events.map((e) => e.model)).toEqual(['unknown', 'gpt-5', 'gpt-5-codex']);
  });

  it('[X2] takes a drop in the total with no last_token_usage as a saturating difference, field by field, as the oracle does', () => {
    const { events } = parse(
      metaLine(ID, T(0)),
      snapshotLine(T(2), [800, 500, 200, 50]), // total 1000
      snapshotLine(T(3), [300, 100, 60, 10]), // the counter started over: every field is below the last, so nothing is added
      snapshotLine(T(4), [800, 400, 200, 40]), // 500 more input, 140 more output than the snapshot before it
    );
    expect(events.map((e) => e.providerTotal)).toEqual([1000, 640]);
  });

  it('[X2] takes last_token_usage when the cumulative total changed, even if the total went down', () => {
    const { events } = parse(
      metaLine(ID, T(0)),
      snapshotLine(T(2), [800, 500, 200, 50], [800, 500, 200, 50]),
      snapshotLine(T(3), [300, 100, 60, 10], [300, 100, 60, 10]), // a reset: the request's own usage is what counts
      snapshotLine(T(4), [800, 400, 200, 40], [500, 300, 140, 30]),
    );
    expect(events.map((e) => e.providerTotal)).toEqual([1000, 360, 640]);
  });

  it('[X2] takes last_token_usage over the change in totals when they differ, and nothing at all when the total repeats', () => {
    const { events } = parse(
      metaLine(ID, T(0)),
      snapshotLine(T(2), [1000, 600, 100, 20], [1000, 600, 100, 20]),
      // the totals moved by 400 input, but the request itself used 700: the oracle counts the request
      snapshotLine(T(3), [1400, 900, 160, 30], [700, 650, 90, 15]),
      snapshotLine(T(4), [1400, 900, 160, 30], [700, 650, 90, 15]), // the same total again: not advanced, difference 0, dropped
    );
    expect(events.map((e) => [e.input, e.output])).toEqual([
      [1000, 100],
      [700, 90],
    ]);
  });

  it('[X1] clamps cached within input and cache-write within what is left, and reads the other spellings', () => {
    const line = JSON.stringify({
      timestamp: T(2),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            prompt_tokens: 100,
            cache_read_input_tokens: 130, // more than the input: capped at 100
            cache_write_input_tokens: 40, // nothing left of the input after the cached part: capped at 0
            completion_tokens: 10,
            reasoning_tokens: 4,
          },
        },
      },
    });
    const wide = JSON.stringify({
      timestamp: T(3),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 30,
            cache_creation_input_tokens: 90, // 70 left: capped at 70
            output_tokens: 10,
            total_tokens: 0, // a recorded zero is not a total: input + output
          },
        },
      },
    });
    const { events } = parse(metaLine(ID, T(0)), line, wide);
    expect(events).toMatchObject([
      { input: 100, cached: 100, cacheWrite: 0, output: 10, reasoning: 4, total: 110 },
      { input: 100, cached: 30, cacheWrite: 70, output: 10, reasoning: 0, total: 110 },
    ]);
  });

  it('[X7] gives the same events in the same rollout the same keys, another session or time another key', () => {
    const rows = [
      metaLine(ID, T(0)),
      snapshotLine(T(2), [100, 0, 10, 0]),
      snapshotLine(T(3), [250, 0, 30, 0]),
    ];
    const once = parse(...rows).events.map((e) => eventKey(ID, e));
    expect(parse(...rows).events.map((e) => eventKey(ID, e))).toEqual(once);
    expect(new Set(once).size).toBe(2);
    // a copy in another session is that session's own events: the oracle's session report counts it there too
    const other = parse(...rows).events.map((e) =>
      eventKey('22222222-bbbb-4bbb-8bbb-000000000002', e),
    );
    expect(other[0]).not.toBe(once[0]);
    const later = parse(metaLine(ID, T(0)), snapshotLine(T(9), [100, 0, 10, 0])).events.map((e) =>
      eventKey(ID, e),
    );
    expect(later[0]).not.toBe(once[0]);
  });
});

describe('what cannot be read is counted, not guessed', () => {
  it('counts a line that is not a JSON object, and one with no input count, and keeps the usage they would have added', () => {
    const noInput = JSON.stringify({
      timestamp: T(4),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            cached_input_tokens: 0,
            output_tokens: 50,
            reasoning_output_tokens: 0,
            total_tokens: 550,
          },
        },
      },
    });
    const { events, unreadable } = parse(
      metaLine(ID, T(0)),
      snapshotLine(T(2), [100, 0, 10, 0]),
      'not json at all',
      '[1,2,3]',
      noInput,
      snapshotLine(T(6), [900, 0, 90, 0]), // cumulative: it carries what the unreadable one would have added
    );
    expect(unreadable).toBe(3);
    expect(events.map((e) => e.providerTotal)).toEqual([110, 880]);
  });

  it('does not take a count with info null for damage or for usage', () => {
    const rateLimitsOnly = JSON.stringify({
      timestamp: T(3),
      type: 'event_msg',
      payload: { type: 'token_count', info: null, rate_limits: { primary: null } },
    });
    const parsed = parse(metaLine(ID, T(0)), rateLimitsOnly, snapshotLine(T(4), [100, 0, 10, 0]));
    expect(parsed.unreadable).toBe(0);
    expect(parsed.events).toHaveLength(1);
  });

  it('counts a snapshot with no usable time or with fractional counts', () => {
    const noTime = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 5,
            cached_input_tokens: 0,
            output_tokens: 1,
            reasoning_output_tokens: 0,
            total_tokens: 6,
          },
        },
      },
    });
    const fractional = snapshotLine(T(5), [10.5, 0, 1, 0]);
    const { events, unreadable } = parse(
      metaLine(ID, T(0)),
      noTime,
      fractional,
      snapshotLine(T(6), [60, 0, 6, 0]),
    );
    expect(unreadable).toBe(2);
    expect(events.map((e) => e.providerTotal)).toEqual([66]);
  });

  it('counts usage that comes before any session_meta, and then has no identity', () => {
    const parsed = parse(snapshotLine(T(2), [100, 0, 10, 0]), metaLine(ID, T(3)));
    expect(parsed.events).toEqual([]);
    expect(parsed.unreadable).toBe(1);
    expect(parsed.meta?.id).toBe(ID);
  });

  it('keeps the first session_meta: a damaged one is not replaced by a later (replayed) one', () => {
    const damaged = JSON.stringify({
      timestamp: T(0),
      type: 'session_meta',
      payload: { cwd: '/x' },
    });
    const parsed = parse(
      damaged,
      metaLine('22222222-bbbb-4bbb-8bbb-000000000002', T(1)),
      snapshotLine(T(5), [100, 0, 10, 0]),
    );
    expect(parsed.meta).toBeNull();
    expect(parsed.sawUsage).toBe(true);
    expect(parsed.events).toEqual([]);
    expect(
      parse(metaLine(ID, T(0)), metaLine('22222222-bbbb-4bbb-8bbb-000000000002', T(1))).meta?.id,
    ).toBe(ID);
  });

  it('falls back to the line’s own time when the meta payload has none', () => {
    expect(parse(metaLine(ID, T(7), { timestamp: null })).meta?.startedAt).toBe(Date.parse(T(7)));
    expect(parse(metaLine(ID, T(7), { timestamp: T(2) })).meta?.startedAt).toBe(Date.parse(T(2)));
  });

  it('never carries a line’s text into what it returns', () => {
    const secret = 'SENTINEL_PROMPT_zz9';
    const message = JSON.stringify({
      timestamp: T(1),
      type: 'response_item',
      payload: { type: 'message', content: [{ text: secret }] },
    });
    const parsed = parse(
      metaLine(ID, T(0)),
      message,
      `${secret} not json`,
      snapshotLine(T(2), [10, 0, 1, 0]),
    );
    expect(JSON.stringify(parsed)).not.toContain('SENTINEL');
  });
});

describe('a rollout that is not a fork', () => {
  it('does not apply replay to a root: its older-looking lines are its own', () => {
    const { events, fork } = parse(metaLine(ID, T(30)), snapshotLine(T(5), [100, 0, 10, 0]));
    expect(events.map((e) => e.providerTotal)).toEqual([110]);
    expect(fork).toBeNull();
  });

  it('names its parent from forked_from_id, else from the spawning thread, with the first line’s time as the fork instant', () => {
    const parent = '99999999-aaaa-4aaa-8aaa-000000000009';
    expect(parse(metaLine(ID, T(30), { forkedFrom: parent })).fork).toEqual({
      parentId: parent,
      at: Date.parse(T(30)),
    });
    expect(parse(metaLine(ID, T(30), { source: spawnedFrom(parent) })).fork).toEqual({
      parentId: parent,
      at: Date.parse(T(30)),
    });
    expect(parse(metaLine(ID, T(30), { source: spawnedFrom() })).fork).toBeNull();
    // a spawned child that names its parent only as forked_from_id still has that parent as its native reference
    expect(
      parse(metaLine(ID, T(30), { source: 'subagent', forkedFrom: parent })).meta?.source,
    ).toEqual({ kind: 'spawned', parentId: parent });
  });
});

describe('classifySource', () => {
  const own = ID;
  it.each([
    ['cli', { kind: 'root' }],
    ['vscode', { kind: 'root' }],
    ['exec', { kind: 'root' }],
    ['appServer', { kind: 'root' }],
    ['app_server', { kind: 'root' }],
    ['unknown', { kind: 'unknown' }],
    ['something-new', { kind: 'unknown' }],
    [undefined, { kind: 'unknown' }],
    [null, { kind: 'unknown' }],
    [42, { kind: 'unknown' }],
    [{ custom: 'x' }, { kind: 'unknown' }],
    ['subagent', { kind: 'spawned', parentId: null }],
    [{ subagent: 'review' }, { kind: 'spawned', parentId: null }],
    [spawnedFrom(), { kind: 'spawned', parentId: null }],
    [
      spawnedFrom('99999999-aaaa-4aaa-8aaa-000000000009'),
      { kind: 'spawned', parentId: '99999999-aaaa-4aaa-8aaa-000000000009' },
    ],
    [
      { sub_agent: { thread_spawn: { parent_thread_id: 'p1' } } },
      { kind: 'spawned', parentId: 'p1' },
    ],
  ])('%j is %j', (source, expected) => {
    expect(classifySource(source, own)).toEqual(expected);
  });

  it('gives a thread that names itself as its parent no parent reference', () => {
    expect(classifySource(spawnedFrom(own), own)).toEqual({ kind: 'spawned', parentId: null });
  });

  it('does not take an empty or non-string parent id for a reference', () => {
    expect(classifySource({ subagent: { thread_spawn: { parent_thread_id: '' } } }, own)).toEqual({
      kind: 'spawned',
      parentId: null,
    });
    expect(classifySource({ subagent: { thread_spawn: { parent_thread_id: 7 } } }, own)).toEqual({
      kind: 'spawned',
      parentId: null,
    });
  });
});
