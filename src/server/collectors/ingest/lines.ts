import { createReadStream } from 'node:fs';
import { setImmediate as nextTurn } from 'node:timers/promises';

// A bounded reader for the line-delimited files the adapters import (Codex rollouts, Claude Code transcripts).
//
//  - It never holds a whole file: it keeps the current line only, so a 500 MB transcript costs what its longest line costs.
//  - A line longer than MAX_LINE_BYTES is dropped and counted (`overlong`), not kept and not an error, so one runaway tool
//    result cannot exhaust memory. The reader never keeps or reports the text of a line it drops.
//  - After every YIELD_EVERY_LINES lines it gives the event loop a turn, so the server keeps answering requests (and the 1-second
//    poll of the run) while a first import of years of history is going on (TECH › Performance).
//  - It tells the caller where it got to (`endOffset`: the byte after the last complete line it handed over), so the caller can
//    store that and read only what was appended next time. A last line without its newline is handed over only when it is
//    complete JSON; otherwise it is left for the next read, because the provider may still be writing it.
//  - It reads bytes and splits on 0x0A before decoding, so a multi-byte character that straddles two chunks is never cut.
// Errors raised here come from the file system and carry no file content.

export const MAX_LINE_BYTES = 16 * 1024 * 1024;
export const YIELD_EVERY_LINES = 500;

const NEWLINE = 0x0a;

/** The bytes of a file from `from`, in chunks. A missing or unreadable file rejects with the file system's own error. */
export function fileChunks(path: string, from = 0): AsyncIterable<Buffer> {
  return createReadStream(path, { start: from, highWaterMark: 256 * 1024 });
}

export interface LineReaderOptions {
  /** The byte offset the chunks start at in the original file, so `endOffset` is a position in that file. Default 0. */
  from?: number;
  maxLineBytes?: number;
  yieldEvery?: number;
  /**
   * Opt-in budget: stop between lines once at least this many bytes (from `from`) have been consumed by complete lines, whether each
   * was handed over, dropped for its length or empty. A line in progress is finished first. Unset (the batch importers): no budget.
   */
  stopAfterBytes?: number;
}

export class LineReader {
  readonly #chunks: AsyncIterable<Uint8Array>;
  readonly #max: number;
  readonly #yieldEvery: number;
  readonly #from: number;
  readonly #stopAfter: number | undefined;
  #end: number;
  #overlong = 0;
  #lines = 0;

  constructor(chunks: AsyncIterable<Uint8Array>, options: LineReaderOptions = {}) {
    this.#chunks = chunks;
    this.#from = options.from ?? 0;
    this.#stopAfter = options.stopAfterBytes;
    this.#end = this.#from;
    this.#max = options.maxLineBytes ?? MAX_LINE_BYTES;
    this.#yieldEvery = options.yieldEvery ?? YIELD_EVERY_LINES;
  }

  /** The byte after the last complete line handed over (or skipped as empty or overlong). Final once `lines()` has finished. */
  get endOffset(): number {
    return this.#end;
  }

  /** Lines dropped for being longer than the limit. Each one is an unreadable line for the caller's tally. */
  get overlong(): number {
    return this.#overlong;
  }

  /** Non-empty lines handed over so far. */
  get lineCount(): number {
    return this.#lines;
  }

  /** Each non-empty line, without its line ending. */
  async *lines(): AsyncGenerator<string, void, undefined> {
    let parts: Buffer[] = [];
    let length = 0; // bytes of the current line so far, dropped or not
    let dropping = false;
    let seen = 0;
    let first = true;

    for await (const chunk of this.#chunks) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      let start = 0;
      for (;;) {
        const newline = buffer.indexOf(NEWLINE, start);
        if (newline === -1) {
          const rest = buffer.subarray(start);
          length += rest.length;
          if (!dropping) {
            if (length > this.#max) {
              dropping = true;
              parts = [];
            } else if (rest.length > 0) parts.push(rest);
          }
          break;
        }
        const piece = buffer.subarray(start, newline);
        const total = length + piece.length;
        const lineEnd = this.#end + total + 1;
        let text: string | null = null;
        if (dropping || total > this.#max) {
          this.#overlong += 1;
        } else {
          text = (parts.length === 0 ? piece : Buffer.concat([...parts, piece])).toString('utf8');
          if (first && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
          if (text.endsWith('\r')) text = text.slice(0, -1);
        }
        first = false;
        parts = [];
        length = 0;
        dropping = false;
        start = newline + 1;
        this.#end = lineEnd;
        if (text !== null && text.trim() !== '') {
          this.#lines += 1;
          yield text;
        }
        seen += 1;
        if (seen % this.#yieldEvery === 0) await nextTurn();
        if (this.#stopAfter !== undefined && this.#end - this.#from >= this.#stopAfter) return;
      }
    }

    // A tail with no newline: complete JSON means the writer finished it; anything else is left for the next read.
    if (length > 0 && !dropping) {
      const text = Buffer.concat(parts).toString('utf8').replace(/\r$/, '');
      if (text.trim() !== '' && isCompleteJson(text)) {
        this.#end += length;
        this.#lines += 1;
        yield text;
      }
    }
  }
}

function isCompleteJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false; // never keep the parser's message: it quotes the text
  }
}

/**
 * One line as a JSON object, or null when it is not one. The parser's error is dropped on purpose: its message quotes the
 * line, and a line can hold a prompt or a secret (P-31).
 */
export function parseJsonLine(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
