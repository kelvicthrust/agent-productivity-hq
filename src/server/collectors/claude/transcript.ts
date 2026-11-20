import { createRefCollector } from '../evidence/index.ts';
import { prefersClaudeUsage } from '../../../shared/domain/claude-usage-rank.ts';
import { asRecord, asString, parseJsonLine, parseTimestamp, tokenCount } from '../ingest/index.ts';

// What one Claude Code transcript (or the part of it read this time) says, taken a line at a time. Nothing is kept of a line
// except the figures and ids below: not its text, not a prompt, not a reply, and a line that cannot be read is only counted
// (P-31). Field names are the documented ones and stay unconfirmed until E1 has run on a real machine.
//
// Lines used (data-and-sources › Claude Code transcripts):
//   every line         `timestamp` (the earliest of any type is the session's start), `cwd`, `gitBranch`
//   usage lines        `message.{id, model, usage}`, `requestId`, `sessionId`, `isSidechain`, `version`: one usage event each, plus one
//                      for each `advisor_message` in `usage.iterations`. The rules that choose which lines count and how one message
//                      written twice becomes one are ccusage's, written down with their source in docs/implementation/ccusage-rules.md;
//                      [A3] to [A7] below are that page's ids.
//   title lines        `custom-title`, `ai-title` and `summary`: the recorded title, if the file has one

export interface ScannedEvent {
  /** One per message ([A3]): `message.id:requestId`, or the id with the session when the line has no request id. */
  dedupeKey: string;
  /** The line says it belongs to a sidechain. A copy in a subagent transcript is a sidechain's whatever the line says. */
  sidechain: boolean;
  /** The line has a `speed` in its usage ([A4]: the tie-break after the total). */
  hasSpeed: boolean;
  occurredAt: number;
  model: string;
  /** Uncached input, cache write, cache read and output are four separate categories, never converted into each other. */
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  /** The provider's own rule: the four categories added. */
  total: number;
}

const MAX_TITLE_CHARS = 200;

/** A user's own name for the session beats one Claude Code wrote, which beats a conversation summary. */
const TITLES: Readonly<Record<string, { key: string; rank: number }>> = {
  'custom-title': { key: 'customTitle', rank: 3 },
  'ai-title': { key: 'aiTitle', rank: 2 },
  summary: { key: 'summary', rank: 1 },
};

/** `1.2.3`-style: digits, a dot, digits, a dot and a digit, as ccusage requires of a line's `version` ([A7]). */
const SEMVER_PREFIX = /^\d+\.\d+\.\d/;

/** A message id the provider issues (`msg_…`, `resp_…`) is unique per response; a gateway's placeholder is not ([A3]). */
const issuedId = (id: string): boolean => id.startsWith('msg_') || id.startsWith('resp_');

export class TranscriptScan {
  /**
   * One entry for each message in what was read ([A3], [A4]): when a message is written on several lines (Claude Code streams one
   * message over several), the one with the larger total stays and, with equal totals, the first. Never one entry per line.
   */
  readonly events = new Map<string, ScannedEvent>();
  /** Usage lines for a key already seen in this read (a streamed message's earlier lines). Counted as duplicates skipped. */
  repeated = 0;
  /** Lines that were not JSON objects, or were usage lines missing a field a usage event needs. */
  unreadable = 0;
  /** Earliest `timestamp` of any line type, as epoch ms. */
  earliestLine: number | null = null;
  /** The working directory of the first line that has one: where the session started. */
  cwd: string | null = null;
  /** The branch of the last line that has one. */
  gitBranch: string | null = null;
  title: string | null = null;
  /**
   * The PR references, commit ids and branches the lines named (data-and-sources › Evidence extraction). Identifiers only: each line
   * is scanned as it is read and nothing of it is kept, so there is no text for an error or a log to carry (P-31).
   */
  readonly refs = createRefCollector();
  #titleRank = 0;
  /** `fileSession` is the session ccusage derives from the file's place (a main transcript's name, a subagent's parent folder). */
  readonly fileSession: string;
  readonly subagent: boolean;
  constructor(fileSession = 'unknown', subagent = false) {
    this.fileSession = fileSession;
    this.subagent = subagent;
  }

  add(text: string): void {
    const line = parseJsonLine(text);
    if (line === null) {
      this.unreadable += 1;
      return;
    }
    const at = parseTimestamp(line.timestamp);
    if (at !== null && (this.earliestLine === null || at < this.earliestLine)) {
      this.earliestLine = at;
    }
    this.cwd ??= asString(line.cwd);
    this.gitBranch = asString(line.gitBranch) ?? this.gitBranch;
    // A line with no usable time contributes no reference rather than a guessed time.
    this.refs.addLine(text, at ?? Number.NaN);
    this.refs.addBranch(line.gitBranch, at ?? Number.NaN);

    this.#usage(line, at);
    const type = asString(line.type);
    if (type !== null && type !== 'assistant') this.#title(type, line);
  }

