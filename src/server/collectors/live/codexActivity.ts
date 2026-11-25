import { liveTitle } from '../../lib/liveText.ts';
import { classifySource } from '../codex/rollout.ts';
import { asRecord, asString, parseTimestamp } from '../ingest/index.ts';
import type { ProjectedLine } from './claudeActivity.ts';
import { codexToolInfo } from './toolCategory.ts';

// What a live Codex rollout line means for the roster (data-and-sources › Live roster (HQ) › Transcript feeds). Read through a
// whitelist and built field by field; the parsed line is not referenced afterwards.
//
// Read: `type`, `timestamp`, `payload.type`; of a `response_item` its `role` (a message's), `call_id` and, for a call, `name` (mapped to
// a category at once and dropped); of `session_meta` its `id`, `timestamp`, `cwd`, `forked_from_id` and `source` (only to tell a
// spawned thread and name its parent, as the batch importer does). For spawned threads read the recorded nickname and role only.
//
// Never read: a message's or reasoning item's `content` or `summary`, a call's `arguments` or `input`, a call's `output`, `base_instructions`,
// `git`, `item_completed`'s item, token counts, or anything else.

export interface CodexMeta {
  /** The thread id: Codex's own, and what Paseo's `runtimeInfo.sessionId` carries. */
  id: string;
  startedAt: number | null;
  cwd: string | null;
  /** The thread that spawned this one (or that it was forked from): the native parent. */
  parentId: string | null;
  subagentTitle?: string;
}

export interface CodexProjectedLine extends ProjectedLine {
  /** Set only for a `session_meta` line. */
  meta: CodexMeta | null;
}

const CALLS: ReadonlySet<string> = new Set([
  'function_call',
  'custom_tool_call',
  'local_shell_call',
]);
const OUTPUTS: ReadonlySet<string> = new Set(['function_call_output', 'custom_tool_call_output']);

/** What one rollout line says, or null when it is not a JSON object. */
export function projectCodexLine(line: unknown): CodexProjectedLine | null {
  const record = asRecord(line);
  if (record === null) return null;
  const at = parseTimestamp(record['timestamp']);
  const projected: CodexProjectedLine = { at, cwd: null, events: [], meta: null };
  const type = asString(record['type']);
  const payload = asRecord(record['payload']);
  if (payload === null) return projected;
  const payloadType = asString(payload['type']);

  if (type === 'session_meta') {
    const id = asString(payload['id']);
    if (id === null) return projected;
    const forkedFrom = asString(payload['forked_from_id']);
    const rawSource = payload['source'];
    const source = classifySource(rawSource, id);
    const parent = forkedFrom ?? (source.kind === 'spawned' ? source.parentId : null);
    const spawn = asRecord(asRecord(asRecord(rawSource)?.['subagent'])?.['thread_spawn']);
    const subagentTitle =
      source.kind === 'spawned'
        ? (liveTitle(payload['agent_nickname']) ??
          liveTitle(spawn?.['agent_nickname']) ??
          liveTitle(payload['agent_role']) ??
          liveTitle(spawn?.['agent_role']))
        : null;
    projected.meta = {
      id,
      startedAt: parseTimestamp(payload['timestamp']) ?? at,
      cwd: asString(payload['cwd']),
      parentId: parent !== null && parent !== id ? parent : null,
      ...(subagentTitle !== null && { subagentTitle }),
    };
    projected.cwd = projected.meta.cwd;
    return projected;
  }

  if (type === 'event_msg') {
    if (payloadType === 'task_started' || payloadType === 'turn_started')
      projected.events.push({ kind: 'prompt' });
    else if (payloadType === 'task_complete' || payloadType === 'turn_complete')
      projected.events.push({ kind: 'turn_end' });
    else if (payloadType === 'turn_aborted') projected.events.push({ kind: 'aborted' });
    else if (payloadType === 'error') projected.events.push({ kind: 'error' });
    return projected;
  }

  if (type === 'response_item' && payloadType !== null) {
    if (payloadType === 'reasoning') {
      projected.events.push({ kind: 'thinking' });
    } else if (payloadType === 'message') {
      const role = asString(payload['role']);
      if (role === 'assistant') projected.events.push({ kind: 'responding' });
      else if (role === 'user') projected.events.push({ kind: 'prompt' });
    } else if (CALLS.has(payloadType)) {
      const id = asString(payload['call_id']);
      if (id !== null) {
        const tool = codexToolInfo(
          payloadType === 'local_shell_call' ? payloadType : payload['name'],
        );
        projected.events.push({
          kind: 'tool_start',
          id,
          category: tool.category,
          longRunning: tool.longRunning,
          wait: tool.wait,
        });
      }
    } else if (OUTPUTS.has(payloadType)) {
      const id = asString(payload['call_id']);
      if (id !== null) projected.events.push({ kind: 'tool_end', id });
    }
  }
  return projected;
}
