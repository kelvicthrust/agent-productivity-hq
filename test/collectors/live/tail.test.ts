import { appendFileSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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

// Reading the end of a file in memory: the first sight reads a window of the end, afterwards only what was appended, and a file that was
// replaced or fell far behind is read from its end again. Real files in a temp folder, no mocks.

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'live-tail-'));
  file = join(dir, 'session.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Read {
  lines: string[];
  overlong: number[];
  starts: { reset: boolean; skipped: boolean }[];
  state: TailState | null;
  reset: boolean | null;
}

/** Reads `file` as the feed would: the listing's size and time, the state kept from before. `order` records overlongs between lines. */
async function read(prior: TailState | null, signal = new AbortController().signal): Promise<Read> {
  const info = statSync(file);
  const out: Read = { lines: [], overlong: [], starts: [], state: prior, reset: null };
  const order: string[] = [];
  const outcome = await tailFile(
    { path: file, size: info.size, mtimeMs: Math.trunc(info.mtimeMs) },
    prior,
    {
      begin: (start) => void out.starts.push(start),
      line: (text) => {
        out.lines.push(text);
        order.push('line');
      },
      overlong: () => {
        out.overlong.push(order.length);
        order.push('overlong');
      },
    },
    signal,
  );
  if (outcome !== null) {
    out.state = outcome.state;
    out.reset = outcome.reset;
  }
  return out;
}

const numbered = (from: number, to: number, pad = 0): string =>
  Array.from({ length: to - from + 1 }, (_, i) => `{"n":${from + i}${' '.repeat(pad)}}`).join(
    '\n',
  ) + '\n';

/** A file's mtime moved on, so `planRead` sees it as changed even when the size did not. */
const touch = (seconds: number) =>
  utimesSync(file, new Date(), new Date(Date.now() + seconds * 1000));

describe('the first sight', () => {
  it('reads a short file from its start', async () => {
    writeFileSync(file, numbered(1, 3));
    const result = await read(null);
    expect(result.lines).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
    expect(result.starts).toEqual([{ reset: true, skipped: false }]);
    expect(result.state?.offset).toBe(statSync(file).size);
  });

  it('reads only a window of the end of a long file, and discards the first, partial, line', async () => {
    const body = numbered(1, 40_000, 10); // far more than the window
    writeFileSync(file, body);
    expect(Buffer.byteLength(body)).toBeGreaterThan(TAIL_WINDOW_BYTES * 2);
    const result = await read(null);
    const first = Number(/"n":(\d+)/.exec(result.lines[0] ?? '')?.[1]);
    expect(first).toBeGreaterThan(1);
    expect(result.lines.at(-1)).toContain('"n":40000');
    // Every line handed over is whole JSON.
    for (const text of result.lines) expect(() => JSON.parse(text)).not.toThrow();
    // About a window was read, not the file.
    const bytes = result.lines.reduce((sum, text) => sum + text.length + 1, 0);
    expect(bytes).toBeLessThanOrEqual(TAIL_WINDOW_BYTES);
    expect(bytes).toBeGreaterThan(TAIL_WINDOW_BYTES - 200);
  });

  it('an empty file is followed and read as nothing', async () => {
    writeFileSync(file, '');
    const result = await read(null);
    expect(result.lines).toEqual([]);
    expect(result.state).toMatchObject({ offset: 0, size: 0 });
  });

  it('keeps the first complete record when the cut line has no text left', async () => {
    const template = '{"n":2,"output":""}\n';
    const complete = template.replace(
      '""',
      `"${'x'.repeat(TAIL_WINDOW_BYTES - template.length - 1)}"`,
    );
    writeFileSync(file, `${numbered(1, 1)}${complete}`);

    const result = await read(null);
    expect(result.lines.map((line) => JSON.parse(line).n)).toEqual([2]);
    expect(result.state?.offset).toBe(statSync(file).size);
  });
});

describe('afterwards', () => {
  it('reads nothing when the file is as it was', async () => {
    writeFileSync(file, numbered(1, 2));
    const first = await read(null);
    const again = await read(first.state);
    expect(again.starts).toEqual([]);
    expect(again.lines).toEqual([]);
    expect(again.reset).toBeNull();
  });

  it('reads only what was appended', async () => {
    writeFileSync(file, numbered(1, 2));
    const first = await read(null);
    appendFileSync(file, numbered(3, 4));
    const second = await read(first.state);
    expect(second.lines).toEqual(['{"n":3}', '{"n":4}']);
    expect(second.starts).toEqual([{ reset: false, skipped: false }]);
    expect(second.reset).toBe(false);
  });

  it('takes a trailing line with no newline only when it is complete', async () => {
    writeFileSync(file, `${numbered(1, 1)}{"n":2`);
    const first = await read(null);
    expect(first.lines).toEqual(['{"n":1}']);
    expect(first.state?.offset).toBe(Buffer.byteLength(numbered(1, 1)));
    // Completed (still without a newline): handed over now.
    appendFileSync(file, '}');
    const second = await read(first.state);
    expect(second.lines).toEqual(['{"n":2}']);
    // The next line arrives whole: no duplicate.
    appendFileSync(file, `\n${numbered(3, 3)}`);
    const third = await read(second.state);
    expect(third.lines).toEqual(['{"n":3}']);
  });

  it('keeps reading a partial line across reads until it is finished, and never hands over half of it', async () => {
    writeFileSync(file, '{"n":1');
    const first = await read(null);
    expect(first.lines).toEqual([]);
    appendFileSync(file, ',"more":2}\n');
    const second = await read(first.state);
    expect(second.lines).toEqual(['{"n":1,"more":2}']);
  });
});

