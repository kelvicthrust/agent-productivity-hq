import { createRefCollector } from '../evidence/index.ts';
import { asRecord, asString, parseJsonLine, parseTimestamp, tokenCount } from '../ingest/index.ts';
import type { SessionRefInput } from '../../db/queries/links.ts';

// What one Codex rollout says, line by line (data-and-sources › Codex local rollouts). Pure: lines go in, a session's identity and
// its usage events come out, and nothing here touches a file, the database or the clock, so the rules are tested without either.
//
// The counting rules are ccusage's (the oracle for G5_3), written down with their source in docs/implementation/ccusage-rules.md;
// the ids [X1] to [X6] below are that page's. Nothing keeps, returns or throws the text of a line: a rollout holds prompts,
// replies and paths (P-31).
//
//   - `session_meta` is the FIRST one in the file: identity, start time, working directory, repository hint, source, and the
//     parent a fork or spawned child copied history from. A later one never changes who the file belongs to.
//   - `turn_context` sets the model for the usage that follows.
//   - [X1] a usage object has input (with cached and cache-write inside it), output (with reasoning inside it) and a total.
//   - [X2] an `event_msg` / `token_count` is the object `last_token_usage` when the cumulative total changed since the line
//     before (or has no total), else the saturating difference of the two totals; the previous total is always replaced.
//   - [X4] a `token_usage_record` is one more event when a `compacted` line names its response id, unless a token_count that
//     advanced right after it already carried it.
//   - [X5] [X6] what a fork or spawned child copied from its parent is skipped by replay.ts, which needs the parent's events;
//     this parser only keeps what that needs (who the parent is, when the fork happened, the first two usage times).
//   - A line that cannot be read, or cannot be placed (no usage object, no time, no identity yet), is counted as unreadable and
//     left out, never guessed.

/** One usage object as ccusage reads it, after its own clamping ([X1]). `total` is the recorded total, else input + output. */
export interface Usage {
  /** Includes `cached` and `cacheWrite`. */
  input: number;
  cached: number;
  cacheWrite: number;
  /** Includes `reasoning`. */
  output: number;
  reasoning: number;
  total: number;
}

export interface RolloutEvent extends Usage {
  occurredAt: number;
  /** The timestamp exactly as the line wrote it: with the model and the figures it is what makes two copies one event. */
  at: string;
  model: string;
  /** Codex's rule, owner-confirmed: input + output. Never re-added from other fields downstream. */
  providerTotal: number;
  /** Set on a compaction request's usage ([X4]); such an event is one per response id, wherever it was copied. */
  responseId: string | null;
}

/**
 * What `session_meta.source` says about the thread (verify E2: the fixtures hold the documented shapes only).
 *   root     cli, vscode, exec, appServer: someone started it
 *   spawned  a subagent; `parentId` is the thread that spawned it, or null when the rollout does not name one
 *   unknown  anything else, or no source at all: never taken for a root
 */
export type SourceClass =
  { kind: 'root' } | { kind: 'spawned'; parentId: string | null } | { kind: 'unknown' };

export interface RolloutMeta {
  id: string;
  /** `session_meta.timestamp`, or the line's own time when the payload has none. */
  startedAt: number | null;
  cwd: string | null;
  repositoryUrl: string | null;
  branch: string | null;
  source: SourceClass;
}

/** The thread a rollout copied history from (`forked_from_id`, else the spawning parent), and when it did (the line's time). */
export interface ForkRef {
  parentId: string;
  /** The first line's own timestamp: the fork instant, or null when it has none. */
  at: number | null;
}

const ROOT_SOURCES = new Set(['cli', 'vscode', 'exec', 'appserver']);
const SUBAGENT = /^sub[_-]?agent/i;
const PARENT_KEY = 'parent_thread_id';
const MAX_DEPTH = 4;

