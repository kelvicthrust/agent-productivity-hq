import { createHash } from 'node:crypto';
import { realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createZstdDecompress } from 'node:zlib';
import type { Provider } from '../../../shared/contracts/common.ts';
import { abortError } from '../../lib/abortable.ts';
import { redactString, REDACTED } from '../../lib/logger.ts';
import { classifyTranscript, type Transcript } from '../claude/files.ts';
import { claudeConfigDirs, codexHomes, type DiscoveryInput } from '../discovery.ts';
import {
  HEAD_BYTES,
  LineReader,
  asRecord,
  parseJsonLine,
  parseTimestamp,
} from '../ingest/index.ts';
import { openWithin, statWithin } from '../live/confined.ts';

export interface ReviewTranscriptFile {
  path: string;
  /** Physical file size and fingerprint recorded in the last import. */
  size: number;
  head: string;
  /** End of the last imported line. A compressed rollout's offset is in decoded bytes. */
  offset: number;
  partial: boolean;
}

export interface ReviewTranscript {
  provider: Provider;
  providerSessionId: string;
  fromMs: number;
  toMs: number;
  files: (ReviewTranscriptFile | null)[];
}

export interface WorkReviewTurn {
  role: 'user' | 'assistant';
  text: string;
}

const MAX_FILES = 4;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_LINE_BYTES = 128 * 1024;
const MAX_TURNS_PER_ROLE = 4;
const PROVIDER_CONTEXT =
  /<(?:environment_context|user_instructions|developer_instructions|system_instructions|project_instructions|agents_md|system-reminder|local-command-(?:stdout|stderr|caveat)|command-(?:name|message|args)|subagent_notification|user_action|turn_aborted)\b|(?:^|\n)\s*#\s+AGENTS\.md instructions for\b|\[Request interrupted by user/i;
const PRIVATE_KEY = /-----BEGIN [^-\n]*PRIVATE KEY-----/i;
const CREDENTIAL_MATERIAL =
  /\b[A-Z0-9_-]*(?:API[-_]?KEY|PASSWORD|PASSWD|TOKEN|SECRET|AUTHORIZATION|COOKIE|CREDENTIAL)[A-Z0-9_-]*["'\x60*]*\s*[:=]\s*\S|\b(?:BASIC|BEARER)\s+[A-Za-z0-9._~+/=-]{6,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:sk_(?:live|test)_|xox[baprs]-)[A-Za-z0-9-]{8,}|\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@]+@/i;

/** Project or command context is ineligible. Redact recognizable credentials before bounding the remaining text. */
export function cleanReviewText(value: unknown): string | null {
  if (typeof value !== 'string' || PROVIDER_CONTEXT.test(value) || PRIVATE_KEY.test(value))
    return null;
  const text = value
    .replace(/\x60{3}[\s\S]*?(?:\x60{3}|$)/g, ' ')
    .split(/\r?\n/)
    .filter((line) => !CREDENTIAL_MATERIAL.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '' || CREDENTIAL_MATERIAL.test(text)) return null;
  const safe = redactString(text);
  return safe === REDACTED ? null : safe;
}

interface SourceLocation {
  root: string;
  claude: Transcript | null;
  compressed: boolean;
}

function sourceLocation(
  unit: ReviewTranscript,
  path: string,
  roots: readonly string[],
): SourceLocation | null {
  for (const root of roots) {
    const rel = relative(root, path);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    if (unit.provider === 'claude') {
      const claude = classifyTranscript(rel.split(sep).join('/'));
      if (claude?.sessionId === unit.providerSessionId) return { root, claude, compressed: false };
    } else if (/\.jsonl(?:\.zst)?$/.test(rel)) {
      return { root, claude: null, compressed: rel.endsWith('.zst') };
    }
  }
  return null;
}

function textParts(content: unknown, type: string): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const raw of content) {
    const block = asRecord(raw);
    if (block?.['type'] === 'tool_result') return null;
    if (block?.['type'] === type && typeof block['text'] === 'string') parts.push(block['text']);
  }
  return parts.join('\n');
}

