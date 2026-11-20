import { mkdtempSync, rmSync, statSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TAIL_WINDOW_BYTES } from '../../../src/server/collectors/live/heuristics.ts';
import { tailFile, type TailState } from '../../../src/server/collectors/live/tail.ts';

// Where the first read of a file starts. Whether the window starts in the middle of a line is decided by the byte before it, never by
// what the first record looks like: a window starting exactly after a newline keeps its first line, one starting inside a line drops
// the rest of that line, one with no newline at all consumes nothing and waits. After every read the offset is the end of the last
// complete line consumed. Real files in a temp folder.

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'live-tail-window-'));
  file = join(dir, 'session.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function read(prior: TailState | null) {
  const info = statSync(file);
  const lines: string[] = [];
  const outcome = await tailFile(
    { path: file, size: info.size, mtimeMs: Math.trunc(info.mtimeMs) },
    prior,
    { begin: () => undefined, line: (text) => void lines.push(text), overlong: () => undefined },
    new AbortController().signal,
  );
  return { lines, state: outcome?.state ?? prior, size: info.size };
}

const ns = (lines: string[]): number[] =>
  lines.map((line) => (JSON.parse(line) as { n: number }).n);

/** One line of exactly `bytes` bytes (its line ending included), numbered `n`. */
function row(n: number, bytes: number, ending = '\n'): string {
  const base = `{"n":${n},"pad":""}${ending}`;
  return base.replace('""', `"${'x'.repeat(bytes - base.length)}"`);
}

/** Lines numbered from `first`, each 1000 bytes but the last, together exactly `total` bytes. */
function rows(first: number, total: number, ending = '\n'): string {
  const count = Math.floor(total / 1000);
  let out = '';
  for (let i = 0; i < count; i += 1)
    out += row(first + i, i === count - 1 ? total - 1000 * (count - 1) : 1000, ending);
  return out;
}

const WINDOW = TAIL_WINDOW_BYTES;

describe('a window that starts on a line', () => {
  it('keeps the first line when the byte before the window is a newline, and nothing is discarded', async () => {
    writeFileSync(file, row(0, 500) + rows(1, WINDOW));
    const { lines, state, size } = await read(null);
    expect(size).toBe(500 + WINDOW);
    expect(ns(lines)[0]).toBe(1);
    expect(ns(lines)).toEqual(Array.from({ length: ns(lines).length }, (_, i) => i + 1));
    expect(state?.offset).toBe(size);
    expect(state?.unaligned).toBeUndefined();
  });

  it('is at offset 0 for a file the window covers whole: the first line is kept', async () => {
    writeFileSync(file, rows(0, WINDOW - 10));
    const { lines, state, size } = await read(null);
    expect(ns(lines)[0]).toBe(0);
    expect(state?.offset).toBe(size);
  });

  it('keeps a file shorter than the window from its first line', async () => {
    writeFileSync(file, '{"n":0}\n{"n":1}\n');
    const { lines, state } = await read(null);
    expect(ns(lines)).toEqual([0, 1]);
    expect(state?.offset).toBe(16);
  });
});

describe('a window that starts inside a line', () => {
  it('drops the rest of that line and keeps the next one', async () => {
    writeFileSync(file, rows(0, WINDOW + 300));
    const { lines, state, size } = await read(null);
    expect(ns(lines)[0]).toBe(1);
    expect(state?.offset).toBe(size);
  });

  it('exactly on the newline that ends a line: that newline is the end of the cut line, the next line is kept', async () => {
    // The window starts at the newline of line 0 (the byte before it is part of line 0).
    const cut = row(0, 500, '').concat('\n');
    writeFileSync(file, cut + rows(1, WINDOW - 1));
    const { lines, state, size } = await read(null);
    expect(size).toBe(500 + WINDOW);
    expect(ns(lines)[0]).toBe(1);
    expect(state?.offset).toBe(size);
  });

  it('with CRLF line endings, and the lines handed over have no carriage return', async () => {
    writeFileSync(file, rows(0, WINDOW + 300, '\r\n'));
    const { lines, state, size } = await read(null);
    expect(ns(lines)[0]).toBe(1);
    expect(lines.every((line) => !line.endsWith('\r'))).toBe(true);
    expect(state?.offset).toBe(size);
  });

  it('when the first complete line is empty or only blanks, it is consumed and the first record is kept', async () => {
    writeFileSync(file, row(0, 500) + '   \r\n\n' + rows(1, WINDOW - 100 - 6));
    const { lines, state, size } = await read(null);
    expect(size).toBe(500 + WINDOW - 100);
    expect(ns(lines)[0]).toBe(1);
    expect(state?.offset).toBe(size);
  });

  it('ends at the last complete line when the file ends in an unfinished one', async () => {
    writeFileSync(file, rows(0, WINDOW + 300) + '{"n":99,"pa');
    const { lines, state, size } = await read(null);
    expect(ns(lines).at(-1)).not.toBe(99);
    expect(state?.offset).toBe(size - '{"n":99,"pa'.length);
  });
});

describe('a window with no newline at all', () => {
  it('consumes nothing and waits, then reads the line that follows once its newline is there', async () => {
    // One line longer than the window, still being written: the window is a piece of it.
    writeFileSync(file, `{"n":1,"pad":"${'x'.repeat(WINDOW + 1_000)}`);
    const first = await read(null);
    expect(first.lines).toEqual([]);
    expect(first.state).toMatchObject({ offset: first.size - WINDOW, unaligned: true });

    // Nothing changed: still nothing, same state.
    const again = await read(first.state);
    expect(again.lines).toEqual([]);
    expect(again.state?.offset).toBe(first.state?.offset);

    // The line is finished and another one follows: the finished line is the cut one, the next is read whole.
    appendFileSync(file, `"}\n${row(2, 300)}`);
    const next = await read(first.state);
    expect(ns(next.lines)).toEqual([2]);
    expect(next.state?.offset).toBe(next.size);
    expect(next.state?.unaligned).toBeUndefined();
  });
});

describe('sizes that are not what the file has', () => {
  async function readAs(size: number, prior: TailState | null) {
    const lines: string[] = [];
    const outcome = await tailFile(
      { path: file, size, mtimeMs: 1_000 },
      prior,
      { begin: () => undefined, line: (text) => void lines.push(text), overlong: () => undefined },
      new AbortController().signal,
    );
    return { lines, state: outcome?.state ?? prior };
  }

  it('a file truncated after it was listed is read to what is left, and the next look carries on from there', async () => {
    writeFileSync(file, rows(0, 5_000));
    const listedSize = statSync(file).size;
    writeFileSync(file, rows(100, 2_000)); // truncated and rewritten between the stat and the read
    const first = await readAs(listedSize, null);
    expect(first.state?.offset).toBeLessThanOrEqual(2_000);
    expect(ns(first.lines).length).toBeGreaterThan(0);
    // The next listing has the real size: nothing throws, and the state follows the file.
    const second = await read(first.state);
    expect(second.state?.offset).toBeLessThanOrEqual(second.size);
  });

  it('a size far larger than the file reads nothing, throws nothing, and the next honest listing starts the file over', async () => {
    writeFileSync(file, rows(0, 3_000));
    const result = await readAs(2 ** 40, null);
    expect(result.lines).toEqual([]);
    const next = await read(result.state); // the real size is below the offset it left: a replaced file
    expect(ns(next.lines)).toEqual([0, 1, 2]);
    expect(next.state?.offset).toBe(3_000);
  });
});