/** The first `parent_thread_id` string below `value` (the documented path is `subagent.thread_spawn.parent_thread_id`). */
function findParentId(value: unknown, depth = 0): string | null {
  const record = asRecord(value);
  if (!record || depth > MAX_DEPTH) return null;
  const direct = asString(record[PARENT_KEY]);
  if (direct) return direct;
  for (const child of Object.values(record)) {
    const found = findParentId(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Sorts a `source` value into root, spawned or unknown. A thread that names itself as its parent has no parent reference. */
export function classifySource(source: unknown, ownId: string): SourceClass {
  if (typeof source === 'string') {
    if (SUBAGENT.test(source)) return { kind: 'spawned', parentId: null };
    return ROOT_SOURCES.has(source.toLowerCase().replace(/[_\-\s]/g, ''))
      ? { kind: 'root' }
      : { kind: 'unknown' };
  }
  const record = asRecord(source);
  if (record && Object.keys(record).some((key) => SUBAGENT.test(key))) {
    const parentId = findParentId(record);
    return { kind: 'spawned', parentId: parentId === ownId ? null : parentId };
  }
  return { kind: 'unknown' };
}

/**
 * The dedupe key of an event ([X7]). Inside one rollout two events are one when they have the same timestamp text, model and every
 * figure; the key carries the session id, because the oracle's SESSION report keeps a copy of the same events in each session that
 * holds it (only its daily report merges them). A compaction request is the exception: it is one event per response id, in the first
 * rollout that has it, wherever it was copied.
 */
export function eventKey(sessionId: string, event: RolloutEvent): string {
  if (event.responseId !== null) return `r:${event.responseId}`;
  return [
    'u',
    sessionId,
    event.at,
    event.model,
    event.input,
    event.cached,
    event.cacheWrite,
    event.output,
    event.reasoning,
    event.total,
  ].join(':');
}

export interface ParsedRollout {
  /** Null when the file has no readable `session_meta`. */
  meta: RolloutMeta | null;
  /** In file order, compaction events where their rule emitted them. A fork's copied history is still in here: see replay.ts. */
  events: RolloutEvent[];
  /** Lines that were not JSON objects, or lacked a field they needed. The reader's dropped overlong lines are added by the caller. */
  unreadable: number;
  /** A `token_count` was met (even one that could not be used): a file with these and no identity is a format this adapter does not read. */
  sawUsage: boolean;
  /** Who this rollout copied history from, or null for a thread that copied none. */
  fork: ForkRef | null;
  /** The times of its first two usage-bearing token_count lines ([X6]), at most two. */
  burst: number[];
  /** The first `session_meta` line's own time ([X6]). */
  metaLineAt: number | null;
  /** Compaction response ids a `compacted` line names that this rollout also has a usage record for, with that record's time. */
  compactions: Map<string, number | null>;
  /** The PR references, commit ids and branch the lines named: identifiers only (data-and-sources › Evidence extraction). */
  refs: SessionRefInput[];
}

/** The usage of one object. Null unless it has the two fields every usage has (input and output): a missing one is not guessed. */
export function usageOf(value: unknown): Usage | null {
  const usage = asRecord(value);
  if (!usage) return null;
  const pick = (...names: string[]): number | null => {
    for (const name of names) {
      const found = tokenCount(usage[name]);
      if (found !== null) return found;
    }
    return null;
  };
  const input = pick('input_tokens', 'prompt_tokens', 'input');
  const output = pick('output_tokens', 'completion_tokens', 'output');
  if (input === null || output === null) return null;
  const cached = Math.min(
    pick('cached_input_tokens', 'cache_read_input_tokens', 'cached_tokens') ?? 0,
    input,
  );
  const cacheWrite = Math.min(
    pick('cache_write_input_tokens', 'cache_creation_input_tokens') ?? 0,
    input - cached,
  );
  const recorded = pick('total_tokens') ?? 0;
  return {
    input,
    cached,
    cacheWrite,
    output,
    reasoning: pick('reasoning_output_tokens', 'reasoning_tokens') ?? 0,
    total: recorded > 0 ? recorded : input + output,
  };
}

const same = (a: Usage | null, b: Usage | null): boolean =>
  a !== null &&
  b !== null &&
  a.input === b.input &&
  a.cached === b.cached &&
  a.cacheWrite === b.cacheWrite &&
  a.output === b.output &&
  a.reasoning === b.reasoning &&
  a.total === b.total;

/** [X2] the per-field difference, never below zero. */
function difference(current: Usage, previous: Usage | null): Usage {
  const sub = (a: number, b: number): number => Math.max(0, a - b);
  return {
    input: sub(current.input, previous?.input ?? 0),
    cached: sub(current.cached, previous?.cached ?? 0),
    cacheWrite: sub(current.cacheWrite, previous?.cacheWrite ?? 0),
    output: sub(current.output, previous?.output ?? 0),
    reasoning: sub(current.reasoning, previous?.reasoning ?? 0),
    total: sub(current.total, previous?.total ?? 0),
  };
}

/** The clamping ccusage applies again after a subtraction: cached within input, cache-write within the rest of it. */
function normalized(usage: Usage): Usage {
  const cached = Math.min(usage.cached, usage.input);
  return { ...usage, cached, cacheWrite: Math.min(usage.cacheWrite, usage.input - cached) };
}

/** Whether a usage object counts for anything: the recorded total alone does not make it so. */
const hasUsage = (usage: Usage): boolean =>
  usage.input !== 0 ||
  usage.cached !== 0 ||
  usage.cacheWrite !== 0 ||
  usage.output !== 0 ||
  usage.reasoning !== 0;

const isZero = (usage: Usage): boolean => !hasUsage(usage) && usage.total === 0;

interface Pending {
  event: RolloutEvent;
  threadTotal: Usage | null;
}

/** The time a line carries, as text and as epoch ms. */
function timeOf(line: Record<string, unknown>): { at: string; ms: number } | null {
  const raw = line['timestamp'];
  const ms = parseTimestamp(raw);
  if (ms === null) return null;
  return { at: typeof raw === 'string' ? raw : String(raw), ms };
}

export class RolloutParser {
  #meta: RolloutMeta | null = null;
  #metaSeen = false;
  #model = 'unknown';
  #prev: Usage | null = null;
  #unreadable = 0;
  #sawUsage = false;
  #fork: ForkRef | null = null;
  #metaLineAt: number | null = null;
  readonly #burst: number[] = [];
  readonly #events: RolloutEvent[] = [];
  // [X4] compaction bookkeeping
  readonly #compacted = new Set<string>();
  readonly #pending = new Map<string, Pending>();
  readonly #emitted = new Set<string>();
  readonly #recorded = new Map<string, number | null>();
  #latestRecord: string | null = null;
  readonly #refs = createRefCollector();

  /** Takes one line of the file, in order. */
  push(text: string): void {
    const line = parseJsonLine(text);
    if (!line) {
      this.#unreadable += 1;
      return;
    }
    // Every line is scanned for identifiers and then forgotten: the scan returns PR references and commit ids and nothing else.
    this.#refs.addLine(text, parseTimestamp(line['timestamp']) ?? Number.NaN);
    const type = asString(line['type']);
    const payload = asRecord(line['payload']);
    if (type === 'session_meta') this.#sessionMeta(line, payload);
    else if (type === 'turn_context') this.#model = asString(payload?.['model']) ?? this.#model;
    else if (type === 'compacted') this.#compactedLine(payload);
    else if (type === 'token_usage_record') this.#usageRecord(line, payload);
    else if (type === 'event_msg' && payload && payload['type'] === 'token_count')
      this.#tokenCount(line, payload);
    // Messages, tool calls and the rest are ignored: nothing in them is usage, and none of their text is read.
  }

  /** What the lines said. Call once, after the last line. */
  finish(): ParsedRollout {
    const compactions = new Map<string, number | null>();
    for (const [id, at] of this.#recorded) if (this.#compacted.has(id)) compactions.set(id, at);
    return {
      meta: this.#meta,
      events: this.#events,
      unreadable: this.#unreadable,
      sawUsage: this.#sawUsage,
      fork: this.#fork,
      burst: this.#burst,
      metaLineAt: this.#metaLineAt,
      compactions,
      refs: this.#refs.refs(),
    };
  }

  #sessionMeta(line: Record<string, unknown>, payload: Record<string, unknown> | null): void {
    if (this.#metaSeen) return;
    this.#metaSeen = true; // a damaged first meta is not replaced by a later (replayed) one: that would be another thread's identity
    const id = asString(payload?.['id']);
    if (!payload || !id) {
      this.#unreadable += 1;
      return;
    }
    const git = asRecord(payload['git']);
    const lineAt = parseTimestamp(line['timestamp']);
    this.#metaLineAt = lineAt;
    const forkedFrom = asString(payload['forked_from_id']);
    let source = classifySource(payload['source'], id);
    // A spawned child that names its parent only as `forked_from_id` still names it: the same native reference.
    if (
      source.kind === 'spawned' &&
      source.parentId === null &&
      forkedFrom !== null &&
      forkedFrom !== id
    )
      source = { kind: 'spawned', parentId: forkedFrom };
    const parentId = forkedFrom ?? (source.kind === 'spawned' ? source.parentId : null);
    if (parentId !== null && parentId !== id) this.#fork = { parentId, at: lineAt };
    this.#refs.addBranch(asString(git?.['branch']), lineAt ?? Number.NaN);
    this.#meta = {
      id,
      startedAt: parseTimestamp(payload['timestamp']) ?? lineAt,
      cwd: asString(payload['cwd']),
      repositoryUrl: asString(git?.['repository_url']),
      branch: asString(git?.['branch']),
      source,
    };
  }

  /** [X4] a `compacted` line names the response a compaction request had. */
  #compactedLine(payload: Record<string, unknown> | null): void {
    const id = asString(payload?.['compaction_response_id'])?.trim();
    if (!id) return;
    this.#compacted.add(id);
    const pending = this.#pending.get(id);
    if (pending) {
      this.#pending.delete(id);
      if (!this.#emitted.has(id)) {
        this.#emitted.add(id);
        this.#events.push(pending.event);
      }
    }
  }

  /** [X4] a request's own usage record: one more event only when a `compacted` line names it. */
  #usageRecord(line: Record<string, unknown>, payload: Record<string, unknown> | null): void {
    const id = asString(payload?.['response_id'])?.trim();
    if (!id || !payload || this.#emitted.has(id)) return;
    const when = timeOf(line);
    const usage = usageOf(payload['usage']);
    if (!when || !usage || isZero(usage)) return;
    if (!this.#recorded.has(id)) this.#recorded.set(id, when.ms);
    const event: RolloutEvent = {
      ...usage,
      occurredAt: when.ms,
      at: when.at,
      model: this.#model,
      providerTotal: usage.input + usage.output,
      responseId: id,
    };
    this.#latestRecord = id;
    if (this.#compacted.has(id)) {
      this.#emitted.add(id);
      this.#events.push(event);
    } else if (!this.#pending.has(id)) {
      this.#pending.set(id, { event, threadTotal: usageOf(payload['thread_token_usage']) });
    }
  }

  #tokenCount(line: Record<string, unknown>, payload: Record<string, unknown>): void {
    // `info: null` is a count with no usage in it (the rate-limit-only form): not an event and not damage (verify E2).
    if (payload['info'] === null) return;
    this.#sawUsage = true;
    const info = asRecord(payload['info']);
    const total = usageOf(info?.['total_token_usage']);
    const last = usageOf(info?.['last_token_usage']);
    const when = timeOf(line) ?? timeOf(payload);
    if ((!total && !last) || !when || !this.#meta) {
      this.#unreadable += 1;
      return;
    }
    // [X6] the first two lines that carry usage, whatever becomes of them, are what tells a rewritten burst from real turns.
    const lead = last ?? total;
    if (this.#burst.length < 2 && lead && hasUsage(normalized(lead))) this.#burst.push(when.ms);

    // [X2]
    const advanced = total === null || !same(this.#prev, total);
    const raw = advanced && last ? last : total ? difference(total, this.#prev) : null;
    if (total) this.#prev = total;
    if (!raw) return;
    const usage = normalized(raw);
    if (!hasUsage(usage)) return;

    // [X4] a count that advanced right after a request record already carried that record's usage: it is not counted twice.
    const latest = this.#latestRecord;
    const pending = latest === null ? undefined : this.#pending.get(latest);
    if (
      advanced &&
      latest !== null &&
      pending &&
      (same(pending.event, usage) ||
        (pending.threadTotal !== null &&
          total !== null &&
          same(normalized(pending.threadTotal), normalized(total))))
    ) {
      this.#pending.delete(latest);
      this.#emitted.add(latest);
    }

    this.#events.push({
      ...usage,
      occurredAt: when.ms,
      at: when.at,
      model: this.#model,
      providerTotal: usage.input + usage.output,
      responseId: null,
    });
  }
}
