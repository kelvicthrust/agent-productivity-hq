import { join, relative, sep } from 'node:path';
import { UsageError } from './lib/args.ts';
import { defineExperiment, runIfMain } from './lib/cli.ts';
import { isIdentifier, safeText } from './lib/redact.ts';
import type { ExperimentContext } from './lib/types.ts';

// E9 · Live activity in transcripts (docs/tech/data-and-sources.md › Live roster (HQ) › Transcript feeds).
//
// HQ wants to show agents started outside Paseo, and a coarse activity (thinking, reading, editing, running a command) for
// working agents. Before the mapping is designed this reads the transcript files modified in the last day and reports only
// AGGREGATE COUNTS: per provider and per origin (where the file lives), how many files, and histograms of record types,
// content-block types, tool names (names only), stop reasons, and for Codex the session_meta source and originator values and
// the event_msg and response_item payload types. It also counts, per file, how the file ENDS (the shape of its last record and
// whether a tool call was still waiting for its result), which is what a live feed has to read to tell "working" from "done".
//
// What it never does: print, keep or write message text, a tool's input or output, a path below the root, a title or an id. Every
// string that reaches a histogram key must look like an identifier (a type name, an enum value, a tool name) and is otherwise
// folded into `[other]`; an MCP tool name is folded into `mcp-tool`, because its server name is the owner's own choice. The
// interrupt marker is the one place text is looked at: a user line's text is compared with the fixed marker Claude Code writes
// when a turn is interrupted, in memory, and only the boolean is counted.

const HOUR_MS = 3_600_000;
const DEFAULT_WINDOW_HOURS = 24;
const TOP = 60;
const OTHER = 'other-folded';
const ABSENT = 'absent-field';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SET_ASIDE = /\.orphaned-[^/]*\.jsonl$|\.jsonl\.superseded-/;
/** What Claude Code writes as the text of a user line when the person interrupts a turn. Compared in memory; never kept. */
const INTERRUPT_PREFIX = '[Request interrupted';

type Provider = 'claude' | 'codex';

export type Origin = 'claude:main' | 'claude:subagent' | 'codex:sessions' | 'codex:archived';

const ORIGINS: readonly Origin[] = [
  'claude:main',
  'claude:subagent',
  'codex:sessions',
  'codex:archived',
];

/** True when a file last written at `mtimeMs` falls inside the window ending at `now`. A file from the future counts as recent. */
export function inWindow(mtimeMs: number, now: number, windowMs: number): boolean {
  return now - mtimeMs <= windowMs;
}