  /** The four counts of a usage object; a missing cache count is zero, a count that is not a count makes the line unreadable. */
  #counts(usage: Record<string, unknown>): {
    input: number;
    cacheWrite: number;
    cacheRead: number;
    output: number;
  } | null {
    const count = (value: unknown): number | null => (value === undefined ? 0 : tokenCount(value));
    const input = tokenCount(usage.input_tokens);
    const output = tokenCount(usage.output_tokens);
    const cacheWrite = count(usage.cache_creation_input_tokens);
    const cacheRead = count(usage.cache_read_input_tokens);
    if (input === null || output === null || cacheWrite === null || cacheRead === null) return null;
    return { input, cacheWrite, cacheRead, output };
  }

  #usage(line: Record<string, unknown>, at: number | null): void {
    const message = asRecord(line.message);
    const usage = asRecord(message?.usage);
    // A line with no usage carries nothing to count, whatever its type ([A1]).
    if (message === null || usage === null) return;

    // [A7] a line with an empty id or model, or a version that is not a version, is not counted (silently: it is not damage).
    const empty = (value: unknown): boolean => value === '';
    if (
      empty(line.sessionId) ||
      empty(line.requestId) ||
      empty(message.id) ||
      empty(message.model) ||
      (typeof line.version === 'string' && !SEMVER_PREFIX.test(line.version))
    )
      return;

    const counts = this.#counts(usage);
    if (counts === null || at === null) {
      this.unreadable += 1;
      return;
    }
    const id = asString(message.id);
    const requestId = asString(line.requestId);
    const sessionId = asString(line.sessionId);
    const model = asString(message.model) ?? 'unknown';
    const sidechain = this.subagent || line.isSidechain === true;
    const hasSpeed = usage.speed !== undefined && usage.speed !== null;
    this.#add(this.#entry({ id, requestId, sessionId, sidechain, hasSpeed, model, at, counts }));

    // [A6] each advisor_message iteration is one more entry, in the same session, with its own usage and model.
    const iterations = Array.isArray(usage.iterations) ? usage.iterations : [];
    iterations.forEach((value, index) => {
      const iteration = asRecord(value);
      const iterationModel = asString(iteration?.model);
      if (!iteration || iteration.type !== 'advisor_message' || iterationModel === null) return;
      const extra = this.#counts(iteration);
      if (extra === null) return;
      this.#add(
        this.#entry({
          id: id === null ? null : `${id}:advisor:${index}`,
          requestId,
          sessionId,
          sidechain,
          hasSpeed: false,
          model: iterationModel,
          at,
          counts: extra,
        }),
      );
    });
  }

  /** The entry for one usage object, or null when it has no tokens at all (Claude Code writes some for its own notices). */
  #entry(input: {
    id: string | null;
    requestId: string | null;
    sessionId: string | null;
    sidechain: boolean;
    hasSpeed: boolean;
    model: string;
    at: number;
    counts: { input: number; cacheWrite: number; cacheRead: number; output: number };
  }): ScannedEvent | null {
    const { counts, id, requestId, sessionId, at } = input;
    const total = counts.input + counts.cacheWrite + counts.cacheRead + counts.output;
    if (total === 0) return null;
    // [A3] a request id says two lines are one response. Without one, the message id holds only inside its session (and, for an
    // id a gateway made up, at the same time).
    const session = sessionId ?? this.fileSession;
    const dedupeKey =
      id === null
        ? `x:${session}:${at}:${counts.input}:${counts.cacheWrite}:${counts.cacheRead}:${counts.output}`
        : requestId !== null
          ? `${id}:${requestId}`
          : issuedId(id)
            ? `${id}::${session}`
            : `${id}::${session}:${at}`;
    return {
      dedupeKey,
      sidechain: input.sidechain,
      hasSpeed: input.hasSpeed,
      occurredAt: at,
      model: input.model,
      input: counts.input,
      cacheWrite: counts.cacheWrite,
      cacheRead: counts.cacheRead,
      output: counts.output,
      total,
    };
  }

  #add(event: ScannedEvent | null): void {
    if (event === null) return;
    const held = this.events.get(event.dedupeKey);
    if (held !== undefined) {
      this.repeated += 1;
      if (!prefersClaudeUsage(event, held)) return;
    }
    this.events.set(event.dedupeKey, event);
  }

  #title(type: string, line: Record<string, unknown>): void {
    const kind = Object.hasOwn(TITLES, type) ? TITLES[type] : undefined;
    if (kind === undefined || kind.rank < this.#titleRank) return;
    const value = asString(line[kind.key]);
    if (value === null) return;
    const title = value.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS);
    if (title === '') return;
    this.title = title;
    this.#titleRank = kind.rank;
  }

  /** The earliest and latest event time and the model of the latest event, or null when the read had no usage. */
  eventSpan(): { first: number; last: number; lastModel: string } | null {
    let span: { first: number; last: number; lastModel: string } | null = null;
    for (const event of this.events.values()) {
      if (span === null)
        span = { first: event.occurredAt, last: event.occurredAt, lastModel: event.model };
      else {
        if (event.occurredAt < span.first) span.first = event.occurredAt;
        if (event.occurredAt >= span.last) {
          span.last = event.occurredAt;
          span.lastModel = event.model;
        }
      }
    }
    return span;
  }
}