function claudeTurn(line: Record<string, unknown>, file: Transcript): WorkReviewTurn | null {
  const role = line['type'];
  if (role !== 'user' && role !== 'assistant') return null;
  if (
    line['isMeta'] === true ||
    line['isCompactSummary'] === true ||
    line['isVisibleInTranscriptOnly'] === true ||
    line['isApiErrorMessage'] === true ||
    line['interruptedMessageId'] !== undefined
  )
    return null;
  if (file.kind === 'main') {
    // Resumed transcripts may contain copied turns whose sessionId still names a different source.
    if (
      line['sessionId'] !== file.sessionId ||
      line['isSidechain'] === true ||
      line['agentId'] != null
    )
      return null;
  } else {
    const agent = file.sessionId.slice(file.parentId.length + 1);
    if (
      line['sessionId'] !== file.parentId ||
      line['isSidechain'] !== true ||
      (line['agentId'] != null && `agent-${String(line['agentId'])}` !== agent)
    )
      return null;
  }
  const message = asRecord(line['message']);
  if (message?.['role'] !== role) return null;
  const content = message['content'];
  const text = cleanReviewText(
    typeof content === 'string' && role === 'user' ? content : textParts(content, 'text'),
  );
  return text === null ? null : { role, text };
}

function codexTurn(
  line: Record<string, unknown>,
  payload: Record<string, unknown> | null,
): WorkReviewTurn | null {
  if (line['type'] !== 'response_item' || payload?.['type'] !== 'message') return null;
  const role = payload['role'];
  if (role !== 'user' && role !== 'assistant') return null;
  const phase = payload['phase'];
  if (role === 'assistant' && phase != null && phase !== 'final_answer') return null;
  const text = cleanReviewText(
    textParts(payload['content'], role === 'user' ? 'input_text' : 'output_text'),
  );
  return text === null ? null : { role, text };
}

async function importedFile(handle: FileHandle, file: ReviewTranscriptFile): Promise<boolean> {
  const info = await handle.stat();
  if (info.nlink !== 1 || info.size < file.size || file.size <= 0 || file.offset <= 0) return false;
  const head = Buffer.alloc(Math.min(HEAD_BYTES, file.size));
  const { bytesRead } = await handle.read(head, 0, head.length, 0);
  return bytesRead === head.length && createHash('sha256').update(head).digest('hex') === file.head;
}

/** Stream only a confined file through its verified handle and stop at the imported prefix or the read limit. */
async function* reviewChunks(
  handle: FileHandle,
  file: ReviewTranscriptFile,
  compressed: boolean,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const stored = compressed ? file.size : Math.min(file.size, file.offset);
  const limit = Math.min(file.offset, MAX_BYTES);
  const source = handle.createReadStream({
    autoClose: false,
    highWaterMark: 64 * 1024,
    end: Math.min(stored, MAX_BYTES) - 1,
    signal,
  });
  const decode = compressed ? createZstdDecompress() : null;
  if (decode) {
    source.on('error', (error) => decode.destroy(error));
    source.pipe(decode);
  }
  let remaining = limit;
  try {
    for await (const chunk of decode ?? source) {
      if (signal.aborted) throw abortError();
      const buffer = chunk as Buffer;
      yield buffer.subarray(0, remaining);
      remaining -= buffer.length;
      if (remaining <= 0) return;
    }
  } finally {
    source.destroy();
    decode?.destroy();
  }
}

interface TimedTurn extends WorkReviewTurn {
  at: number;
}

/** Keep the opening and recent turns for each role. Deduplicate repeated messages within the bounded selection. */
function keepTurn(turns: TimedTurn[], turn: TimedTurn): void {
  if (turns.some((prior) => prior.role === turn.role && prior.text === turn.text)) return;
  turns.push(turn);
  const role = turns.filter((prior) => prior.role === turn.role);
  if (role.length <= MAX_TURNS_PER_ROLE) return;
  const middle = role.sort((a, b) => a.at - b.at)[MAX_TURNS_PER_ROLE / 2]!;
  turns.splice(turns.indexOf(middle), 1);
}

