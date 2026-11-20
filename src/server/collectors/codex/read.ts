import { createReadStream } from 'node:fs';
import type { Transform } from 'node:stream';
import { LineReader, fileChunks } from '../ingest/index.ts';
import { RolloutParser, type ParsedRollout } from './rollout.ts';

// Reading one rollout file into what it says. The whole file is read from byte 0 every time it is read: a Codex event is the
// difference between two cumulative snapshots, and the snapshot before the first new one is not stored, so an appended file
// cannot be resumed from an offset. Keep-mode dedupe (`session id : cumulative total`) makes the repeat cheap and exact.
//
// A `.jsonl.zst` is decoded as a stream and read from 0 as well; the offsets it reports are positions in the decoded text, not
// in the file, which is fine because they are never used to resume.

/** How to decode zstd. Node 26 has it in `node:zlib`; a Node without it gives null and `.zst` files are reported unsupported. */
export type ZstdDecoder = () => Transform;

async function* decodedChunks(path: string, decoder: ZstdDecoder): AsyncGenerator<Buffer> {
  const source = createReadStream(path, { highWaterMark: 256 * 1024 });
  const decode = decoder();
  // `pipe` does not pass a read error on to the decoder; this does, so a file that fails to open or read rejects the loop below.
  source.on('error', (error) => decode.destroy(error));
  source.pipe(decode);
  try {
    for await (const chunk of decode) yield chunk as Buffer;
  } finally {
    source.destroy();
    decode.destroy();
  }
}

export interface RolloutRead {
  parsed: ParsedRollout;
  /** `LineReader.endOffset` of this read. */
  endOffset: number;
  /** Unreadable lines of the file: those the parser could not use plus lines the reader dropped for their length. */
  unreadableLines: number;
}

/**
 * Parses a rollout. Rejects with the file system's own error when the file cannot be read, or with the decoder's when a
 * `.zst` is damaged; neither carries any of the file's text.
 */
export async function readRollout(path: string, decoder: ZstdDecoder | null): Promise<RolloutRead> {
  const chunks = decoder ? decodedChunks(path, decoder) : fileChunks(path, 0);
  const reader = new LineReader(chunks, { from: 0 });
  const parser = new RolloutParser();
  for await (const line of reader.lines()) parser.push(line);
  const parsed = parser.finish();
  return {
    parsed,
    endOffset: reader.endOffset,
    unreadableLines: parsed.unreadable + reader.overlong,
  };
}
