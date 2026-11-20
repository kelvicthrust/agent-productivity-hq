import { describe, expect, it } from 'vitest';
import { classifyTranscript } from '../../../src/server/collectors/claude/files.ts';
import { TranscriptScan } from '../../../src/server/collectors/claude/transcript.ts';
import { assistantLine, userLine, type Message } from './helpers.ts';

// The two pure parts of the adapter: which files are transcripts, and what one line says. Values are invented.

describe('classifyTranscript', () => {
  it('reads main transcripts and subagent files, and names a child by its parent and its own file', () => {
    expect(classifyTranscript('proj/sess-1.jsonl')).toEqual({ kind: 'main', sessionId: 'sess-1' });
    expect(classifyTranscript('proj/sess-1/subagents/agent-ab.jsonl')).toEqual({
      kind: 'subagent',
      sessionId: 'sess-1:agent-ab',
      parentId: 'sess-1',
    });
  });

  it.each([
    ['an orphaned copy', 'proj/sess-1.orphaned-1760000000-ab12cd.jsonl'],
    ['a superseded copy', 'proj/sess-1.jsonl.superseded-1760000000-ab12cd'],
    ['an orphaned subagent copy', 'proj/sess-1/subagents/agent-ab.orphaned-1-cd.jsonl'],
    ['a superseded subagent copy', 'proj/sess-1/subagents/agent-ab.jsonl.superseded-1-cd'],
    ['a file that is not a transcript', 'proj/notes.txt'],
    ['a transcript with no name', 'proj/.jsonl'],
    ['a file at the top of projects/', 'sess-1.jsonl'],
    ['a folder other than subagents/', 'proj/sess-1/other/agent-ab.jsonl'],
    ['a subagent folder nested deeper', 'proj/sess-1/subagents/deeper/agent-ab.jsonl'],
    ['a compressed transcript', 'proj/sess-1.jsonl.zst'],
  ])('does not read %s', (_name, path) => {
    expect(classifyTranscript(path)).toBeNull();
  });
});