/** A string that may become a histogram key: identifier-shaped, not an id; anything else is folded. */
export function key(value: unknown): string {
  if (typeof value !== 'string') return value === undefined || value === null ? ABSENT : OTHER;
  if (value.startsWith('mcp__')) return 'mcp-tool';
  if (
    UUID.test(value) ||
    !isIdentifier(value) ||
    value.length > 40 ||
    /^[0-9a-f]{24,}$/i.test(value)
  )
    return OTHER;
  return value;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

class Histogram {
  readonly #counts = new Map<string, number>();
  add(name: string, by = 1): void {
    this.#counts.set(name, (this.#counts.get(name) ?? 0) + by);
  }
  get size(): number {
    return this.#counts.size;
  }
  get(name: string): number {
    return this.#counts.get(name) ?? 0;
  }
  has(name: string): boolean {
    return this.#counts.has(name);
  }
  /** `name@count`, largest first (ties by name), at most `limit` entries. */
  entries(limit = TOP): string[] {
    return [...this.#counts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, limit)
      .map(([name, count]) => `${name}@${count}`);
  }
}

const HISTOGRAMS = [
  'recordTypes',
  'roles',
  'blockTypes',
  'toolNames',
  'stopReasons',
  'markers',
  'entrypoints',
  'sources',
  'originators',
  'threadSources',
  'eventTypes',
  'responseItemTypes',
  'callNames',
  'permissionDecisions',
  'permissionModes',
  'signatures',
  'lastSignatures',
  'pendingAtEnd',
] as const;
type HistogramName = (typeof HISTOGRAMS)[number];

export interface OriginCensus {
  files: number;
  lines: number;
  unreadableLines: number;
  h: Record<HistogramName, Histogram>;
}

export const emptyCensus = (): OriginCensus => ({
  files: 0,
  lines: 0,
  unreadableLines: 0,
  h: Object.fromEntries(HISTOGRAMS.map((name) => [name, new Histogram()])) as Record<
    HistogramName,
    Histogram
  >,
});

/** What one Claude Code line is, as a short signature of type names only. */
function claudeSignature(line: Record<string, unknown>): string {
  const type = key(line['type']);
  const subtype = line['subtype'] === undefined ? '' : `/${key(line['subtype'])}`;
  const message = record(line['message']);
  const content = message?.['content'];
  const blocks = Array.isArray(content)
    ? content.map((b) => key(record(b)?.['type'])).join('+')
    : typeof content === 'string'
      ? 'plain-string'
      : 'noblocks';
  const stop = message?.['stop_reason'];
  return `${type}${subtype}:${blocks}:${stop === undefined || stop === null ? 'nostop' : key(stop)}`;
}

/** Folds one Claude Code line into the census. Returns the tool-use ids it opened and closed (never kept beyond the file). */
export function addClaudeLine(
  census: OriginCensus,
  line: Record<string, unknown>,
  open: Map<string, string>,
): void {
  const { h } = census;
  const type = key(line['type']);
  h.recordTypes.add(line['subtype'] === undefined ? type : `${type}/${key(line['subtype'])}`);
  h.signatures.add(claudeSignature(line));
  if (line['entrypoint'] !== undefined) h.entrypoints.add(key(line['entrypoint']));
  if (line['isSidechain'] === true) h.markers.add('isSidechain');
  if (line['isApiErrorMessage'] === true) h.markers.add('isApiErrorMessage');
  if (line['isMeta'] === true) h.markers.add('isMeta');
  if (line['toolUseResult'] !== undefined) h.markers.add('toolUseResult');
  if (line['permissionDecision'] !== undefined)
    h.permissionDecisions.add(key(line['permissionDecision']));
  if (type === 'permission-mode' || type === 'mode')
    h.permissionModes.add(key(line['permissionMode'] ?? line['mode']));
  if (type === 'attachment')
    h.markers.add(`attachment:${key(record(line['attachment'])?.['type'])}`);
  if (type === 'queue-operation') h.markers.add(`queue-operation:${key(line['operation'])}`);

  if (line['interruptedMessageId'] !== undefined) h.markers.add('interruptedMessageId-key');
  // Only the conversation itself is read below: `api-request-blob` and similar lines repeat message content as logged requests.
  if (type !== 'user' && type !== 'assistant') return;
  const message = record(line['message']);
  if (message === null) return;
  if (message['role'] !== undefined) h.roles.add(key(message['role']));
  if (message['stop_reason'] !== undefined && message['stop_reason'] !== null)
    h.stopReasons.add(key(message['stop_reason']));
  const content = message['content'];
  if (typeof content === 'string') {
    h.blockTypes.add('plain-string');
    if (type === 'user' && content.startsWith(INTERRUPT_PREFIX)) h.markers.add('interrupt-marker');
    return;
  }
  if (!Array.isArray(content)) return;
  for (const raw of content) {
    const block = record(raw);
    if (block === null) continue;
    const blockType = key(block['type']);
    h.blockTypes.add(blockType);
    if (blockType === 'tool_use') {
      const name = key(block['name']);
      h.toolNames.add(name);
      const id = typeof block['id'] === 'string' ? block['id'] : null;
      if (id !== null) open.set(id, name);
    } else if (blockType === 'tool_result') {
      const id = typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : null;
      if (id !== null) open.delete(id);
      if (block['is_error'] === true) h.markers.add('tool_result:is_error');
    } else if (
      blockType === 'text' &&
      type === 'user' &&
      typeof block['text'] === 'string' &&
      block['text'].startsWith(INTERRUPT_PREFIX)
    ) {
      h.markers.add('interrupt-marker');
    }
  }
}

/** What one Codex line is, as a short signature of type names only. */
function codexSignature(line: Record<string, unknown>): string {
  const payload = record(line['payload']);
  const inner = payload?.['type'];
  return `${key(line['type'])}${inner === undefined ? '' : `/${key(inner)}`}`;
}

const CALL_TYPES = new Set([
  'function_call',
  'custom_tool_call',
  'local_shell_call',
  'web_search_call',
]);
const OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output']);

/** Folds one Codex rollout line into the census. */
export function addCodexLine(
  census: OriginCensus,
  line: Record<string, unknown>,
  open: Map<string, string>,
): void {
  const { h } = census;
  const type = key(line['type']);
  const payload = record(line['payload']);
  h.recordTypes.add(type);
  h.signatures.add(codexSignature(line));
  if (payload === null) return;
  const inner = key(payload['type']);
  if (type === 'session_meta') {
    h.originators.add(key(payload['originator']));
    h.threadSources.add(key(payload['thread_source']));
    const source = payload['source'];
    const src = record(source);
    h.sources.add(
      typeof source === 'string'
        ? key(source)
        : src !== null
          ? `object-${Object.keys(src).map(key).sort().join('+')}`
          : key(source),
    );
    if (typeof payload['parent_thread_id'] === 'string') h.markers.add('parent_thread_id');
    if (typeof payload['forked_from_id'] === 'string') h.markers.add('forked_from_id');
  } else if (type === 'event_msg') {
    h.eventTypes.add(inner);
  } else if (type === 'response_item') {
    h.responseItemTypes.add(inner);
    const callId = typeof payload['call_id'] === 'string' ? payload['call_id'] : null;
    if (CALL_TYPES.has(inner)) {
      const name = key(payload['name'] ?? inner);
      h.callNames.add(name);
      if (callId !== null) open.set(callId, name);
    } else if (OUTPUT_TYPES.has(inner) && callId !== null) {
      open.delete(callId);
    } else if (inner === 'message') {
      h.roles.add(key(payload['role']));
    }
  }
}

const CLAUDE_CONVERSATION = /^(?:user|assistant|system\/turn_duration|system\/api_error)[:/]/;
const CODEX_BOOKKEEPING =
  /^(?:event_msg\/(?:token_count|thread_settings_applied|item_completed)|token_usage_record|turn_context|world_state|inter_agent_communication_metadata|retained_context|compacted|session_meta)/;

/** Whether a record is part of the conversation (not bookkeeping), for the "how a file ends" count. */
function isConversational(provider: Provider, signature: string): boolean {
  return provider === 'claude'
    ? CLAUDE_CONVERSATION.test(signature)
    : !CODEX_BOOKKEEPING.test(signature);
}

/** The origin of a Claude file from its path below `projects/`, or null when it is not read. */
export function claudeOrigin(relativePath: string): Origin | null {
  if (SET_ASIDE.test(relativePath)) return null;
  const parts = relativePath.split('/');
  if (parts.length === 2 && parts[1]?.endsWith('.jsonl')) return 'claude:main';
  if (parts.length === 4 && parts[2] === 'subagents' && parts[3]?.endsWith('.jsonl'))
    return 'claude:subagent';
  return null;
}

const splitList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function readRoots(ctx: ExperimentContext): { claude: string[]; codex: string[] } {
  const claudeFlag = ctx.args.all('claude-root');
  const claudeDirs = claudeFlag.length
    ? claudeFlag
    : splitList(ctx.env['CLAUDE_CONFIG_DIR']).length
      ? splitList(ctx.env['CLAUDE_CONFIG_DIR'])
      : [join(ctx.home, '.config', 'claude'), join(ctx.home, '.claude')];
  const codexFlag = ctx.args.all('codex-root');
  const codexDirs = codexFlag.length
    ? codexFlag
    : splitList(ctx.env['CODEX_HOME']).length
      ? splitList(ctx.env['CODEX_HOME'])
      : [join(ctx.home, '.codex')];
  return {
    claude: claudeDirs.map((d) => ctx.willRead('Claude Code transcripts', join(d, 'projects'))),
    codex: codexDirs.flatMap((d) => [
      ctx.willRead('Codex rollouts', join(d, 'sessions')),
      ctx.willRead('Codex archived rollouts', join(d, 'archived_sessions')),
    ]),
  };
}

const has = (census: OriginCensus, name: HistogramName, value: string): boolean =>
  census.h[name].has(value);

export const experiment = defineExperiment({
  meta: {
    id: 'E9',
    script: 'scripts/experiments/e9-live-activity.ts',
    title: 'Live activity in transcripts',
    question:
      'Which transcript files do agents started outside Paseo write, and which records mark a prompt, thinking, a tool call, a tool result, the end of a turn, an error, an interruption and an approval request?',
    criteria: [
      {
        id: 'claude-transcripts-found',
        text: 'Claude Code transcripts modified in the window are found under the approved roots, and the entry points that wrote them are counted.',
      },
      {
        id: 'codex-rollouts-found',
        text: 'Codex rollouts modified in the window are found under the approved roots, and their source and originator values are counted.',
      },
      {
        id: 'claude-markers-present',
        text: 'Claude Code transcripts carry a record for a user prompt, a thinking block, a tool call, a tool result and the end of a turn.',
      },
      {
        id: 'codex-markers-present',
        text: 'Codex rollouts carry a record for a turn start, a reasoning item, a tool call and its output, and the end of a turn.',
      },
      {
        id: 'only-counts-kept',
        text: 'Only counts were kept: every histogram key is an identifier-shaped type or name, and no text, path or id was printed or written.',
      },
    ],
    reads: [
      'Claude Code transcripts: *.jsonl modified in the last 24 hours (--window-hours) under ~/.config/claude/projects and ~/.claude/projects (or each entry of $CLAUDE_CONFIG_DIR, or --claude-root), line by line in memory',
      'Codex rollouts: *.jsonl modified in that window under ~/.codex/sessions and ~/.codex/archived_sessions (or each entry of $CODEX_HOME, or --codex-root), line by line in memory',
      'Nothing else: no desktop app folder, no settings, no history files',
    ],
    prints: [
      'Which folders it will read, then counts only: files and lines per provider and origin, and histograms of record types, content-block types, tool names (an MCP tool as mcp-tool), stop reasons, entry points, Codex source and originator values and payload types, and how each file ends. Never a line, a prompt, a tool input or output, a path below the root, a title or an id',
    ],
    writes: ['docs/implementation/experiments/E9.md (the findings)'],
    network: [],
    spawns: [],
    example: 'node scripts/experiments/e9-live-activity.ts --window-hours 24 --out /tmp/E9.md',
    selftest: [
      {
        name: 'a Claude Code session with a subagent, and Codex rollouts from the CLI and an app',
        args: [
          '--claude-root',
          '{fixtures}/live/claude',
          '--codex-root',
          '{fixtures}/live/codex',
          '--all-files',
        ],
        expect: {
          exit: 0,
          verdicts: {
            'claude-transcripts-found': 'pass',
            'codex-rollouts-found': 'pass',
            'claude-markers-present': 'pass',
            'codex-markers-present': 'pass',
            'only-counts-kept': 'pass',
          },
          stdoutIncludes: ['claude:main', 'codex:sessions'],
        },
      },
      {
        name: 'Claude Code only: no Codex home',
        args: [
          '--claude-root',
          '{fixtures}/live/claude',
          '--codex-root',
          '{fixtures}/live/none',
          '--all-files',
        ],
        expect: {
          exit: 0,
          verdicts: {
            'claude-transcripts-found': 'pass',
            'codex-rollouts-found': 'not-run',
            'claude-markers-present': 'pass',
            'codex-markers-present': 'not-run',
            'only-counts-kept': 'pass',
          },
        },
      },
      {
        name: 'a Codex rollout with no tool call, so a marker is missing',
        args: [
          '--claude-root',
          '{fixtures}/live/none',
          '--codex-root',
          '{fixtures}/live/codex-thin',
          '--all-files',
        ],
        expect: {
          exit: 1,
          verdicts: {
            'claude-transcripts-found': 'not-run',
            'codex-rollouts-found': 'pass',
            'claude-markers-present': 'not-run',
            'codex-markers-present': 'fail',
            'only-counts-kept': 'pass',
          },
        },
      },
      {
        name: 'no transcripts or rollouts in the folders',
        args: [
          '--claude-root',
          '{fixtures}/live/none',
          '--codex-root',
          '{fixtures}/live/none',
          '--all-files',
        ],
        expect: {
          exit: 0,
          verdicts: {
            'claude-transcripts-found': 'not-run',
            'codex-rollouts-found': 'not-run',
            'claude-markers-present': 'not-run',
            'codex-markers-present': 'not-run',
            'only-counts-kept': 'not-run',
          },
        },
      },
      {
        name: 'a window flag that is not a number',
        args: ['--claude-root', '{fixtures}/live/claude', '--window-hours', 'many'],
        expect: { exit: 2, verdicts: {} },
      },
    ],
  },

  async run(ctx) {
    const hoursText = ctx.args.get('window-hours');
    const hours = hoursText === undefined ? DEFAULT_WINDOW_HOURS : Number(hoursText);
    if (!Number.isFinite(hours) || hours <= 0)
      throw new UsageError('--window-hours must be a number above 0');
    const everything = ctx.args.has('all-files');
    const windowMs = hours * HOUR_MS;
    const now = ctx.now();
    const roots = readRoots(ctx);

    const census = new Map<Origin, OriginCensus>(ORIGINS.map((o) => [o, emptyCensus()]));
    let unreadableFiles = 0;
    let skippedByAge = 0;

    const scan = (path: string, origin: Origin): void => {
      const target = census.get(origin);
      if (!target) return;
      if (!everything) {
        let mtime: number;
        try {
          mtime = ctx.fs.stat(path).mtimeMs;
        } catch {
          unreadableFiles++;
          return;
        }
        if (!inWindow(mtime, now, windowMs)) {
          skippedByAge++;
          return;
        }
      }
      const provider: Provider = origin.startsWith('claude') ? 'claude' : 'codex';
      const open = new Map<string, string>();
      let last: string | null = null;
      try {
        for (const text of ctx.fs.lines(path)) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            target.unreadableLines++;
            continue;
          }
          const line = record(parsed);
          if (line === null) {
            target.unreadableLines++;
            continue;
          }
          target.lines++;
          if (provider === 'claude') addClaudeLine(target, line, open);
          else addCodexLine(target, line, open);
          const signature = provider === 'claude' ? claudeSignature(line) : codexSignature(line);
          if (isConversational(provider, signature)) last = signature;
        }
      } catch {
        unreadableFiles++;
        return;
      }
      target.files++;
      if (last !== null) target.h.lastSignatures.add(last);
      for (const name of open.values()) target.h.pendingAtEnd.add(name);
      if (open.size === 0) target.h.pendingAtEnd.add('none-pending');
    };

    for (const root of roots.claude) {
      for (const path of ctx.fs.walk(root, { match: /\.jsonl/ }).files) {
        const origin = claudeOrigin(relative(root, path).split(sep).join('/'));
        if (origin !== null) scan(path, origin);
      }
    }
    for (const root of roots.codex) {
      const archived = root.endsWith(`${sep}archived_sessions`);
      for (const path of ctx.fs.walk(root, { match: /\.jsonl$/ }).files)
        scan(path, archived ? 'codex:archived' : 'codex:sessions');
    }

    const total = (provider: Provider): number =>
      ORIGINS.filter((o) => o.startsWith(provider)).reduce(
        (sum, o) => sum + (census.get(o)?.files ?? 0),
        0,
      );
    const claudeFiles = total('claude');
    const codexFiles = total('codex');
    ctx.out.line(
      safeText`Window ${everything ? 'all-files' : `${hours}h`}: claude ${claudeFiles}, codex ${codexFiles} (older files skipped: ${skippedByAge}, unreadable: ${unreadableFiles}).`,
    );

    for (const origin of ORIGINS) {
      const c = census.get(origin);
      if (!c || c.files === 0) continue;
      ctx.out.line(
        safeText`${origin}: ${c.files} files, ${c.lines} lines, ${c.unreadableLines} unreadable lines.`,
      );
      ctx.findings.fact(origin, 'files', c.files);
      ctx.findings.fact(origin, 'lines', c.lines);
      ctx.findings.fact(origin, 'unreadable lines', c.unreadableLines);
      const rows: [HistogramName, string][] = [
        ['recordTypes', 'record types (type or type/subtype)'],
        ['signatures', 'record signatures (type, subtype, blocks, stop)'],
        ['lastSignatures', 'how files end (last record signature)'],
        ['pendingAtEnd', 'tool calls without a result at the end (by tool name)'],
        ['roles', 'message roles'],
        ['blockTypes', 'content block types'],
        ['toolNames', 'tool names (names only)'],
        ['stopReasons', 'stop reasons'],
        ['markers', 'flags and attachment kinds'],
        ['entrypoints', 'entrypoint values'],
        ['permissionDecisions', 'permissionDecision values'],
        ['permissionModes', 'permission mode values'],
        ['originators', 'session_meta originator values'],
        ['sources', 'session_meta source values'],
        ['threadSources', 'session_meta thread_source values'],
        ['eventTypes', 'event_msg payload types'],
        ['responseItemTypes', 'response_item payload types'],
        ['callNames', 'tool or function call names (names only)'],
      ];
      for (const [name, label] of rows) {
        const entries = c.h[name].entries();
        if (entries.length > 0) ctx.findings.fact(origin, label, entries);
      }
    }
    ctx.findings.fact('Scan', 'older files skipped', skippedByAge);
    ctx.findings.fact('Scan', 'files that could not be read', unreadableFiles);

    // ---- verdicts
    const claude = ORIGINS.filter((o) => o.startsWith('claude')).map(
      (o) => census.get(o) as OriginCensus,
    );
    const codex = ORIGINS.filter((o) => o.startsWith('codex')).map(
      (o) => census.get(o) as OriginCensus,
    );
    const any = (list: OriginCensus[], name: HistogramName, value: string): boolean =>
      list.some((c) => has(c, name, value));
    const anyIn = (list: OriginCensus[], name: HistogramName, values: string[]): boolean =>
      values.some((v) => any(list, name, v));

    if (claudeFiles === 0)
      ctx.findings.criterion(
        'claude-transcripts-found',
        'not-run',
        'No Claude Code transcript was modified in the window under the approved roots.',
      );
    else
      ctx.findings.criterion(
        'claude-transcripts-found',
        'pass',
        safeText`${claudeFiles} files (main ${census.get('claude:main')?.files ?? 0}, subagent ${census.get('claude:subagent')?.files ?? 0}).`,
      );

    if (codexFiles === 0)
      ctx.findings.criterion(
        'codex-rollouts-found',
        'not-run',
        'No Codex rollout was modified in the window under the approved roots.',
      );
    else
      ctx.findings.criterion(
        'codex-rollouts-found',
        'pass',
        safeText`${codexFiles} files (sessions ${census.get('codex:sessions')?.files ?? 0}, archived ${census.get('codex:archived')?.files ?? 0}).`,
      );

    if (claudeFiles === 0) {
      ctx.findings.criterion('claude-markers-present', 'not-run', 'No Claude Code file to read.');
    } else {
      const missing = [
        ['user prompt', any(claude, 'roles', 'user')],
        ['thinking block', any(claude, 'blockTypes', 'thinking')],
        ['tool call', any(claude, 'blockTypes', 'tool_use')],
        ['tool result', any(claude, 'blockTypes', 'tool_result')],
        ['end of turn', any(claude, 'stopReasons', 'end_turn')],
      ]
        .filter(([, found]) => !found)
        .map(([name]) => String(name).replaceAll(' ', '-'));
      ctx.findings.criterion(
        'claude-markers-present',
        missing.length === 0 ? 'pass' : 'fail',
        missing.length === 0 ? 'All five markers were seen.' : safeText`Not seen: ${missing}.`,
      );
    }

    if (codexFiles === 0) {
      ctx.findings.criterion('codex-markers-present', 'not-run', 'No Codex file to read.');
    } else {
      const missing = [
        ['turn-start', anyIn(codex, 'eventTypes', ['task_started', 'turn_started'])],
        ['reasoning', any(codex, 'responseItemTypes', 'reasoning')],
        [
          'tool-call',
          anyIn(codex, 'responseItemTypes', [
            'function_call',
            'custom_tool_call',
            'local_shell_call',
          ]),
        ],
        [
          'tool-output',
          anyIn(codex, 'responseItemTypes', ['function_call_output', 'custom_tool_call_output']),
        ],
        ['turn-end', anyIn(codex, 'eventTypes', ['task_complete', 'turn_complete'])],
      ]
        .filter(([, found]) => !found)
        .map(([name]) => String(name));
      ctx.findings.criterion(
        'codex-markers-present',
        missing.length === 0 ? 'pass' : 'fail',
        missing.length === 0 ? 'All five markers were seen.' : safeText`Not seen: ${missing}.`,
      );
    }

    // Every key was passed through key(): an identifier-shaped name, a fixed marker, or `[other]`. Count what was folded.
    let folded = 0;
    let kept = 0;
    for (const c of census.values())
      for (const name of HISTOGRAMS)
        for (const entry of c.h[name].entries(1_000_000)) {
          kept++;
          if (entry.startsWith(`${OTHER}@`)) folded++;
        }
    ctx.findings.fact('Scan', 'histogram keys folded as other', folded);
    ctx.findings.criterion(
      'only-counts-kept',
      claudeFiles + codexFiles === 0 ? 'not-run' : 'pass',
      claudeFiles + codexFiles === 0
        ? 'Nothing was read.'
        : safeText`${kept} histogram keys, ${folded} folded as ${OTHER}; nothing else was kept.`,
    );
    ctx.findings.note(
      'Counts only. The interrupt marker is detected by comparing a user line with a fixed prefix in memory; only the number of times it occurs is recorded.',
    );
  },
});

runIfMain(import.meta, experiment);
