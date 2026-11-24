import { createHash } from 'node:crypto';
import { appendFileSync, linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  readWorkReviewTurns,
  type ReviewTranscript,
} from '../../../src/server/collectors/work-review/transcript.ts';
import { tempDir } from '../helpers.ts';

const begin = '2026-11-03T08:00:00.000Z';
const inside = '2026-11-04T07:30:00.000Z';
const end = '2026-11-04T08:00:00.000Z';
const signal = () => new AbortController().signal;

function tracked(path: string, lines: unknown[], compressed = false) {
  const plain = Buffer.from(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  const file = compressed ? zstdCompressSync(plain) : plain;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, file);
  return {
    path,
    size: file.length,
    offset: plain.length,
    head: createHash('sha256').update(file.subarray(0, 4096)).digest('hex'),
    partial: false,
  };
}

function codex(role: 'user' | 'assistant' | 'developer', text: string, timestamp = inside) {
  return {
    timestamp,
    type: 'response_item',
    payload: {
      type: 'message',
      role,
      content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
    },
  };
}

const meta = (id: string) => ({ type: 'session_meta', payload: { id } });

describe('explicit Work Review text collection', () => {
  it.each([false, true])(
    'reads bounded same-day Codex turns through the imported prefix (compressed=%s)',
    async (compressed) => {
      const home = tempDir();
      const file = tracked(
        join(home, '.codex', 'sessions', 'rollout.jsonl' + (compressed ? '.zst' : '')),
        [
          meta('thread-1'),
          meta('replayed-parent-thread'),
          codex('user', 'PREVIOUS_DAY', '2026-11-03T07:59:59.000Z'),
          codex('user', '# AGENTS.md instructions for /project\nPRIVATE_PROJECT_INSTRUCTIONS'),
          codex('developer', 'PRIVATE_CONTEXT'),
          codex('user', 'Refactor the inbound record parser.'),
          codex(
            'assistant',
            'The parser now accepts the optional field.\nGITHUB_TOKEN=PRIVATE_CREDENTIAL',
          ),
          {
            timestamp: inside,
            type: 'response_item',
            payload: { type: 'function_call_output', output: 'TOOL_RESULT' },
          },
          codex('user', 'NEXT_DAY', end),
        ],
        compressed,
      );
      if (!compressed)
        appendFileSync(file.path, `${JSON.stringify(codex('user', 'NOT_IMPORTED'))}\n`);
      const transcript: ReviewTranscript = {
        provider: 'codex',
        providerSessionId: 'thread-1',
        fromMs: Date.parse(begin),
        toMs: Date.parse(end),
        files: [file],
      };
      expect(await readWorkReviewTurns({ transcript }, { home, env: {} }, signal())).toEqual({
        turns: [
          { role: 'user', text: 'Refactor the inbound record parser.' },
          { role: 'assistant', text: 'The parser now accepts the optional field.' },
        ],
        partial: false,
      });
    },
  );

  it('discards copied Claude turns, tool results, compacted summaries and other sessions', async () => {
    const home = tempDir();
    const user = (text: unknown, extra: object = {}) => ({
      timestamp: inside,
      sessionId: 'session-here',
      type: 'user',
      message: { role: 'user', content: text },
      ...extra,
    });
    const file = tracked(join(home, '.claude', 'projects', '-repo', 'session-here.jsonl'), [
      user('OFF_SCOPE', { sessionId: 'some-other-session' }),
      user('PROJECT_HOOK_PROMPT', { isMeta: true }),
      user('TRANSCRIPT_COMPACTION', { isCompactSummary: true }),
      user('CHILD_PROMPT', { isSidechain: true }),
      user(
        '-----BEGIN RSA PRIVATE KEY-----\nSYNTHETIC_MULTILINE_CREDENTIAL\n-----END RSA PRIVATE KEY-----',
      ),
      user([
        { type: 'tool_result', content: 'PRIVATE_COMMAND_RESULT' },
        { type: 'text', text: 'WRAPPER_TEXT' },
      ]),
      user('Research the format of stored snapshots.'),
      {
        timestamp: inside,
        sessionId: 'session-here',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'PRIVATE_THINKING' },
            { type: 'text', text: 'The latest snapshot records a single source.' },
          ],
        },
      },
    ]);
    const transcript: ReviewTranscript = {
      provider: 'claude',
      providerSessionId: 'session-here',
      fromMs: Date.parse(begin),
      toMs: Date.parse(end),
      files: [file],
    };
    expect(await readWorkReviewTurns({ transcript }, { home, env: {} }, signal())).toEqual({
      turns: [
        { role: 'user', text: 'Research the format of stored snapshots.' },
        { role: 'assistant', text: 'The latest snapshot records a single source.' },
      ],
      partial: false,
    });
  });

  it('marks an overlong line as incomplete even when other excerpts were read', async () => {
    const home = tempDir();
    const file = tracked(join(home, '.codex', 'sessions', 'rollout.jsonl'), [
      meta('thread-1'),
      codex('user', 'Investigate saved exports.'),
      codex('assistant', 'x'.repeat(140 * 1024)),
    ]);
    expect(
      await readWorkReviewTurns(
        {
          transcript: {
            provider: 'codex',
            providerSessionId: 'thread-1',
            fromMs: Date.parse(begin),
            toMs: Date.parse(end),
            files: [file],
          },
        },
        { home, env: {} },
        signal(),
      ),
    ).toEqual({
      turns: [{ role: 'user', text: 'Investigate saved exports.' }],
      partial: true,
    });
  });

  it('refuses off-root, linked, expired and mismatched-day source candidates', async () => {
    const home = tempDir();
    const root = join(home, '.codex', 'sessions');
    const messages = [meta('thread-1'), codex('user', 'Sensitive off-scope content.')];
    const outside = tracked(join(home, 'outside', 'rollout.jsonl'), messages);
    const wrongSession = tracked(join(root, 'other.jsonl'), [meta('thread-2'), messages[1]]);
    const symlink = { ...outside, path: join(root, 'redirect.jsonl') };
    const hardlink = { ...outside, path: join(root, 'shared.jsonl') };
    symlinkSync(outside.path, symlink.path);
    linkSync(outside.path, hardlink.path);
    const transcript: ReviewTranscript = {
      provider: 'codex',
      providerSessionId: 'thread-1',
      fromMs: Date.parse(begin),
      toMs: Date.parse(end),
      files: [
        outside,
        wrongSession,
        symlink,
        hardlink,
        { ...outside, path: join(root, 'gone.jsonl') },
      ],
    };
    // The first four include all readable hostile sources. The missing file is checked directly as well.
    expect(await readWorkReviewTurns({ transcript }, { home, env: {} }, signal())).toEqual({
      turns: [],
      partial: true,
    });
    transcript.files = [transcript.files.at(-1)!];
    expect(await readWorkReviewTurns({ transcript }, { home, env: {} }, signal())).toEqual({
      turns: [],
      partial: true,
    });
  });
});