describe('TranscriptScan', () => {
  const scan = (...lines: string[]): TranscriptScan => {
    const result = new TranscriptScan();
    for (const line of lines) result.add(line);
    return result;
  };

  it('makes one event per assistant message, with four separate categories and the provider’s own total', () => {
    const result = scan(
      assistantLine({
        id: 'm1',
        at: '2026-10-20T10:00:05Z',
        input: 5,
        cacheWrite: 7,
        cacheRead: 11,
        output: 13,
      }),
    );
    expect([...result.events.values()]).toEqual([
      {
        dedupeKey: 'm1:req_m1',
        sidechain: false,
        hasSpeed: false,
        occurredAt: Date.parse('2026-10-20T10:00:05Z'),
        model: 'claude-sonnet-4-5',
        input: 5,
        cacheWrite: 7,
        cacheRead: 11,
        output: 13,
        total: 36,
      },
    ]);
    expect(result.unreadable).toBe(0);
  });

  it('[A4] keeps the line with the larger total for a key, the first of equal ones, and counts the others as repeats', () => {
    const result = scan(
      assistantLine({ id: 'm1', at: '2026-10-20T10:00:05Z', output: 5 }),
      assistantLine({ id: 'm1', at: '2026-10-20T10:00:06Z', output: 9 }), // larger: replaces
      assistantLine({ id: 'm1', at: '2026-10-20T10:00:07Z', output: 2 }), // smaller: the stored one stays
      assistantLine({ id: 'm1', at: '2026-10-20T10:00:08Z', output: 9 }), // equal: the first of them stays
    );
    expect(result.events.size).toBe(1);
    expect(result.events.get('m1:req_m1')).toMatchObject({
      output: 9,
      occurredAt: Date.parse('2026-10-20T10:00:06Z'),
    });
    expect(result.repeated).toBe(3);
  });

  it('keys on both ids: the same message under another request is another event', () => {
    const result = scan(
      assistantLine({ id: 'm1', req: 'r1', at: '2026-10-20T10:00:05Z' }),
      assistantLine({ id: 'm1', req: 'r2', at: '2026-10-20T10:00:06Z' }),
    );
    expect([...result.events.keys()]).toEqual(['m1:r1', 'm1:r2']);
  });

  it('counts an unreadable line, and a usage line missing something it needs, and stores neither', () => {
    interface Line {
      requestId?: string;
      timestamp?: string;
      message: { id?: string; model?: string; usage: Record<string, unknown> };
    }
    const lineWith = (patch: (line: Line) => void): string => {
      const line = JSON.parse(assistantLine({ id: 'm1', at: '2026-10-20T10:00:05Z' })) as Line;
      patch(line);
      return JSON.stringify(line);
    };
    const result = scan(
      'not json at all',
      '"a string"',
      '[]',
      lineWith((l) => delete l.timestamp),
      lineWith((l) => (l.timestamp = 'yesterday')),
      lineWith((l) => (l.message.usage.cache_read_input_tokens = '4')),
      lineWith((l) => delete l.message.usage.output_tokens),
      lineWith((l) => (l.message.usage.output_tokens = -1)),
      lineWith((l) => (l.message.usage.output_tokens = 1.5)),
      lineWith((l) => (l.message.usage.input_tokens = '4')),
    );
    expect(result.unreadable).toBe(10);
    expect(result.events.size).toBe(0);
  });

  it('ignores what carries no usage without counting it: user lines, usage-less replies, zero-token notices', () => {
    const notice = JSON.parse(
      assistantLine({ id: 'n1', req: null, at: '2026-10-20T10:00:05Z', input: 0, output: 0 }),
    );
    const noUsage = {
      type: 'assistant',
      timestamp: '2026-10-20T10:00:06Z',
      message: { id: 'x', model: 'm' },
    };
    const result = scan(
      userLine('2026-10-20T10:00:00Z'),
      JSON.stringify(noUsage),
      JSON.stringify(notice),
      JSON.stringify({ type: 'system', content: 'SENTINEL_NOTICE' }),
    );
    expect(result.unreadable).toBe(0);
    expect(result.events.size).toBe(0);
  });

  it('takes the start from the earliest timestamp of any line, and ignores a line with no usable one', () => {
    const result = scan(
      JSON.stringify({ type: 'summary', summary: 'SENTINEL_TITLE_x' }), // no timestamp
      JSON.stringify({ type: 'user', timestamp: 'not a time' }),
      assistantLine({ id: 'm1', at: '2026-10-20T10:00:05Z' }),
      JSON.stringify({ type: 'queue-operation', timestamp: '2026-10-20T09:58:00Z' }),
      userLine('2026-10-20T10:00:00Z'),
    );
    expect(result.earliestLine).toBe(Date.parse('2026-10-20T09:58:00Z'));
    expect(result.unreadable).toBe(0);
  });

  it('takes the first working directory and the last branch it meets', () => {
    const result = scan(
      JSON.stringify({ type: 'user', cwd: '/fixture/one', gitBranch: 'SENTINEL_BRANCH_1' }),
      JSON.stringify({ type: 'user', cwd: '/fixture/two', gitBranch: 'SENTINEL_BRANCH_2' }),
      JSON.stringify({ type: 'user', cwd: '' }),
    );
    expect(result).toMatchObject({ cwd: '/fixture/one', gitBranch: 'SENTINEL_BRANCH_2' });
  });

  it('prefers a name the user gave over one Claude Code made, over a summary, and the later of equals', () => {
    expect(
      scan(
        JSON.stringify({ type: 'custom-title', customTitle: 'SENTINEL_TITLE_user' }),
        JSON.stringify({ type: 'ai-title', aiTitle: 'SENTINEL_TITLE_ai' }),
        JSON.stringify({ type: 'summary', summary: 'SENTINEL_TITLE_summary' }),
      ).title,
    ).toBe('SENTINEL_TITLE_user');
    expect(
      scan(
        JSON.stringify({ type: 'summary', summary: 'SENTINEL_TITLE_first' }),
        JSON.stringify({ type: 'summary', summary: 'SENTINEL_TITLE_second' }),
      ).title,
    ).toBe('SENTINEL_TITLE_second');
    expect(scan(JSON.stringify({ type: 'summary', summary: '  ' })).title).toBeNull();
    expect(scan(JSON.stringify({ type: 'summary', summary: 5 })).title).toBeNull();
  });

  it('tidies a title to one line of at most 200 characters', () => {
    const title = scan(
      JSON.stringify({ type: 'custom-title', customTitle: `SENTINEL_A\n\n  b ${'c'.repeat(300)}` }),
    ).title!;
    expect(title.startsWith('SENTINEL_A b ccc')).toBe(true);
    expect(title).toHaveLength(200);
  });

  it('is not confused by a type or a message id named like an object property', () => {
    const result = scan(
      JSON.stringify({ type: '__proto__', summary: 'SENTINEL_TITLE_x' }),
      JSON.stringify({ type: 'constructor', summary: 'SENTINEL_TITLE_y' }),
      assistantLine({ id: '__proto__', req: 'toString', at: '2026-10-20T10:00:05Z' }),
    );
    expect(result.title).toBeNull();
    expect([...result.events.keys()]).toEqual(['__proto__:toString']);
  });

  it('reports the span of its events and the model of the latest', () => {
    expect(scan(userLine('2026-10-20T10:00:00Z')).eventSpan()).toBeNull();
    const span = scan(
      assistantLine({ id: 'm2', at: '2026-10-20T10:00:09Z', model: 'claude-opus-4-1' }),
      assistantLine({ id: 'm1', at: '2026-10-20T10:00:05Z', model: 'claude-sonnet-4-5' }),
    ).eventSpan();
    expect(span).toEqual({
      first: Date.parse('2026-10-20T10:00:05Z'),
      last: Date.parse('2026-10-20T10:00:09Z'),
      lastModel: 'claude-opus-4-1',
    });
  });

  // ---- the oracle's rules (docs/implementation/ccusage-rules.md) --------------------------------------------------------------

  const line = (
    patch: Record<string, unknown>,
    base: Message = { id: 'm1', at: '2026-10-20T10:00:05Z' },
  ): string => JSON.stringify({ ...JSON.parse(assistantLine(base)), ...patch });

  it('[A2] keeps a line’s own sessionId for its key only: the event belongs to the file, whatever the line names', () => {
    // two requestless lines for the same issued message id, one naming another session: different keys, same file
    const result = new TranscriptScan('file-session');
    result.add(
      JSON.stringify({
        ...JSON.parse(assistantLine({ id: 'msg_1', req: null, at: '2026-10-20T10:00:05Z' })),
        sessionId: 'sess-a',
      }),
    );
    result.add(assistantLine({ id: 'msg_1', req: null, at: '2026-10-20T10:00:06Z' }));
    expect([...result.events.keys()]).toEqual(['msg_1::sess-a', 'msg_1::file-session']);
  });

  it('[A3] has no request id? then the message id counts inside its session, and at one time when the id is not an issued one', () => {
    const issued = new TranscriptScan('file-session');
    issued.add(assistantLine({ id: 'msg_1', req: null, at: '2026-10-20T10:00:05Z' }));
    issued.add(assistantLine({ id: 'msg_1', req: null, at: '2026-10-20T10:00:09Z' })); // another block of the same message
    expect([...issued.events.keys()]).toEqual(['msg_1::file-session']);

    const gateway = new TranscriptScan('file-session');
    gateway.add(assistantLine({ id: 'placeholder', req: null, at: '2026-10-20T10:00:05Z' }));
    gateway.add(assistantLine({ id: 'placeholder', req: null, at: '2026-10-20T10:00:09Z' }));
    expect(gateway.events.size).toBe(2); // a gateway reuses one id for every response: the time tells them apart

    const named = new TranscriptScan('file-session');
    named.add(line({ sessionId: 'other' }, { id: 'msg_1', at: '2026-10-20T10:00:05Z' }));
    named.add(
      JSON.stringify({
        ...JSON.parse(assistantLine({ id: 'msg_1', req: null, at: '2026-10-20T10:00:05Z' })),
        sessionId: 'other',
      }),
    );
    expect([...named.events.keys()]).toEqual(['msg_1:req_msg_1', 'msg_1::other']);
  });

  it('[A3] counts a usage line with no message id, by what it holds', () => {
    const result = scan(
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-10-20T10:00:05Z',
        message: { model: 'm', usage: { input_tokens: 3, output_tokens: 4 } },
      }),
    );
    expect(result.unreadable).toBe(0);
    expect([...result.events.values()].map((e) => e.total)).toEqual([7]);
  });

  it('[A4] lets a main-thread line beat a sidechain one however the totals compare, then the larger total, then a speed', () => {
    const result = scan(
      line({ isSidechain: true }, { id: 'm1', at: '2026-10-20T10:00:05Z', output: 90 }),
      line({ isSidechain: false }, { id: 'm1', at: '2026-10-20T10:00:06Z', output: 3 }),
    );
    expect(result.events.get('m1:req_m1')).toMatchObject({ output: 3, sidechain: false });
    const speedy = JSON.parse(
      assistantLine({ id: 'm2', at: '2026-10-20T10:00:05Z', output: 4 }),
    ) as {
      message: { usage: Record<string, unknown> };
    };
    const slow = assistantLine({ id: 'm2', at: '2026-10-20T10:00:06Z', output: 4 });
    speedy.message.usage.speed = 'fast';
    const tie = scan(slow, JSON.stringify(speedy));
    expect(tie.events.get('m2:req_m2')).toMatchObject({ hasSpeed: true });
  });

  it('[A6] counts each advisor_message iteration as one more entry with its own usage and model, and nothing for any other iteration', () => {
    const withIterations = JSON.parse(
      assistantLine({ id: 'm1', at: '2026-10-20T10:00:05Z', input: 2, output: 3 }),
    ) as {
      message: { usage: Record<string, unknown> };
    };
    withIterations.message.usage.iterations = [
      { type: 'message', model: null, input_tokens: 2, output_tokens: 3 },
      {
        type: 'advisor_message',
        model: 'claude-advisor',
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 100,
      },
      { type: 'advisor_message', model: '', input_tokens: 99, output_tokens: 99 },
    ];
    const result = scan(JSON.stringify(withIterations));
    expect([...result.events.keys()]).toEqual(['m1:req_m1', 'm1:advisor:1:req_m1']);
    expect(result.events.get('m1:advisor:1:req_m1')).toMatchObject({
      model: 'claude-advisor',
      input: 10,
      cacheRead: 100,
      output: 5,
      total: 115,
    });
  });

  it('[A7] does not count a line with an empty id, session or model, or a version that is not one, and does not call it damage', () => {
    const result = scan(
      line({ sessionId: '' }),
      line({ requestId: '' }),
      line({ version: 'next' }),
      JSON.stringify({ ...JSON.parse(assistantLine({ id: '', at: '2026-10-20T10:00:05Z' })) }),
      line({ version: '2.0.5' }, { id: 'ok', at: '2026-10-20T10:00:05Z' }),
    );
    expect(result.unreadable).toBe(0);
    expect([...result.events.keys()]).toEqual(['ok:req_ok']);
  });
});
