import { asRecord, asString, parseTimestamp } from '../ingest/index.ts';
import type { MachineEvent } from './machine.ts';
import { claudeToolInfo } from './toolCategory.ts';

// What a live Claude Code transcript line means for the roster (data-and-sources › Live roster (HQ) › Transcript feeds). The line is
// read through a whitelist and the result is built field by field; the parsed line is not referenced afterwards.
//
// Read: `type`, `subtype`, `timestamp`, `cwd`, `isSidechain`, `isMeta`, `isApiErrorMessage`, the presence of `interruptedMessageId`,
// `message.role`, `message.stop_reason`, and of each `message.content` block its `type`, a tool call's `id` and `name` (mapped to a
// category at once and dropped) and a tool result's `tool_use_id`. For a user line whether its content is text is read as a type
// only: the text itself is never looked at.
//
// Never read: `message.content` strings, a text or thinking block's text, a tool call's `input`, a tool result's `content`,
// `toolUseResult`, `error`, titles (`custom-title`, `ai-title`, `summary`), `attachment`, or anything else.

export interface ProjectedLine {
  /** The line's own time (epoch ms), or null when it has none or it cannot be read. */
  at: number | null;
  /** The working directory the line names, when it names one. */
  cwd: string | null;
  events: MachineEvent[];
}

/** A stop reason that ends the assistant's turn. `tool_use` does not: it says a tool call follows. */
const TURN_END_REASONS: ReadonlySet<string> = new Set([
  'end_turn',
  'stop_sequence',
  'max_tokens',
  'refusal',
]);

/**
 * What one line says, or null when it is not a JSON object. `sidechainFile` says the file is a subagent's own: its lines are its own
 * work. In a main transcript a line flagged `isSidechain` belongs to a subagent and is only a sign the file is being written.
 */
export function projectClaudeLine(line: unknown, sidechainFile: boolean): ProjectedLine | null {
  const record = asRecord(line);
  if (record === null) return null;
  const type = asString(record['type']);
  const projected: ProjectedLine = {
    at: parseTimestamp(record['timestamp']),
    cwd: asString(record['cwd']),
    events: [],
  };
  if (record['isSidechain'] === true && !sidechainFile) return projected;

  if (type === 'system') {
    // `turn_duration` is written when a turn ends. An `api_error` is a failed attempt Claude Code retries: only a sign of activity.
    if (asString(record['subtype']) === 'turn_duration')
      projected.events.push({ kind: 'turn_end' });
    return projected;
  }
  if (type !== 'user' && type !== 'assistant') return projected;

  const message = asRecord(record['message']);
  if (message === null) return projected;
  const content = message['content'];
  const blocks = Array.isArray(content) ? content : [];

  if (type === 'user') {
    if (record['isMeta'] === true) return projected; // a hook or command notice, not the person
    if (record['interruptedMessageId'] !== undefined) {
      projected.events.push({ kind: 'aborted' });
      return projected;
    }
    let isText = typeof content === 'string';
    for (const raw of blocks) {
      const block = asRecord(raw);
      const blockType = block === null ? null : asString(block['type']);
      if (block !== null && blockType === 'tool_result') {
        const id = asString(block['tool_use_id']);
        if (id !== null) projected.events.push({ kind: 'tool_end', id });
      } else if (blockType === 'text') {
        isText = true;
      }
    }
    // A user line with text is a prompt, unless it only carries tool results.
    if (isText) projected.events.push({ kind: 'prompt' });
    return projected;
  }

  // assistant
  if (record['isApiErrorMessage'] === true) {
    projected.events.push({ kind: 'error' });
    return projected;
  }
  for (const raw of blocks) {
    const block = asRecord(raw);
    if (block === null) continue;
    const blockType = asString(block['type']);
    if (blockType === 'thinking' || blockType === 'redacted_thinking') {
      projected.events.push({ kind: 'thinking' });
    } else if (blockType === 'text') {
      projected.events.push({ kind: 'responding' });
    } else if (blockType === 'tool_use') {
      const id = asString(block['id']);
      if (id === null) continue;
      const tool = claudeToolInfo(block['name']);
      projected.events.push({
        kind: 'tool_start',
        id,
        category: tool.category,
        longRunning: tool.longRunning,
        wait: tool.wait,
      });
    }
  }
  const stop = asString(message['stop_reason']);
  if (stop !== null && TURN_END_REASONS.has(stop)) projected.events.push({ kind: 'turn_end' });
  return projected;
}
