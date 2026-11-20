import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { UsageError } from './lib/args.ts';
import { defineExperiment, runHookIfMain, runIfMain } from './lib/cli.ts';
import { safeText } from './lib/redact.ts';
import { assertNoSecrets, findSecrets } from './lib/secrets.ts';
import type { ExperimentContext, TempWorkspace } from './lib/types.ts';

// E8 · Claude status-line probe (TECH › Feasibility experiments E8, data-and-sources › Status-line snapshot).
//
// Three modes in one file:
//   --prepare   builds a throwaway CLAUDE_CONFIG_DIR inside a new temporary folder (the only place this experiment writes)
//               whose user-level `statusLine` runs this file as the hook, plus a project folder with its own `statusLine`;
//   the hook    (`--hook --dir <folder>`, started by Claude Code, never by hand) appends one line per status-line run to
//               samples.jsonl: field names, numbers, hashed ids and the version, never text, paths or credentials;
//   --report    reads those samples back and sets the verdicts.
// Nothing is ever written to ~/.claude, to any real settings file, or anywhere but that temporary folder. The real settings
// are only touched later, by the product, after Kelvin confirms the preview (TECH E8: "then Kelvin's real settings only
// after he confirms the preview").

const OVERHEAD_BUDGET_MS = 100; // TECH › Performance: ≤ 100 ms p95, Node start-up included
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?$/;
const SAMPLES = 'samples.jsonl';
const USER_SETTINGS = 'claude-config/settings.json';
const PROJECT_SETTINGS = 'project-with-statusline/.claude/settings.json';
const BASELINE_SETTINGS = 'claude-baseline/settings.json';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const digest = (value: unknown): string | null =>
  typeof value === 'string' && value !== ''
    ? createHash('sha256').update(value).digest('hex').slice(0, 12)
    : null;

// ---------------------------------------------------------------------------------------------------------------------
// The hook. Pure: status-line input in, a record of field names, numbers and hashes out.

function windowOf(
  value: unknown,
): { used_percentage: number | null; resets_at: number | null } | null {
  return isRecord(value)
    ? { used_percentage: num(value['used_percentage']), resets_at: num(value['resets_at']) }
    : null;
}

export function describeInput(stdin: string): Record<string, unknown> {
  let data: unknown = null;
  try {
    data = JSON.parse(stdin);
  } catch {
    data = null;
  }
  const input = isRecord(data) ? data : null;
  const limits = input && isRecord(input['rate_limits']) ? input['rate_limits'] : null;
  const where = input && isRecord(input['workspace']) ? input['workspace'] : null;
  const version = input?.['version'];
  return {
    stdin_bytes: Buffer.byteLength(stdin),
    parse_ok: input !== null,
    keys: input
      ? Object.keys(input)
          .filter((k) => FIELD.test(k))
          .sort()
          .slice(0, 60)
      : [],
    rate_limit_keys: limits
      ? Object.keys(limits)
          .filter((k) => FIELD.test(k))
          .sort()
          .slice(0, 20)
      : [],
    five_hour: limits ? windowOf(limits['five_hour']) : null,
    seven_day: limits ? windowOf(limits['seven_day']) : null,
    version: typeof version === 'string' && VERSION.test(version) ? version : null,
    session: digest(input?.['session_id']),
    cwd: digest(where?.['current_dir'] ?? input?.['cwd']),
  };
}

