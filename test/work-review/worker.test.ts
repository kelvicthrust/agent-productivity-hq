import { describe, expect, it, vi } from 'vitest';
import { createWorkReviewWorker } from '../../src/server/services/work-review/worker.ts';

const input = {
  date: '2026-11-24',
  title: 'Example work',
  turns: [
    {
      role: 'user' as const,
      text: 'Please simplify the report controls before we share the prototype.',
    },
    {
      role: 'assistant' as const,
      text: 'I removed three duplicate filters and verified the report.',
    },
  ],
};
const summary = {
  startDate: '2026-11-23',
  endDate: '2026-11-24',
  items: [
    { id: 'a', kind: 'shipped' as const, text: 'Report filters', group: 'report' },
    {
      id: 'b',
      kind: 'progress' as const,
      text: 'I tried a clearer filter layout.',
      group: 'report',
    },
  ],
};
const signal = new AbortController().signal;

describe('Work Review model output', () => {
  it('passes only approved text fields and accepts short progress and open notes', async () => {
    const notes = [
      { kind: 'progress', text: 'I simplified reporting by consolidating the filters.' },
      { kind: 'open', text: 'I still need to share the prototype.' },
    ];
    const runModel = vi.fn(async () => JSON.stringify({ notes }));
    const worker = createWorkReviewWorker({ runModel });
    const credential = 'sk-proj-' + 'A'.repeat(36);
    const result = await worker.extract(
      {
        ...input,
        turns: [
          ...input.turns,
          { role: 'assistant', text: `Use the token ${credential} when publishing.` },
        ],
      },
      signal,
    );
    expect(result).toEqual(notes);
    const call = runModel.mock.calls[0];
    expect(JSON.stringify(call)).not.toContain(credential);
    expect(JSON.stringify(call)).toContain('simplify the report controls');
  });

  it.each([
    { kind: 'progress', text: input.turns[1]?.text ?? '' },
    {
      kind: 'progress',
      text: 'I agreed to simplify the report controls before we share the prototype.',
    },
    { kind: 'open', text: 'I should use sk-' + 'z'.repeat(32) + '.' },
    { kind: 'shipped', text: 'I merged the report.' },
  ])('rejects copied, credential-bearing or misclassified notes', async (note) => {
    const worker = createWorkReviewWorker({
      runModel: async () => JSON.stringify({ notes: [note] }),
    });
    await expect(worker.extract(input, signal)).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it('checks summary references against the supplied item and category', async () => {
    const result = {
      headline: 'I made the reporting workflow clearer.',
      ids: ['a', 'b'],
      bullets: [{ kind: 'shipped', text: 'I simplified report filters.', ids: ['a'] }],
    };
    const runModel = vi.fn(async () => JSON.stringify(result));
    const worker = createWorkReviewWorker({ runModel });
    await expect(worker.summarize(summary, signal)).resolves.toEqual(result);
    runModel.mockResolvedValueOnce(
      JSON.stringify({
        ...result,
        bullets: [{ kind: 'shipped', text: 'I simplified report filters.', ids: ['b'] }],
      }),
    );
    await expect(worker.summarize(summary, signal)).rejects.toMatchObject({
      code: 'invalid_output',
    });
    runModel.mockResolvedValueOnce(JSON.stringify({ ...result, ids: ['invented'] }));
    await expect(worker.summarize(summary, signal)).rejects.toMatchObject({
      code: 'invalid_output',
    });
  });

  it('allows cautious topic evidence from a recorded title alone', async () => {
    const notes = [{ kind: 'progress', text: 'I focused on reporting for narrow screens.' }];
    const runModel = vi.fn(async () => JSON.stringify({ notes }));
    const worker = createWorkReviewWorker({ runModel });
    const titleOnly = { date: input.date, title: 'Mobile report layout', turns: [] };
    await expect(worker.extract(titleOnly, signal)).resolves.toEqual(notes);
    runModel.mockResolvedValueOnce(
      JSON.stringify({
        notes: [{ kind: 'open', text: 'I still need to complete mobile reports.' }],
      }),
    );
    await expect(worker.extract(titleOnly, signal)).rejects.toMatchObject({
      code: 'invalid_output',
    });
  });

  it('withholds team PRs from a personal summary prompt', async () => {
    const runModel = vi.fn(async () =>
      JSON.stringify({ headline: 'I improved the report builder.', ids: ['a'], bullets: [] }),
    );
    const worker = createWorkReviewWorker({ runModel });
    await worker.summarize(
      {
        ...summary,
        items: [
          ...summary.items,
          { id: 'c', kind: 'team', text: 'Team contribution', group: 'report' },
        ],
      },
      signal,
    );
    expect(JSON.stringify(runModel.mock.calls[0])).not.toContain('Team contribution');
  });

  it('keeps oversized or cancelled input out of the worker', async () => {
    const runModel = vi.fn(async () => '{"notes":[]}');
    const worker = createWorkReviewWorker({ runModel });
    const tooLarge = { ...input, turns: [{ role: 'user' as const, text: 'x'.repeat(300_000) }] };
    await expect(worker.extract(tooLarge, signal)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(worker.extract(input, AbortSignal.abort())).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(runModel).not.toHaveBeenCalled();
  });
});
