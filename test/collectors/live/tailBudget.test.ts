import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LIVE_MAX_LINE_BYTES,
  MAX_BYTES_PER_FILE_PER_TICK,
  RESYNC_BEHIND_BYTES,
  TAIL_WINDOW_BYTES,
} from '../../../src/server/collectors/live/heuristics.ts';
import { tailFile, type TailState } from '../../../src/server/collectors/live/tail.ts';

// The per-tick byte limit counts every byte a read consumes: lines handed over, lines dropped for their length, empty lines, and the
// first-sight window. Real files in a temp folder.

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'live-tail-budget-'));
  file = join(dir, 'session.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function read(prior: TailState | null) {
  const info = statSync(file);
  const lines: string[] = [];
  let overlong = 0;
  const outcome = await tailFile(
    { path: file, size: info.size, mtimeMs: Math.trunc(info.mtimeMs) },
    prior,
    {
      begin: () => undefined,
      line: (text) => void lines.push(text),
      overlong: () => (overlong += 1),
    },
    new AbortController().signal,
  );
  return { lines, overlong, state: outcome?.state ?? prior, outcome };
}

/** Lines of whitespace only: the reader skips them without handing them over. */
const blank = (bytes: number): string => `${' '.repeat(1023)}\n`.repeat(Math.ceil(bytes / 1024));
/** Whole JSON lines of about a kilobyte. */
const filler = (bytes: number): string =>
  `{"pad":"${'x'.repeat(1013)}"}\n`.repeat(Math.ceil(bytes / 1024));

describe('the per-tick byte limit', () => {
  it('counts empty lines: a flood of them is read a limit at a time, not all at once', async () => {
    writeFileSync(file, '{"n":1}\n');
    const first = await read(null);
    appendFileSync(file, blank(MAX_BYTES_PER_FILE_PER_TICK * 2.5) + '{"n":2}\n');
    const size = statSync(file).size;
    expect(size - (first.state?.size ?? 0)).toBeLessThan(RESYNC_BEHIND_BYTES);

    const second = await read(first.state);
    expect(second.lines).toEqual([]);
    expect((second.state?.offset ?? 0) - (first.state?.offset ?? 0)).toBe(
      MAX_BYTES_PER_FILE_PER_TICK,
    );
    const third = await read(second.state);
    expect(third.lines).toEqual([]);
    expect((third.state?.offset ?? 0) - (second.state?.offset ?? 0)).toBe(
      MAX_BYTES_PER_FILE_PER_TICK,
    );
    const fourth = await read(third.state);
    expect(fourth.lines).toEqual(['{"n":2}']);
    expect(fourth.state?.offset).toBe(size);
  });

  it('counts a mix of dropped, empty and whole lines together', async () => {
    writeFileSync(file, '{"n":1}\n');
    const first = await read(null);
    const huge = `{"pad":"${'x'.repeat(LIVE_MAX_LINE_BYTES)}"}\n`;
    appendFileSync(file, huge + blank(300_000) + '{"n":2}\n' + huge + blank(300_000) + '{"n":3}\n');
    const second = await read(first.state);
    const third = await read(second.state);
    const fourth = await read(third.state);
    // Each read stops once it has consumed the limit, so none of them reaches the end of this much data.
    expect((second.state?.offset ?? 0) - (first.state?.offset ?? 0)).toBeLessThan(
      MAX_BYTES_PER_FILE_PER_TICK + Buffer.byteLength(huge),
    );
    expect(statSync(file).size).toBeGreaterThan(MAX_BYTES_PER_FILE_PER_TICK);
    expect(third.state?.offset).toBeGreaterThan(second.state?.offset ?? 0);
    expect([...second.lines, ...third.lines, ...fourth.lines]).toEqual(['{"n":2}', '{"n":3}']);
    expect(second.overlong + third.overlong + fourth.overlong).toBe(2);
  });

  it('a first sight reads at most the window, and ends at the end of the file', async () => {
    writeFileSync(file, filler(MAX_BYTES_PER_FILE_PER_TICK * 3) + '{"n":9}\n');
    const first = await read(null);
    expect(first.lines.at(-1)).toBe('{"n":9}');
    expect(first.lines.reduce((sum, text) => sum + text.length + 1, 0)).toBeLessThanOrEqual(
      TAIL_WINDOW_BYTES,
    );
    expect(first.state?.offset).toBe(statSync(file).size);
    expect(TAIL_WINDOW_BYTES).toBeLessThan(MAX_BYTES_PER_FILE_PER_TICK);
  });

  it('a file more than the catch-up bound behind is read from its window, not from where it was', async () => {
    writeFileSync(file, '{"n":1}\n');
    const first = await read(null);
    appendFileSync(file, filler(RESYNC_BEHIND_BYTES + 1024) + '{"n":2}\n');
    const second = await read(first.state);
    expect(second.outcome?.reset).toBe(false);
    expect(second.lines.at(-1)).toBe('{"n":2}');
    expect(second.lines.reduce((sum, text) => sum + text.length + 1, 0)).toBeLessThanOrEqual(
      TAIL_WINDOW_BYTES,
    );
    expect(second.state?.offset).toBe(statSync(file).size);
  });
});
