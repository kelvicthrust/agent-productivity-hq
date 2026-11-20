import { UsageError } from './lib/args.ts';
import { defineExperiment, runIfMain } from './lib/cli.ts';
import { isFieldName, safeText } from './lib/redact.ts';
import type { ExperimentContext, ProcessSession } from './lib/types.ts';

// E4 · ChatGPT account reads (TECH › Feasibility experiments, data-and-sources › ChatGPT account report).
//
// Starts `codex app-server` through ctx.session (an argument array, no shell), speaks JSON-RPC over its standard input and
// output (R6), asks `account/read`, `account/usage/read` and `account/rateLimits/read`, and kills the process when done.
// It never starts a sign-in: only reads. Nothing the app-server says is printed or recorded except counts, field names,
// the plan type and the day span of the usage buckets: no email, account id, token or per-day figure.

const DAY = 86_400_000;
const DEFAULT_CALL_TIMEOUT_MS = 10_000; // TECH › Failure modes: 10 s per call

type Reply =
  { kind: 'result'; result: unknown } | { kind: 'error'; code: number | null } | { kind: 'silent' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One JSON-RPC exchange: send, then read lines until the answer with this id (anything else is skipped and counted). */
class Rpc {
  readonly #session: ProcessSession;
  readonly #timeoutMs: number;
  #nextId = 1;
  /** Requests the server sent us (it asked the client something) rather than notifications. */
  serverRequests = 0;

  constructor(session: ProcessSession, timeoutMs: number) {
    this.#session = session;
    this.#timeoutMs = timeoutMs;
  }

  notify(method: string): void {
    this.#session.send(JSON.stringify({ method, params: {} }));
  }

  async call(method: string, params: unknown): Promise<Reply> {
    const id = this.#nextId++;
    this.#session.send(JSON.stringify({ id, method, params }));
    const deadline = performance.now() + this.#timeoutMs;
    for (let seen = 0; seen < 500; seen++) {
      const left = deadline - performance.now();
      if (left <= 0) return { kind: 'silent' };
      const line = await this.#session.nextLine(Math.ceil(left));
      if (line === null) return { kind: 'silent' };
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(message)) continue;
      if (message['id'] !== id) {
        if (typeof message['method'] === 'string' && message['id'] !== undefined)
          this.serverRequests++;
        continue;
      }
      const error = message['error'];
      if (error !== undefined && error !== null) {
        const code = isRecord(error) && typeof error['code'] === 'number' ? error['code'] : null;
        return { kind: 'error', code };
      }
      return { kind: 'result', result: message['result'] };
    }
    return { kind: 'silent' };
  }
}

interface Bucket {
  date: string;
  tokens: number;
}

const toDate = (value: unknown): string | null => {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  if (typeof value === 'number' && Number.isFinite(value))
    return new Date(value < 1e11 ? value * 1000 : value).toISOString().slice(0, 10);
  return null;
};

/** The bucket list of an `account/usage/read` result, or null when it is absent or null. */
function readBuckets(result: Record<string, unknown>): Bucket[] | null {
  const raw = result['dailyUsageBuckets'];
  if (!Array.isArray(raw)) return null;
  const buckets: Bucket[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const date = toDate(item['startDate']);
    const tokens = item['tokens'];
    if (date && typeof tokens === 'number' && Number.isFinite(tokens))
      buckets.push({ date, tokens });
  }
  return buckets;
}

/** Names of the fields (top level and under `summary`) whose value is null. Only field-name-shaped keys are kept. */
function nullFields(result: Record<string, unknown>): { all: string[]; summary: string[] } {
  const summary = isRecord(result['summary']) ? result['summary'] : {};
  const top = Object.entries(result)
    .filter(([key, value]) => value === null && isFieldName(key))
    .map(([key]) => key);
  const inSummary = Object.entries(summary)
    .filter(([key, value]) => value === null && isFieldName(key))
    .map(([key]) => `summary.${key}`);
  return { all: [...top, ...inSummary], summary: Object.keys(summary).filter(isFieldName) };
}

const dayNumber = (date: string): number => Date.parse(`${date}T00:00:00Z`) / DAY;

function dateFlag(ctx: ExperimentContext, name: string): string | undefined {
  const value = ctx.args.get(name);
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(dayNumber(value)))
    throw new UsageError(`--${name} must be a date such as 2026-11-03`);
  return value;
}

