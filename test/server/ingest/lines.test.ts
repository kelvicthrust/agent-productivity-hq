import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LineReader,
  fileChunks,
  parseJsonLine,
} from '../../../src/server/collectors/ingest/lines.ts';

// The bounded line reader: lines come out whole whatever the chunking, the end offset is a position in the file a later read can
// start from, and nothing about a bad line (its text, the parser's message) is ever kept.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function* chunked(bytes: Buffer, size: number): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

async function readAll(reader: LineReader): Promise<string[]> {
  const out: string[] = [];
  for await (const line of reader.lines()) out.push(line);
  return out;
}

describe('LineReader', () => {
  const text = '{"a":1}\n{"b":"é✓"}\r\n\n   \n{"c":3}\n';

  it('yields every non-empty line, whatever the chunk size, and ends after the last newline', async () => {
    const bytes = Buffer.from(text);
    for (const size of [1, 2, 3, 7, 64, 4096]) {
      const reader = new LineReader(chunked(bytes, size));
      expect(await readAll(reader), `chunk ${size}`).toEqual(['{"a":1}', '{"b":"é✓"}', '{"c":3}']);
      expect(reader.endOffset).toBe(bytes.length);
      expect(reader.lineCount).toBe(3);
    }
  });

  it('never cuts a multi-byte character that straddles two chunks', async () => {
    const bytes = Buffer.from('{"k":"日本語"}\n');
    const reader = new LineReader(chunked(bytes, 5));
    expect(await readAll(reader)).toEqual(['{"k":"日本語"}']);
  });

  it('leaves an unfinished last line for the next read and reports where it starts', async () => {
    const bytes = Buffer.from('{"a":1}\n{"b":');
    const reader = new LineReader(chunked(bytes, 4));
    expect(await readAll(reader)).toEqual(['{"a":1}']);
    expect(reader.endOffset).toBe(Buffer.byteLength('{"a":1}\n'));
  });

  it('accepts a last line with no newline when it is complete JSON', async () => {
    const bytes = Buffer.from('{"a":1}\n{"b":2}');
    const reader = new LineReader(chunked(bytes, 3));
    expect(await readAll(reader)).toEqual(['{"a":1}', '{"b":2}']);
    expect(reader.endOffset).toBe(bytes.length);
  });

  it('counts positions from the offset the stream started at', async () => {
    const reader = new LineReader(chunked(Buffer.from('{"x":1}\n'), 100), { from: 1000 });
    await readAll(reader);
    expect(reader.endOffset).toBe(1000 + 8);
  });

  it('drops a line over the limit without keeping it, counts it, and goes on', async () => {
    const big = `{"p":"${'x'.repeat(300)}"}`;
    const bytes = Buffer.from(`{"a":1}\n${big}\n{"c":3}\n`);
    for (const size of [8, 50, 1000]) {
      const reader = new LineReader(chunked(bytes, size), { maxLineBytes: 100 });
      expect(await readAll(reader), `chunk ${size}`).toEqual(['{"a":1}', '{"c":3}']);
      expect(reader.overlong).toBe(1);
      expect(reader.endOffset).toBe(bytes.length);
    }
  });

  it('strips a byte-order mark and a carriage return', async () => {
    const reader = new LineReader(chunked(Buffer.from('﻿{"a":1}\r\n{"b":2}\r\n'), 6));
    expect(await readAll(reader)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('gives the event loop a turn every 500 lines, and not before', async () => {
    const lines = Array.from({ length: 1200 }, (_, i) => `{"i":${i}}`).join('\n') + '\n';
    let turned = false;
    setImmediate(() => (turned = true)); // a macrotask: it can only run when the reader lets the loop go round
    const reader = new LineReader(chunked(Buffer.from(lines), 1 << 20));
    let at = 0;
    let firstTurn = -1;
    for await (const line of reader.lines()) {
      at += 1;
      if (turned && firstTurn === -1) firstTurn = at;
      if (line.length === 0) throw new Error('an empty line was handed over');
    }
    expect(at).toBe(1200);
    expect(firstTurn).toBe(501); // the first 500 lines were read without the loop turning, the 501st after one turn
  });

  it('reads a real file from an offset, so only what was appended is read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-lines-'));
    dirs.push(dir);
    const path = join(dir, 'a.jsonl');
    writeFileSync(path, '{"a":1}\n{"b":2}\n');
    const first = new LineReader(fileChunks(path));
    expect(await readAll(first)).toHaveLength(2);
    writeFileSync(path, '{"a":1}\n{"b":2}\n{"c":3}\n');
    const second = new LineReader(fileChunks(path, first.endOffset), { from: first.endOffset });
    expect(await readAll(second)).toEqual(['{"c":3}']);
    expect(second.endOffset).toBe(Buffer.byteLength('{"a":1}\n{"b":2}\n{"c":3}\n'));
  });

  it('rejects with the file system error, which carries a code and no content', async () => {
    const reader = new LineReader(fileChunks('/definitely/not/here.jsonl'));
    await expect(readAll(reader)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('parseJsonLine', () => {
  it('returns an object, and null for everything else without throwing', () => {
    expect(parseJsonLine('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLine('[1,2]')).toBeNull();
    expect(parseJsonLine('"text"')).toBeNull();
    expect(parseJsonLine('null')).toBeNull();
    expect(parseJsonLine('{"a": SENTINEL_PROMPT_leak')).toBeNull();
  });
});