interface FileReview {
  turns: TimedTurn[];
  partial: boolean;
}

const UNAVAILABLE: FileReview = { turns: [], partial: true };

async function readFileTurns(
  unit: ReviewTranscript,
  file: ReviewTranscriptFile,
  roots: readonly string[],
  signal: AbortSignal,
): Promise<FileReview> {
  const location = sourceLocation(unit, file.path, roots);
  if (!location) return UNAVAILABLE;
  try {
    const guard = await statWithin(
      { root: location.root, realRoot: await realpath(location.root) },
      file.path,
    );
    if (guard === null) return UNAVAILABLE;
    if (signal.aborted) throw abortError();
    const handle = await openWithin({ path: file.path, guard: guard.guard });
    try {
      if (!(await importedFile(handle, file))) return UNAVAILABLE;
      const reader = new LineReader(reviewChunks(handle, file, location.compressed, signal), {
        maxLineBytes: MAX_LINE_BYTES,
      });
      const turns: TimedTurn[] = [];
      let identified = location.claude !== null;
      let partial = file.partial;
      for await (const raw of reader.lines()) {
        if (signal.aborted) throw abortError();
        const line = parseJsonLine(raw);
        if (!line) {
          partial = true;
          continue;
        }
        const payload = asRecord(line['payload']);
        // The importing collector pins ownership from the first metadata record. A fork can replay
        // an ancestor's metadata later in the file; the session start and report-day bounds still apply.
        if (!identified && line['type'] === 'session_meta') {
          if (payload?.['id'] !== unit.providerSessionId) return UNAVAILABLE;
          identified = true;
        }
        if (!identified) continue;
        const at = parseTimestamp(line['timestamp']);
        if (at === null || at < unit.fromMs || at >= unit.toMs) continue;
        const turn = location.claude ? claudeTurn(line, location.claude) : codexTurn(line, payload);
        if (turn) keepTurn(turns, { ...turn, at });
      }
      return identified
        ? {
            turns,
            partial:
              partial ||
              reader.overlong > 0 ||
              reader.endOffset < file.offset ||
              (location.compressed && file.size > MAX_BYTES),
          }
        : UNAVAILABLE;
    } finally {
      await handle.close();
    }
  } catch {
    if (signal.aborted) throw abortError();
    return UNAVAILABLE;
  }
}

/** Read bounded same-day conversation text in memory, only for the opted-in generation call. */
export async function readWorkReviewTurns(
  unit: { transcript: ReviewTranscript },
  discovery: DiscoveryInput,
  signal: AbortSignal,
): Promise<{ turns: WorkReviewTurn[]; partial: boolean }> {
  if (signal.aborted) throw abortError();
  const { transcript } = unit;
  const roots =
    transcript.provider === 'codex'
      ? codexHomes(discovery).flatMap((home) => [
          join(home, 'sessions'),
          join(home, 'archived_sessions'),
        ])
      : claudeConfigDirs(discovery).map((dir) => join(dir, 'projects'));
  const allowed = roots.map((root) => resolve(root));
  const turns: TimedTurn[] = [];
  let partial = transcript.files.length > MAX_FILES;
  for (const file of transcript.files.slice(0, MAX_FILES)) {
    if (signal.aborted) throw abortError();
    if (!file) {
      partial = true;
      continue;
    }
    const result = await readFileTurns(transcript, file, allowed, signal);
    partial ||= result.partial;
    for (const turn of result.turns) keepTurn(turns, turn);
  }
  return {
    turns: turns.sort((a, b) => a.at - b.at).map(({ role, text }) => ({ role, text })),
    partial: partial || turns.length === 0,
  };
}