export const experiment = defineExperiment({
  meta: {
    id: 'E4',
    script: 'scripts/experiments/e4-chatgpt.ts',
    title: 'ChatGPT account reads through the Codex app-server',
    question:
      'Does the Codex app-server report the existing ChatGPT sign-in and daily usage buckets without a prompt, and how does one window compare with local Codex totals?',
    criteria: [
      {
        id: 'account-read-existing-signin',
        text: '`account/read` reports the existing ChatGPT sign-in with no prompt (P-42).',
      },
      { id: 'usage-returns-buckets', text: '`account/usage/read` returns daily usage buckets.' },
      {
        id: 'lookback-and-nulls-recorded',
        text: 'The bucket lookback and the null fields are recorded.',
      },
      {
        id: 'overlap-window-compared',
        text: 'One overlapping window is compared with local Codex totals.',
      },
    ],
    reads: [
      "The Codex app-server's answers on its standard output: account/read (account type and plan type only), account/usage/read (bucket dates and token counts, which fields are null) and account/rateLimits/read (how many windows report a percentage); the server is started with `codex app-server`, which uses Codex's own sign-in",
      'Nothing on disk. The local Codex total for the comparison window comes from you: --local-tokens, --window-start and --window-end (for example from `ccusage codex daily --json`)',
    ],
    prints: [
      'The command it starts, then counts and verdicts: account type and plan type, how many daily buckets, the day span they cover, which usage fields are null, and for the comparison window the account figure and the local figure side by side. Never an email, account id, token or per-day figure',
    ],
    writes: ['docs/implementation/experiments/E4.md (the findings)'],
    network: [],
    spawns: ['codex'],
    example:
      'node scripts/experiments/e4-chatgpt.ts --local-tokens <ccusage total> --window-start <YYYY-MM-DD> --window-end <YYYY-MM-DD>',
    selftest: [
      {
        name: 'signed in with usage buckets; the account figure is above the local one',
        args: [
          '--bin',
          'codex={fixtures}/appserver/fake-codex.ts',
          '--local-tokens',
          '900',
          '--window-start',
          '2026-11-03',
          '--window-end',
          '2026-11-05',
        ],
        env: { FAKE_CODEX_SCENARIO: '{fixtures}/appserver/signed-in.json' },
        expect: {
          exit: 0,
          verdicts: {
            'account-read-existing-signin': 'pass',
            'usage-returns-buckets': 'pass',
            'lookback-and-nulls-recorded': 'pass',
            'overlap-window-compared': 'pass',
          },
          stdoutIncludes: ['Will start: codex app-server'],
        },
      },
      {
        name: 'signed in, but the usage buckets are null',
        args: [
          '--bin',
          'codex={fixtures}/appserver/fake-codex.ts',
          '--local-tokens',
          '900',
          '--window-start',
          '2026-11-03',
          '--window-end',
          '2026-11-05',
        ],
        env: { FAKE_CODEX_SCENARIO: '{fixtures}/appserver/buckets-null.json' },
        expect: {
          exit: 1,
          verdicts: {
            'account-read-existing-signin': 'pass',
            'usage-returns-buckets': 'fail',
            'lookback-and-nulls-recorded': 'pass',
            'overlap-window-compared': 'not-run',
          },
        },
      },
      {
        name: 'signed in with an API key, which has no usage report',
        args: ['--bin', 'codex={fixtures}/appserver/fake-codex.ts'],
        env: { FAKE_CODEX_SCENARIO: '{fixtures}/appserver/api-key.json' },
        expect: {
          exit: 1,
          verdicts: {
            'account-read-existing-signin': 'fail',
            'usage-returns-buckets': 'not-run',
            'lookback-and-nulls-recorded': 'not-run',
            'overlap-window-compared': 'not-run',
          },
        },
      },
      {
        name: 'the account figure is below the local one for the same window',
        args: [
          '--bin',
          'codex={fixtures}/appserver/fake-codex.ts',
          '--local-tokens',
          '5000',
          '--window-start',
          '2026-11-03',
          '--window-end',
          '2026-11-05',
        ],
        env: { FAKE_CODEX_SCENARIO: '{fixtures}/appserver/signed-in.json' },
        expect: {
          exit: 1,
          verdicts: {
            'account-read-existing-signin': 'pass',
            'usage-returns-buckets': 'pass',
            'lookback-and-nulls-recorded': 'pass',
            'overlap-window-compared': 'fail',
          },
        },
      },
      {
        name: 'the app-server never answers the usage call',
        args: ['--bin', 'codex={fixtures}/appserver/fake-codex.ts', '--call-timeout-ms', '400'],
        env: { FAKE_CODEX_SCENARIO: '{fixtures}/appserver/usage-silent.json' },
        expect: {
          exit: 0,
          verdicts: {
            'account-read-existing-signin': 'pass',
            'usage-returns-buckets': 'not-run',
            'lookback-and-nulls-recorded': 'not-run',
            'overlap-window-compared': 'not-run',
          },
        },
      },
      {
        name: 'codex is not installed',
        args: ['--bin', 'codex={tmp}/no-such-codex'],
        env: { FAKE_CODEX_SCENARIO: '{fixtures}/appserver/signed-in.json' },
        expect: {
          exit: 0,
          verdicts: {
            'account-read-existing-signin': 'not-run',
            'usage-returns-buckets': 'not-run',
            'lookback-and-nulls-recorded': 'not-run',
            'overlap-window-compared': 'not-run',
          },
        },
      },
    ],
  },

  async run(ctx) {
    const localRaw = ctx.args.get('local-tokens');
    const localTokens = localRaw === undefined ? undefined : Number(localRaw);
    if (localTokens !== undefined && (!Number.isInteger(localTokens) || localTokens < 0))
      throw new UsageError('--local-tokens must be a whole number of tokens');
    const windowStart = dateFlag(ctx, 'window-start');
    const windowEnd = dateFlag(ctx, 'window-end');
    const timeoutRaw = Number(ctx.args.get('call-timeout-ms') ?? DEFAULT_CALL_TIMEOUT_MS);
    if (!Number.isInteger(timeoutRaw) || timeoutRaw < 50)
      throw new UsageError('--call-timeout-ms must be a whole number of milliseconds, at least 50');

    const session = await ctx.session('codex', ['app-server']);
    if (!session.found) {
      ctx.findings.fact('Codex app-server', 'codex found', false);
      ctx.out.line('codex is not installed here, so nothing was read.');
      return;
    }
    try {
      const rpc = new Rpc(session, timeoutRaw);
      const hello = await rpc.call('initialize', {
        clientInfo: {
          name: 'agent-productivity-e4',
          title: 'Agent Productivity HQ E4',
          version: '0.0.0',
        },
      });
      if (hello.kind !== 'result') {
        ctx.findings.fact('Codex app-server', 'initialize answered', false);
        ctx.out.line('The app-server did not answer initialize.');
        return;
      }
      rpc.notify('initialized');
      ctx.findings.fact('Codex app-server', 'initialize answered', true);
      const agent = isRecord(hello.result) ? hello.result['userAgent'] : undefined;
      const version =
        typeof agent === 'string'
          ? agent.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?/)?.[0]
          : undefined;
      if (version) ctx.findings.tool('codex', version);

      // account/read: the existing sign-in. `refreshToken: false` so it only reports what is cached.
      const account = await rpc.call('account/read', { refreshToken: false });
      let signedInWithChatgpt = false;
      if (account.kind === 'result' && isRecord(account.result)) {
        const info = isRecord(account.result['account']) ? account.result['account'] : null;
        const type = info && typeof info['type'] === 'string' ? info['type'] : 'none';
        const plan = info && typeof info['planType'] === 'string' ? info['planType'] : 'none';
        const needsAuth = account.result['requiresOpenaiAuth'];
        signedInWithChatgpt = type === 'chatgpt';
        ctx.findings.fact('Account', 'account type', type);
        ctx.findings.fact('Account', 'plan type', plan);
        if (typeof needsAuth === 'boolean')
          ctx.findings.fact('Account', 'requires OpenAI sign-in', needsAuth);
        ctx.out.line(safeText`account/read: account type ${type}, plan ${plan}.`);
        ctx.findings.criterion(
          'account-read-existing-signin',
          signedInWithChatgpt ? 'pass' : 'fail',
          signedInWithChatgpt
            ? 'account/read reported a ChatGPT sign-in; no sign-in was started.'
            : safeText`account/read reported account type ${type}, so the card would say Not connected (P-44).`,
        );
      } else if (account.kind === 'error') {
        ctx.findings.criterion(
          'account-read-existing-signin',
          'fail',
          safeText`account/read answered with error code ${account.code ?? 0}.`,
        );
      } else {
        ctx.findings.criterion(
          'account-read-existing-signin',
          'not-run',
          'account/read did not answer within the time limit.',
        );
      }

      if (signedInWithChatgpt) await readUsage(ctx, rpc, { localTokens, windowStart, windowEnd });

      ctx.findings.fact(
        'Codex app-server',
        'requests the server sent the client',
        rpc.serverRequests,
      );
    } finally {
      session.kill();
      ctx.findings.fact('Codex app-server', 'process stopped after reading', true);
    }
  },
});