// The snapshot goes first, before any other work, so it still lands when Claude Code cancels the script on a rapid update
// (updates are debounced 300 ms). `--hold-ms` then waits, standing in for a slow chained status line, so a cancellation
// shows up as a `start` line with no matching `end`. The hook prints nothing and always exits 0 (runHookIfMain).
runHookIfMain(import.meta, async ({ stdin, args, now, workspace }) => {
  const folder = workspace();
  const inv = randomUUID().slice(0, 8);
  const role = args.get('role') === 'project' ? 'project' : 'user';
  folder.append(
    SAMPLES,
    `${JSON.stringify({ v: 1, phase: 'start', inv, role, t: now(), up_ms: Math.round(process.uptime() * 1000), ...describeInput(stdin) })}\n`,
  );
  const hold = Number(args.get('hold-ms') ?? 0);
  if (hold > 0) await sleep(Math.min(hold, 5_000));
  folder.append(
    SAMPLES,
    `${JSON.stringify({ v: 1, phase: 'end', inv, t: now(), up_ms: Math.round(process.uptime() * 1000) })}\n`,
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// prepare

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Whether a temporary settings file wires the hook as its user-level status line. Reports the verdict and the facts. */
function checkSettings(ctx: ExperimentContext, content: string | null): void {
  let parsed: unknown;
  try {
    parsed = content === null ? undefined : JSON.parse(content);
  } catch {
    parsed = undefined;
  }
  const line = isRecord(parsed) ? parsed['statusLine'] : undefined;
  const command = isRecord(line) && typeof line['command'] === 'string' ? line['command'] : null;
  const wired =
    isRecord(line) && line['type'] === 'command' && command !== null && command.includes('--hook');
  ctx.findings.fact('Temporary configuration', 'settings file present', content !== null);
  ctx.findings.fact('Temporary configuration', 'its statusLine runs the probe hook', wired);
  if (content === null)
    ctx.findings.criterion(
      'config-dir-prepared',
      'not-run',
      'The folder has no claude-config/settings.json: run --prepare first.',
    );
  else
    ctx.findings.criterion(
      'config-dir-prepared',
      wired ? 'pass' : 'fail',
      wired
        ? 'The temporary CLAUDE_CONFIG_DIR holds a user-level statusLine that runs the probe hook; no real settings file is involved.'
        : 'The temporary settings file does not wire the probe hook as its statusLine.',
    );
}

/**
 * The only settings a seed file may lend to the temporary configuration. Each is a documented user-level preference
 * (Claude Code's Settings page, R5: the default model, the effort level, the theme) that cannot hold a command, a path, a
 * URL or a key. Nothing else is ever copied: not env, hooks, apiKeyHelper, awsAuthRefresh, permissions, MCP servers, any
 * object or array, or any name not listed here. A seed file may be a copy of a real settings file, so what it holds is
 * treated as unsafe until it is on this list.
 */
const SEED_KEYS = ['effortLevel', 'model', 'theme'] as const;
/** A plain word: letters, digits, dot, underscore and hyphen. No slash, colon, space or quote, so no path, URL or command. */
const PLAIN_WORD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The plain preferences of a seed, and how many of its other top-level entries were left out (never their names). */
export function plainSeed(seed: Record<string, unknown>): {
  kept: Record<string, unknown>;
  leftOut: number;
} {
  const kept: Record<string, unknown> = {};
  for (const key of SEED_KEYS) {
    const value = seed[key];
    if (
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && PLAIN_WORD.test(value) && findSecrets(value).length === 0)
    )
      kept[key] = value;
  }
  const others = Object.keys(seed).filter((k) => k !== 'statusLine').length;
  return { kept, leftOut: others - Object.keys(kept).length };
}

function prepare(ctx: ExperimentContext): void {
  let base: Record<string, unknown> = {};
  const seed = ctx.args.get('seed-settings');
  if (seed !== undefined) {
    // A copy of your real settings may be given so the temporary configuration has the same model, effort level and theme.
    // It is only read, and only plainSeed's short list is taken from it.
    const path = ctx.willRead('Settings to copy plain preferences from (read only)', seed);
    let parsed: unknown;
    try {
      parsed = JSON.parse(ctx.fs.readText(path, { maxBytes: 1_000_000 }));
    } catch {
      parsed = undefined;
    }
    if (!isRecord(parsed)) {
      ctx.findings.criterion(
        'config-dir-prepared',
        'fail',
        'The --seed-settings file is missing or is not a JSON object, so no temporary configuration was made.',
      );
      return;
    }
    const previous = parsed['statusLine'];
    const { kept, leftOut } = plainSeed(parsed);
    base = kept;
    ctx.findings.fact('Seed settings', 'plain preferences copied', Object.keys(kept).length);
    ctx.findings.fact('Seed settings', 'other entries left out, never copied', leftOut);
    ctx.findings.fact('Seed settings', 'had a statusLine of its own', previous !== undefined);
    if (isRecord(previous) && typeof previous['type'] === 'string')
      ctx.findings.fact('Seed settings', 'its statusLine type', previous['type']);
    ctx.out.line(
      safeText`Seed settings: ${Object.keys(kept).length} plain preferences copied, ${leftOut} other entries left out (credentials, commands and paths are never copied).`,
    );
  }

  const folder: TempWorkspace = ctx.workspace.create('crew-e8');
  const hook = (role: 'user' | 'project'): string =>
    [
      shellQuote(process.execPath),
      shellQuote(import.meta.filename),
      '--hook',
      '--dir',
      shellQuote(folder.dir),
      '--role',
      role,
      '--hold-ms',
      '600',
    ].join(' ');
  const userSettings = json({
    ...base,
    statusLine: { type: 'command', command: hook('user'), padding: 0 },
  });
  assertNoSecrets(userSettings, 'write the temporary settings');
  folder.write(USER_SETTINGS, userSettings);
  folder.write(
    PROJECT_SETTINGS,
    json({ statusLine: { type: 'command', command: hook('project'), padding: 0 } }),
  );
  folder.write(
    'project-plain/NOTE.txt',
    'A folder with no settings of its own: start Claude Code here to see the user-level status line.\n',
  );
  folder.write(BASELINE_SETTINGS, '{}\n');
  folder.write(SAMPLES, '');
  checkSettings(ctx, folder.read(USER_SETTINGS));
  ctx.findings.fact('Temporary configuration', 'written only inside the temporary folder', true);

  const dir = folder.dir;
  for (const line of [
    'Prepared. Your real Claude Code settings were not touched. Here is what to do next, in a terminal:',
    '',
    `Everything below runs in a throwaway copy of Claude Code's settings kept in ${dir}. Delete that folder when you are done.`,
    'You will use Claude Code for a few minutes in four ways while a small probe notes what Claude Code sends it (never your messages),',
    'then run one report command. Steps 1 to 4 are all needed: a step you skip is reported as "not run", never as a pass.',
    '',
    'Step 1 · a first session with the probe on',
    `  cd ${dir}/project-plain && CLAUDE_CONFIG_DIR=${dir}/claude-config claude`,
    '  - If it asks you to sign in, sign in with your own account: this throwaway copy has no sign-in of its own yet.',
    '  - Send three short messages (for example "hi").',
    '  - To make Claude Code cancel the probe mid-run, press Shift+Tab about twice a second for five seconds (it changes the permission mode,',
    '    and every change makes Claude Code run the status line again). Sending two messages very quickly one after the other also works.',
    '  - Look at the very bottom of the screen and note the footer hints (see "Footer hints" below). Leave this window open.',
    '',
    'Step 2 · a second session at the same time',
    '  Open a second terminal window and run the same command as step 1. Send a message in the first window, then in the second, then in the',
    '  first again, a few times. Then type /exit in both windows.',
    '',
    'Step 3 · a project that has a status line of its own',
    `  cd ${dir}/project-with-statusline && CLAUDE_CONFIG_DIR=${dir}/claude-config claude`,
    "  Send one message, then type /exit. (This checks that a project's own status line replaces the probe there.)",
    '',
    'Step 4 · Claude Code with no status line, to compare the footer',
    `  cd ${dir}/project-plain && CLAUDE_CONFIG_DIR=${dir}/claude-baseline claude`,
    '  Sign in again if asked. Look at the bottom of the screen and note the footer hints again, then type /exit.',
    '',
    'Step 5 · the report',
    `  node scripts/experiments/e8-claude-probe.ts --report --dir ${dir} --footer-hints-without <hints from step 4> --footer-hints-with <hints from step 1>`,
    '  Run it again after more use if the report says a check was "not run": it names what to do.',
    '',
    "Footer hints: the small grey keyboard reminders on the bottom line of Claude Code, under the box you type in. Claude Code's own",
    'documentation names three: "? for shortcuts" (usually shown when the box is empty), "esc to interrupt" (usually shown while Claude is',
    'answering) and "hold space to speak" (voice dictation). With a custom status line on, Claude Code hides most of them and puts the',
    'status line in its own row. This probe prints nothing, so its row looks blank.',
    'What to type: one short lowercase word for each hint you can see, separated by commas with no spaces. Use shortcuts, esc-to-interrupt',
    'and hold-space-to-speak for those three, and make up a short lowercase name with hyphens for any other (for example shift-tab-to-cycle).',
    'If you see no hints at all with the probe on, type none for --footer-hints-with. The list from step 4 needs at least one hint.',
  ])
    ctx.out.line(line);
}

// ---------------------------------------------------------------------------------------------------------------------
// report

interface Figures {
  used: number;
  resets: number;
}

interface Start {
  inv: string;
  role: 'user' | 'project';
  upMs: number | null;
  fiveHour: boolean;
  sevenDay: boolean;
  /** The figures each window carried, for telling whether a later arrival brought an older one. */
  five: Figures | null;
  seven: Figures | null;
  hasRateLimits: boolean;
  version: string | null;
  session: string | null;
  cwd: string | null;
  keys: string[];
}

const hasWindow = (value: unknown): boolean =>
  isRecord(value) && num(value['used_percentage']) !== null && num(value['resets_at']) !== null;
const figuresOf = (value: unknown): Figures | null => {
  if (!isRecord(value)) return null;
  const used = num(value['used_percentage']);
  const resets = num(value['resets_at']);
  return used !== null && resets !== null ? { used, resets } : null;
};
const fieldNames = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((k): k is string => typeof k === 'string' && FIELD.test(k))
    : [];

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;

// ---------------------------------------------------------------------------------------------------------------------
// footer hints and concurrent sessions (G3_6)

/** A hint is named by the owner with a short lowercase word, so it can only ever be an identifier. */
const HINT = /^[a-z][a-z0-9-]{0,39}$/;
/** What the owner types to say "I saw no hints in this view": an empty list, not a hint that is named none. */
const NO_HINTS = 'none';

export function hintList(values: string[]): { ids: string[]; ignored: number } {
  const ids = new Set<string>();
  let ignored = 0;
  for (const raw of values.flatMap((v) => v.split(','))) {
    const word = raw.trim().toLowerCase();
    if (word === '' || word === NO_HINTS) continue;
    if (word !== 'true' && HINT.test(word)) ids.add(word);
    else ignored++; // "true" is what a flag with no value reads as
  }
  return { ids: [...ids].sort(), ignored };
}

/**
 * Which footer hints disappear (TECH E8 item 3 ii, with the probe printing nothing). A hook cannot see the screen, so the
 * owner names the hints in two short lists: with no status line and with the probe's.
 */
function footerHints(ctx: ExperimentContext): void {
  const id = 'footer-hints-recorded';
  if (!ctx.args.has('footer-hints-without') || !ctx.args.has('footer-hints-with')) {
    ctx.findings.criterion(
      id,
      'not-run',
      'Not recorded: look at the small keyboard hints at the bottom of Claude Code with no status line and with the probe, then give --footer-hints-without and --footer-hints-with, each a comma-separated list of short lowercase words such as shortcuts, esc-to-interrupt or hold-space-to-speak (type none if you saw no hints with the probe). --prepare prints the steps.',
    );
    return;
  }
  const without = hintList(ctx.args.all('footer-hints-without'));
  const withProbe = hintList(ctx.args.all('footer-hints-with'));
  const gone = without.ids.filter((h) => !withProbe.ids.includes(h));
  const added = withProbe.ids.filter((h) => !without.ids.includes(h));
  const list = (ids: string[]) => (ids.length > 0 ? ids : ['none']);
  ctx.findings.fact('Footer hints', 'seen with no status line', list(without.ids));
  ctx.findings.fact('Footer hints', 'seen with the probe status line', list(withProbe.ids));
  ctx.findings.fact('Footer hints', 'disappeared with the probe status line', list(gone));
  ctx.findings.fact('Footer hints', 'appeared only with the probe status line', list(added));
  ctx.findings.fact(
    'Footer hints',
    'entries ignored (not short lowercase words)',
    without.ignored + withProbe.ignored,
  );
  if (without.ids.length === 0 || (withProbe.ids.length === 0 && withProbe.ignored > 0)) {
    ctx.findings.criterion(
      id,
      'fail',
      'The lists held no usable hint names: use short lowercase words, for example shortcuts, esc-to-interrupt or hold-space-to-speak. The list for Claude Code with no status line needs at least one; type none for the probe list if you saw no hints with it.',
    );
    return;
  }
  ctx.out.line(
    safeText`Footer hints that disappear with the probe status line: ${list(gone)}. Compact line: not tested (needs the product wrapper).`,
  );
  ctx.findings.criterion(
    id,
    'pass',
    safeText`${without.ids.length} hints seen with no status line, ${withProbe.ids.length} with the probe; ${gone.length} disappeared and ${added.length} appeared.`,
  );
}

/** Walks the arrivals in order; counts those that carry a lower figure than an earlier arrival in the same window. */
function olderArrivals(
  starts: Start[],
  pick: (s: Start) => Figures | null,
): { lower: number; otherSession: number } {
  const peak = new Map<number, { used: number; session: string | null }>();
  let lower = 0;
  let otherSession = 0;
  for (const s of starts) {
    const figures = pick(s);
    if (!figures) continue;
    const seen = peak.get(figures.resets);
    if (!seen || figures.used > seen.used)
      peak.set(figures.resets, { used: figures.used, session: s.session });
    else if (figures.used < seen.used) {
      lower++;
      if (s.session !== seen.session) otherSession++;
    }
  }
  return { lower, otherSession };
}

/**
 * Two sessions ran at once when their runs interleave (A, then B, then A again). The hook sees what each is sent, so this
 * records whether every concurrent session receives both windows and how often an arrival carries an older figure than an
 * earlier one (the product must never let that replace a newer snapshot: TECH E8 item 5, built in M9).
 */
function concurrentSessions(ctx: ExperimentContext, starts: Start[]): void {
  const id = 'concurrent-sessions-observed';
  const arrivals = new Map<string, number[]>();
  starts.forEach((s, i) => {
    if (s.session) arrivals.set(s.session, [...(arrivals.get(s.session) ?? []), i]);
  });
  const sessions = [...arrivals.keys()].slice(0, 50);
  const members = new Set<string>();
  let pairs = 0;
  for (let a = 0; a < sessions.length; a++) {
    for (let b = a + 1; b < sessions.length; b++) {
      const merged = [
        ...arrivals.get(sessions[a]!)!.map((i) => [i, a] as const),
        ...arrivals.get(sessions[b]!)!.map((i) => [i, b] as const),
      ].sort((x, y) => x[0] - y[0]);
      let switches = 0;
      for (let k = 1; k < merged.length; k++) if (merged[k]![1] !== merged[k - 1]![1]) switches++;
      if (switches >= 2) {
        pairs++;
        members.add(sessions[a]!);
        members.add(sessions[b]!);
      }
    }
  }
  const received = (session: string) =>
    starts.some((s) => s.session === session && s.fiveHour && s.sevenDay);
  const missing = [...members].filter((m) => !received(m));
  const five = olderArrivals(starts, (s) => s.five);
  const seven = olderArrivals(starts, (s) => s.seven);
  ctx.findings.fact('Concurrent sessions', 'sessions seen (hashed)', sessions.length);
  ctx.findings.fact('Concurrent sessions', 'pairs of sessions whose runs interleave', pairs);
  ctx.findings.fact('Concurrent sessions', 'sessions in those pairs', members.size);
  ctx.findings.fact('Concurrent sessions', 'of those, never sent both windows', missing.length);
  ctx.findings.fact(
    'Concurrent sessions',
    'five_hour arrivals lower than an earlier one',
    five.lower,
  );
  ctx.findings.fact(
    'Concurrent sessions',
    'seven_day arrivals lower than an earlier one',
    seven.lower,
  );
  ctx.findings.fact(
    'Concurrent sessions',
    'of those, from a different session than the higher figure',
    five.otherSession + seven.otherSession,
  );
  ctx.out.line(
    safeText`Sessions seen: ${sessions.length}; pairs that ran at once: ${pairs}; arrivals with an older figure: ${five.lower + seven.lower}.`,
  );
  if (pairs === 0) {
    ctx.findings.criterion(
      id,
      'not-run',
      'Fewer than two sessions ran at the same time: start Claude Code in two terminals the same way, send messages in both, then run --report again.',
    );
  } else if (missing.length === members.size) {
    ctx.findings.criterion(
      id,
      'not-run',
      'No session received both windows, so concurrent delivery cannot be judged (see the rate_limits criterion).',
    );
  } else {
    ctx.findings.criterion(
      id,
      missing.length === 0 ? 'pass' : 'fail',
      missing.length === 0
        ? safeText`${pairs} pairs of sessions ran at once (${members.size} sessions) and each was sent both windows; ${five.lower + seven.lower} arrivals carried an older figure than an earlier one.`
        : safeText`${missing.length} of ${members.size} sessions that ran at once were never sent both windows.`,
    );
  }
}

function report(ctx: ExperimentContext): void {
  const dir = ctx.args.get('dir');
  if (!dir) throw new UsageError('--report needs --dir <the folder --prepare printed>');
  const root = ctx.willRead('E8 probe folder: its temporary settings and samples.jsonl', dir);

  const settingsPath = join(root, USER_SETTINGS);
  checkSettings(
    ctx,
    ctx.fs.exists(settingsPath) ? ctx.fs.readText(settingsPath, { maxBytes: 1_000_000 }) : null,
  );

  footerHints(ctx);

  const samplesPath = join(root, SAMPLES);
  const starts: Start[] = [];
  const ended = new Set<string>();
  let unreadable = 0;
  if (ctx.fs.exists(samplesPath)) {
    for (const line of ctx.fs.lines(samplesPath)) {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        unreadable++;
        continue;
      }
      if (!isRecord(record) || typeof record['inv'] !== 'string') {
        unreadable++;
        continue;
      }
      if (record['phase'] === 'end') {
        ended.add(record['inv']);
      } else if (record['phase'] === 'start') {
        starts.push({
          inv: record['inv'],
          role: record['role'] === 'project' ? 'project' : 'user',
          upMs: num(record['up_ms']),
          fiveHour: hasWindow(record['five_hour']),
          sevenDay: hasWindow(record['seven_day']),
          five: figuresOf(record['five_hour']),
          seven: figuresOf(record['seven_day']),
          hasRateLimits: fieldNames(record['rate_limit_keys']).length > 0,
          version:
            typeof record['version'] === 'string' && VERSION.test(record['version'])
              ? record['version']
              : null,
          session: typeof record['session'] === 'string' ? record['session'] : null,
          cwd: typeof record['cwd'] === 'string' ? record['cwd'] : null,
          keys: fieldNames(record['keys']),
        });
      }
    }
  }

  const user = starts.filter((s) => s.role === 'user');
  const project = starts.filter((s) => s.role === 'project');
  const cancelled = starts.filter((s) => !ended.has(s.inv)).length;
  const versions = [
    ...new Set(starts.map((s) => s.version).filter((v): v is string => v !== null)),
  ].sort();
  const fields = [...new Set(starts.flatMap((s) => s.keys))].sort();
  ctx.findings.fact('Samples', 'status-line runs recorded', starts.length);
  ctx.findings.fact('Samples', 'runs of the user-level hook', user.length);
  ctx.findings.fact('Samples', 'runs of the project-level hook', project.length);
  ctx.findings.fact(
    'Samples',
    'distinct sessions (hashed)',
    new Set(starts.map((s) => s.session).filter((x) => x !== null)).size,
  );
  ctx.findings.fact('Samples', 'lines that could not be read', unreadable);
  ctx.findings.fact(
    'Samples',
    'top-level input fields seen',
    fields.length > 0 ? fields : ['none'],
  );
  ctx.out.line(
    safeText`Status-line runs recorded: ${starts.length} (user-level ${user.length}, project-level ${project.length}), ${cancelled} cancelled.`,
  );
  if (starts.length === 0) {
    ctx.findings.note(
      'No status-line run was recorded: use Claude Code with the temporary CLAUDE_CONFIG_DIR as --prepare printed, then run --report again.',
    );
    return;
  }

  // 1. rate_limits reach the script; the version is recorded.
  const five = starts.filter((s) => s.fiveHour).length;
  const seven = starts.filter((s) => s.sevenDay).length;
  ctx.findings.fact('Rate limits', 'runs with five_hour present', five);
  ctx.findings.fact('Rate limits', 'runs with seven_day present', seven);
  ctx.findings.fact(
    'Rate limits',
    'runs with a rate_limits object',
    starts.filter((s) => s.hasRateLimits).length,
  );
  ctx.findings.criterion(
    'rate-limits-delivered',
    five > 0 && seven > 0 ? 'pass' : 'fail',
    five > 0 && seven > 0
      ? safeText`five_hour reached the script in ${five} runs and seven_day in ${seven}.`
      : starts.some((s) => s.hasRateLimits)
        ? safeText`Only part of rate_limits arrived (five_hour in ${five} runs, seven_day in ${seven}).`
        : 'rate_limits never arrived: this sign-in reports no plan limits (API-key and Console sign-ins do not), so the card would be unavailable (no_limits).',
  );
  ctx.findings.fact('Claude Code', 'versions seen', versions.length > 0 ? versions : ['none']);
  ctx.findings.criterion(
    'claude-version-recorded',
    versions.length > 0 ? 'pass' : 'fail',
    versions.length > 0
      ? safeText`Claude Code version ${versions} was recorded.`
      : 'No run carried a version field, so the installed version could not be recorded.',
  );

  // 5. Concurrent sessions (G3_6).
  concurrentSessions(ctx, starts);

  // 4. The snapshot is first, so a cancelled run still left its line.
  ctx.findings.fact('Cancellation', 'runs with a start line and no end line', cancelled);
  ctx.findings.criterion(
    'snapshot-lands-before-cancel',
    cancelled > 0 ? 'pass' : 'not-run',
    cancelled > 0
      ? safeText`Runs cancelled before they finished: ${cancelled}; their snapshot lines landed anyway.`
      : 'No run was cancelled, so this could not be observed: send two messages quickly one after the other and run --report again.',
  );

  // 6. A project-level statusLine replaces the user-level one for that project.
  const projectFolders = new Set(project.map((s) => s.cwd).filter((c): c is string => c !== null));
  const userFolders = new Set(user.map((s) => s.cwd).filter((c): c is string => c !== null));
  const leaked = [...projectFolders].filter((c) => userFolders.has(c)).length;
  ctx.findings.fact('Project override', 'folders with project-level runs', projectFolders.size);
  ctx.findings.fact(
    'Project override',
    'of those, folders that also ran the user-level hook',
    leaked,
  );
  if (projectFolders.size === 0)
    ctx.findings.criterion(
      'project-statusline-override',
      'not-run',
      'No project-level run was recorded: start Claude Code in project-with-statusline and run --report again.',
    );
  else
    ctx.findings.criterion(
      'project-statusline-override',
      leaked === 0 ? 'pass' : 'fail',
      leaked === 0
        ? safeText`Project folders that ran only their own statusLine: ${projectFolders.size}; the user-level hook never ran there, so project_override is real.`
        : safeText`Project folders that also ran the user-level hook: ${leaked}, so the documented precedence did not hold.`,
    );

  // 10. Overhead: process start to the snapshot line landing.
  const ups = starts
    .map((s) => s.upMs)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
  if (ups.length === 0) {
    ctx.findings.criterion(
      'hook-overhead-within-budget',
      'not-run',
      'No run recorded its start-up time.',
    );
  } else {
    const p50 = percentile(ups, 0.5);
    const p95 = percentile(ups, 0.95);
    ctx.findings.fact('Overhead', 'runs measured', ups.length);
    ctx.findings.fact('Overhead', 'p50 to the snapshot line (ms)', p50);
    ctx.findings.fact('Overhead', 'p95 to the snapshot line (ms)', p95);
    ctx.findings.fact('Overhead', 'slowest (ms)', ups.at(-1) ?? 0);
    ctx.findings.criterion(
      'hook-overhead-within-budget',
      p95 <= OVERHEAD_BUDGET_MS ? 'pass' : 'fail',
      safeText`p95 ${p95} ms (p50 ${p50} ms) from process start to the snapshot line, over ${ups.length} runs; budget ${OVERHEAD_BUDGET_MS} ms.`,
    );
  }
  ctx.findings.note(
    'This probe prints nothing to the status row. TECH E8 items 2 (chaining byte for byte), 3 i (the compact line), 7, 8 and 9 need the product wrapper, which does not exist yet (M9); none of them is evaluated here. Item 5 is only observed: the figures each concurrent session was sent, not the product rule that a newer snapshot is never replaced.',
  );
}

export const experiment = defineExperiment({
  meta: {
    id: 'E8',
    script: 'scripts/experiments/e8-claude-probe.ts',
    title: 'Claude status-line probe',
    question:
      'Does Claude Code send rate_limits and its version to a user-level status-line command on the installation host, to every session when two run at once, does a snapshot written first survive cancellation, does a project-level statusLine replace it, and which footer hints disappear, all within the overhead budget?',
    criteria: [
      {
        id: 'config-dir-prepared',
        text: 'The run uses a **temporary `CLAUDE_CONFIG_DIR`** first; real settings are not involved.',
      },
      {
        id: 'rate-limits-delivered',
        text: '`rate_limits.five_hour` and `seven_day` reach the script for the active plan.',
      },
      { id: 'claude-version-recorded', text: 'The installed Claude Code version is recorded.' },
      {
        id: 'snapshot-lands-before-cancel',
        text: 'The snapshot is written **before** the script does anything else and still lands when Claude Code cancels the script on a rapid update.',
      },
      {
        id: 'project-statusline-override',
        text: 'A project-level `statusLine` really does stop snapshots from that project (the documented precedence).',
      },
      {
        id: 'concurrent-sessions-observed',
        text: 'Two Claude Code sessions running at once each receive both windows, and any arrival that carries an older figure than an earlier one is counted (observed only; the product rule is built in M9).',
      },
      {
        id: 'footer-hints-recorded',
        text: 'The footer hints that disappear when the probe status line replaces the default are recorded (the owner names them; a hook cannot see the screen).',
      },
      {
        id: 'hook-overhead-within-budget',
        text: 'Script overhead is measured: p95 ≤ 100 ms, Node start-up included.',
      },
    ],
    reads: [
      '--prepare, only with --seed-settings <file>: that settings file (for example a copy of ~/.claude/settings.json), read once as JSON. Only the plain preferences effortLevel, model and theme are copied into the temporary configuration, and only when the value is a boolean, a number or a short plain word (letters, digits, dot, underscore, hyphen); everything else (env, hooks, apiKeyHelper, awsAuthRefresh, permissions, servers, any object or array) is left out and only counted, never printed or written',
      '--report: the folder given with --dir (the temporary folder --prepare made): claude-config/settings.json, to check the hook is wired, and samples.jsonl, which the hook wrote: one line per status-line run holding field names, numbers, hashed session and folder ids, the Claude Code version and timings. --footer-hints-without and --footer-hints-with are typed by the owner: short lowercase words, never read from a file',
    ],
    prints: [
      '--prepare: the temporary folder and the exact commands to start Claude Code with it. --report: counts of runs, windows present, versions, cancelled runs, concurrent sessions and timings in milliseconds, the footer hints the owner named, then verdicts. Never a path from the samples, a session id, a prompt or any text',
    ],
    writes: [
      'docs/implementation/experiments/E8.md (the findings)',
      '--prepare only: a new temporary folder crew-e8-XXXXXX under the system temp folder holding claude-config/settings.json, claude-baseline/settings.json (an empty configuration, for looking at the footer with no status line), project-with-statusline/.claude/settings.json, project-plain/NOTE.txt and an empty samples.jsonl; the hook, run by Claude Code, appends to samples.jsonl there. Never ~/.claude and never a real settings file',
    ],
    network: [],
    spawns: [],
    example:
      'node scripts/experiments/e8-claude-probe.ts --prepare, then after using Claude Code as it prints: node scripts/experiments/e8-claude-probe.ts --report --dir <the folder --prepare printed> --footer-hints-without <hints> --footer-hints-with <hints>',
    selftest: [
      {
        name: 'a folder of samples where every check holds',
        args: [
          '--report',
          '--dir',
          '{fixtures}/statusline/ok',
          '--footer-hints-without',
          'shortcuts,esc-to-interrupt,permission-mode',
          '--footer-hints-with',
          'permission-mode',
        ],
        expect: {
          exit: 0,
          verdicts: {
            'config-dir-prepared': 'pass',
            'rate-limits-delivered': 'pass',
            'claude-version-recorded': 'pass',
            'concurrent-sessions-observed': 'pass',
            'footer-hints-recorded': 'pass',
            'snapshot-lands-before-cancel': 'pass',
            'project-statusline-override': 'pass',
            'hook-overhead-within-budget': 'pass',
          },
          stdoutIncludes: [
            'Status-line runs recorded: 11',
            'Footer hints that disappear with the probe status line: esc-to-interrupt, shortcuts.',
            'arrivals with an older figure: 1.',
          ],
        },
      },
      {
        name: 'every footer hint disappears with the probe (none typed for the probe list)',
        args: [
          '--report',
          '--dir',
          '{fixtures}/statusline/ok',
          '--footer-hints-without',
          'shortcuts,esc-to-interrupt',
          '--footer-hints-with',
          'none',
        ],
        expect: {
          exit: 0,
          verdicts: {
            'config-dir-prepared': 'pass',
            'rate-limits-delivered': 'pass',
            'claude-version-recorded': 'pass',
            'concurrent-sessions-observed': 'pass',
            'footer-hints-recorded': 'pass',
            'snapshot-lands-before-cancel': 'pass',
            'project-statusline-override': 'pass',
            'hook-overhead-within-budget': 'pass',
          },
          stdoutIncludes: [
            'Footer hints that disappear with the probe status line: esc-to-interrupt, shortcuts.',
          ],
        },
      },
      {
        name: 'the same samples with no footer hints given',
        args: ['--report', '--dir', '{fixtures}/statusline/ok'],
        expect: {
          exit: 0,
          verdicts: {
            'config-dir-prepared': 'pass',
            'rate-limits-delivered': 'pass',
            'claude-version-recorded': 'pass',
            'concurrent-sessions-observed': 'pass',
            'footer-hints-recorded': 'not-run',
            'snapshot-lands-before-cancel': 'pass',
            'project-statusline-override': 'pass',
            'hook-overhead-within-budget': 'pass',
          },
          stdoutIncludes: ['Status-line runs recorded: 11'],
        },
      },
      {
        name: 'no plan limits, no version, a leaking project override, slow runs and no cancellation',
        args: ['--report', '--dir', '{fixtures}/statusline/bad'],
        expect: {
          exit: 1,
          verdicts: {
            'config-dir-prepared': 'fail',
            'rate-limits-delivered': 'fail',
            'claude-version-recorded': 'fail',
            'concurrent-sessions-observed': 'not-run',
            'footer-hints-recorded': 'not-run',
            'snapshot-lands-before-cancel': 'not-run',
            'project-statusline-override': 'fail',
            'hook-overhead-within-budget': 'fail',
          },
        },
      },
      {
        name: 'two sessions at once where one is never sent the limits, and footer lists with nothing usable in them',
        args: [
          '--report',
          '--dir',
          '{fixtures}/statusline/concurrent-gap',
          '--footer-hints-without',
          'Press Esc!',
          '--footer-hints-with',
          'true',
        ],
        expect: {
          exit: 1,
          verdicts: {
            'config-dir-prepared': 'pass',
            'concurrent-sessions-observed': 'fail',
            'footer-hints-recorded': 'fail',
          },
          stdoutIncludes: ['Sessions seen: 2; pairs that ran at once: 1'],
        },
      },
      {
        name: 'a prepared folder that Claude Code has not been run in yet',
        args: ['--report', '--dir', '{fixtures}/statusline/empty'],
        expect: {
          exit: 0,
          verdicts: {
            'config-dir-prepared': 'pass',
            'rate-limits-delivered': 'not-run',
            'claude-version-recorded': 'not-run',
            'concurrent-sessions-observed': 'not-run',
            'footer-hints-recorded': 'not-run',
            'snapshot-lands-before-cancel': 'not-run',
            'project-statusline-override': 'not-run',
            'hook-overhead-within-budget': 'not-run',
          },
        },
      },
      {
        name: 'prepare a temporary configuration from a copy of other settings',
        args: ['--prepare', '--seed-settings', '{fixtures}/statusline/seed/settings.json'],
        expect: {
          exit: 0,
          verdicts: {
            'config-dir-prepared': 'pass',
            'rate-limits-delivered': 'not-run',
            'claude-version-recorded': 'not-run',
            'concurrent-sessions-observed': 'not-run',
            'footer-hints-recorded': 'not-run',
            'snapshot-lands-before-cancel': 'not-run',
            'project-statusline-override': 'not-run',
            'hook-overhead-within-budget': 'not-run',
          },
          stdoutIncludes: [
            'CLAUDE_CONFIG_DIR=',
            'Your real Claude Code settings were not touched',
            'Step 5 · the report',
            'Footer hints: the small grey keyboard reminders',
            'shortcuts, esc-to-interrupt',
            'type none for --footer-hints-with',
            'Seed settings: 3 plain preferences copied, 5 other entries left out',
          ],
        },
      },
      {
        name: 'prepare with a seed file that is not JSON',
        args: ['--prepare', '--seed-settings', '{fixtures}/statusline/seed/not-json.txt'],
        expect: {
          exit: 1,
          verdicts: {
            'config-dir-prepared': 'fail',
            'rate-limits-delivered': 'not-run',
            'claude-version-recorded': 'not-run',
            'concurrent-sessions-observed': 'not-run',
            'footer-hints-recorded': 'not-run',
            'snapshot-lands-before-cancel': 'not-run',
            'project-statusline-override': 'not-run',
            'hook-overhead-within-budget': 'not-run',
          },
        },
      },
      {
        name: 'neither --prepare nor --report',
        args: ['--dir', '{fixtures}/statusline/ok'],
        expect: { exit: 2, verdicts: {} },
      },
    ],
  },

  async run(ctx) {
    const wantsPrepare = ctx.args.has('prepare');
    const wantsReport = ctx.args.has('report');
    if (wantsPrepare === wantsReport)
      throw new UsageError('Use exactly one of --prepare or --report --dir <folder>.');
    if (wantsPrepare) prepare(ctx);
    else report(ctx);
  },
});

runIfMain(import.meta, experiment);