describe('a file that changed under the reader', () => {
  it('a file that is now shorter was replaced: read again, the session starts over', async () => {
    writeFileSync(file, numbered(1, 50));
    const first = await read(null);
    writeFileSync(file, numbered(100, 101));
    const second = await read(first.state);
    expect(second.lines).toEqual(['{"n":100}', '{"n":101}']);
    expect(second.reset).toBe(true);
    expect(second.starts).toEqual([{ reset: true, skipped: false }]);
  });

  it('a file whose first bytes changed was replaced, even when it is longer', async () => {
    writeFileSync(file, numbered(1, 3));
    const first = await read(null);
    writeFileSync(file, numbered(500, 520));
    const second = await read(first.state);
    expect(second.reset).toBe(true);
    expect(second.lines[0]).toBe('{"n":500}');
  });

  it('a file that grew past the catch-up bound is read from its end: the session carries on, told lines were skipped', async () => {
    writeFileSync(file, numbered(1, 2));
    const first = await read(null);
    appendFileSync(file, numbered(10, 60_000, 60)); // more than RESYNC_BEHIND_BYTES
    expect(statSync(file).size - (first.state?.size ?? 0)).toBeGreaterThan(RESYNC_BEHIND_BYTES);
    const second = await read(first.state);
    expect(second.starts).toEqual([{ reset: false, skipped: true }]);
    expect(second.reset).toBe(false);
    expect(second.lines.at(-1)).toContain('"n":60000');
    expect(second.lines.length).toBeLessThan(5_000);
  });
});

describe('bounds', () => {
  it('stops after the per-tick byte limit and carries on from there next tick, even though the file did not change', async () => {
    writeFileSync(file, numbered(1, 2));
    const first = await read(null);
    const line = `{"pad":"${'x'.repeat(2_000)}"}\n`;
    const count = Math.ceil((MAX_BYTES_PER_FILE_PER_TICK * 2) / line.length);
    appendFileSync(file, line.repeat(count));
    expect(Buffer.byteLength(line) * count).toBeLessThan(RESYNC_BEHIND_BYTES);
    const second = await read(first.state);
    expect(second.lines.length).toBeLessThan(count);
    expect(second.lines.length).toBeGreaterThan(0);
    const third = await read(second.state);
    expect(second.lines.length + third.lines.length).toBeLessThanOrEqual(count);
    const fourth = await read(third.state);
    expect(second.lines.length + third.lines.length + fourth.lines.length).toBe(count);
    expect((await read(fourth.state)).lines).toEqual([]);
  });

  it('counts dropped lines against the per-tick byte limit', async () => {
    writeFileSync(file, numbered(1, 1));
    const first = await read(null);
    const overlong = `{"pad":"${'x'.repeat(LIVE_MAX_LINE_BYTES)}"}\n`;
    appendFileSync(file, overlong.repeat(3) + numbered(2, 2));

    const second = await read(first.state);
    expect(second.overlong).toHaveLength(2);
    expect(second.lines).toEqual([]);

    const third = await read(second.state);
    expect(third.overlong).toHaveLength(1);
    expect(third.lines).toEqual(['{"n":2}']);
  });

  it('drops a line longer than the limit without holding it, and says so before the next line', async () => {
    writeFileSync(file, numbered(1, 1));
    const first = await read(null);
    const huge = `{"pad":"${'y'.repeat(LIVE_MAX_LINE_BYTES + 10)}"}\n`;
    appendFileSync(file, numbered(2, 2) + huge + numbered(3, 3));
    const second = await read(first.state);
    expect(second.lines).toEqual(['{"n":2}', '{"n":3}']);
    // Told once, after the first line and before the second: where the long line was.
    expect(second.overlong).toEqual([1]);
    // And not again.
    expect((await read(second.state)).overlong).toEqual([]);
  });

  it('a long line at the very end is reported after the last line', async () => {
    writeFileSync(file, numbered(1, 1));
    const first = await read(null);
    appendFileSync(file, numbered(2, 2) + `{"pad":"${'y'.repeat(LIVE_MAX_LINE_BYTES + 10)}"}\n`);
    const second = await read(first.state);
    expect(second.lines).toEqual(['{"n":2}']);
    expect(second.overlong).toEqual([1]);
  });
});

describe('errors and abort', () => {
  it('rejects with ENOENT for a file that has gone (and says nothing of its path)', async () => {
    writeFileSync(file, numbered(1, 1));
    const first = await read(null);
    rmSync(file);
    await expect(
      tailFile(
        { path: file, size: first.state?.size ?? 0, mtimeMs: 1 },
        first.state,
        { begin: () => undefined, line: () => undefined, overlong: () => undefined },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stops reading when the signal aborts', async () => {
    writeFileSync(file, numbered(1, 100));
    const controller = new AbortController();
    controller.abort();
    await expect(read(null, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('touching a file without changing it reads nothing new', async () => {
    writeFileSync(file, numbered(1, 2));
    const first = await read(null);
    touch(5);
    const again = await read(first.state);
    expect(again.lines).toEqual([]);
    expect(again.reset).toBe(false);
  });
});