async function readUsage(
  ctx: ExperimentContext,
  rpc: Rpc,
  window: {
    localTokens: number | undefined;
    windowStart: string | undefined;
    windowEnd: string | undefined;
  },
): Promise<void> {
  const usage = await rpc.call('account/usage/read', {});
  if (usage.kind === 'error') {
    ctx.findings.criterion(
      'usage-returns-buckets',
      'fail',
      safeText`account/usage/read answered with error code ${usage.code ?? 0}.`,
    );
    return;
  }
  if (usage.kind === 'silent' || !isRecord(usage.result)) {
    ctx.findings.criterion(
      'usage-returns-buckets',
      usage.kind === 'silent' ? 'not-run' : 'fail',
      usage.kind === 'silent'
        ? 'account/usage/read did not answer within the time limit.'
        : 'account/usage/read answered with something that is not an object.',
    );
    return;
  }

  const buckets = readBuckets(usage.result);
  const nulls = nullFields(usage.result);
  ctx.findings.fact('Usage', 'usage fields', Object.keys(usage.result).filter(isFieldName));
  ctx.findings.fact('Usage', 'summary fields', nulls.summary);
  ctx.findings.fact('Usage', 'null fields', nulls.all.length > 0 ? nulls.all : ['none']);
  ctx.findings.fact('Usage', 'daily buckets', buckets?.length ?? 0);

  if (buckets && buckets.length > 0)
    ctx.findings.criterion(
      'usage-returns-buckets',
      'pass',
      safeText`${buckets.length} daily buckets came back.`,
    );
  else
    ctx.findings.criterion(
      'usage-returns-buckets',
      'fail',
      'No daily buckets came back (null or empty), so the account card would show the percentage only (P-34).',
    );

  // The lookback: the days from the first to the last bucket, and how many of them have no bucket.
  const dates = (buckets ?? []).map((b) => b.date).sort();
  const first = dates[0];
  const last = dates.at(-1);
  if (first && last) {
    const span = dayNumber(last) - dayNumber(first) + 1;
    ctx.findings.fact('Usage', 'first bucket date', first);
    ctx.findings.fact('Usage', 'last bucket date', last);
    ctx.findings.fact('Usage', 'days in the bucket span', span);
    ctx.findings.fact('Usage', 'days in the span without a bucket', span - new Set(dates).size);
    ctx.out.line(safeText`account/usage/read: ${dates.length} buckets over a ${span}-day span.`);
  }
  ctx.findings.criterion(
    'lookback-and-nulls-recorded',
    'pass',
    first && last
      ? safeText`Lookback ${dayNumber(last) - dayNumber(first) + 1} days; null fields: ${nulls.all.length > 0 ? nulls.all : ['none']}.`
      : safeText`No buckets, so no lookback; null fields: ${nulls.all.length > 0 ? nulls.all : ['none']}.`,
  );

  const limits = await rpc.call('account/rateLimits/read', {});
  if (
    limits.kind === 'result' &&
    isRecord(limits.result) &&
    isRecord(limits.result['rateLimits'])
  ) {
    const windows = Object.values(limits.result['rateLimits']).filter(
      (w) => isRecord(w) && typeof w['usedPercent'] === 'number',
    ).length;
    ctx.findings.fact('Rate limits', 'windows reporting a percentage', windows);
  } else {
    ctx.findings.fact('Rate limits', 'windows reporting a percentage', 0);
  }

  const { localTokens, windowStart, windowEnd } = window;
  if (localTokens === undefined || !windowStart || !windowEnd) {
    ctx.findings.criterion(
      'overlap-window-compared',
      'not-run',
      'Pass --local-tokens, --window-start and --window-end (a local total from ccusage) to compare one window.',
    );
    return;
  }
  const startDay = dayNumber(windowStart);
  const endDay = dayNumber(windowEnd);
  if (endDay < startDay) throw new UsageError('--window-end must not be before --window-start');
  if (!first || !last || startDay < dayNumber(first) || endDay > dayNumber(last)) {
    ctx.findings.criterion(
      'overlap-window-compared',
      'not-run',
      'The comparison window is not inside the days the buckets cover, so it cannot be compared.',
    );
    return;
  }
  const inWindow = (buckets ?? []).filter(
    (b) => dayNumber(b.date) >= startDay && dayNumber(b.date) <= endDay,
  );
  const account = inWindow.reduce((sum, b) => sum + b.tokens, 0);
  const days = endDay - startDay + 1;
  ctx.findings.fact('Overlap window', 'window start', windowStart);
  ctx.findings.fact('Overlap window', 'window end', windowEnd);
  ctx.findings.fact('Overlap window', 'days in the window', days);
  ctx.findings.fact(
    'Overlap window',
    'days in the window with a bucket',
    new Set(inWindow.map((b) => b.date)).size,
  );
  ctx.findings.fact('Overlap window', 'account tokens in the window', account);
  ctx.findings.fact('Overlap window', 'local tokens in the window', localTokens);
  ctx.out.line(
    safeText`Window ${windowStart} to ${windowEnd}: account ${account} tokens, this machine ${localTokens} tokens (shown separately, never added).`,
  );
  ctx.findings.criterion(
    'overlap-window-compared',
    account >= localTokens ? 'pass' : 'fail',
    account >= localTokens
      ? safeText`Account ${account} and local ${localTokens} tokens compared for one ${days}-day window.`
      : safeText`The account figure (${account}) is below this machine's own total (${localTokens}) for the same window, which an account-wide total cannot be.`,
  );
}

runIfMain(import.meta, experiment);
