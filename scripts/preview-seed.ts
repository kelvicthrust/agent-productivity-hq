// `pnpm preview:seed`: the app on a synthetic world, so every screen can be looked at without touching real data.
//
//   1. builds the SPA if dist/client is missing or older than the code that makes it;
//   2. seeds AGENT_PRODUCTIVITY_DATA_DIR (default .preview-data/ in this project, never the real app folder) with the D3/D4 fixture
//      world: fixed clock (Wed 4 Nov 2026, 9:42 AM), America/Los_Angeles;
//   3. serves the SPA and the API on 127.0.0.1:AGENT_PRODUCTIVITY_PORT (default 4317) with a visible "Synthetic preview data" note.
//
// Options: --scale typical|year   --scenario typical|refresh-failed|no-repos|account-only|empty
//          (`--scenario empty` is a first launch: setup is not finished, so the app opens on Setup; every other scenario has finished it)
//          --retry succeeds|fails|fails-once   what the next Codex refresh does (see below)
//          --github gh|signed-out   the scripted GitHub: `gh` signed in (default), or signed out so Sources shows the App setup
//          --check   seed, answer a few requests and run one refresh in memory, without opening a port, then exit
//
// Refreshing: the real Codex and Claude Code adapters exist now (`pnpm start` gives them to boot as `local`), but the preview is
// synthetic data and must never read this Mac. So it passes boot no `local` and gives the refresh runner three SCRIPTED adapters
// from test/fixtures/scripted-adapters, so Refresh and Retry can be tried on this synthetic data. Codex does what --retry says:
// `succeeds` (default) recovers on the next attempt, `fails` fails every time ("failed again" after the first), `fails-once`
// fails the next attempt and succeeds after that. Claude Code and Paseo always succeed. Nothing is read from this machine, and
// production (`pnpm start`) never imports them.
//
// GitHub is scripted the same way (test/fixtures/github/world.ts): a pretend GitHub that knows the seeded repos and one more,
// kelvin/dotfiles, that you can add on Sources; a pretend Keychain; a pretend `gh`. The preview never reaches github.com, this
// Mac's Keychain or the `gh` program. Refresh all runs the real GitHub sync over it, and the seeded kelvin/archive-private is
// a repo that GitHub no longer grants, so that source ends "partial" and Sources names the repo.
//
// The two accounts are scripted too (M9): ChatGPT is a scripted `codex app-server` that is already signed in (test/collectors/chatgpt,
// scenario chatgpt-with-threads), so Connect ChatGPT here says "Using your existing sign-in" and reads seven small daily totals.
// Claude plan checks use a synthetic credential and rate-limit response, with a temporary directory for legacy settings.
//
// First-launch Setup (M10) is real too: its discovery looks at a TEMPORARY home that holds the invented Claude Code and Codex fixture
// folders (found at their usual places), so Setup can be tried end to end and the rows read Found. Nothing on this Mac is looked at;
// the home is removed when the preview stops. Finish starts one refresh over the scripted adapters, as Refresh does.
//
// Runs under Node's built-in TypeScript support: erasable syntax only, explicit .ts import extensions.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AlreadyRunningError, PortInUseError, boot, type ListenFn } from '../src/server/boot.ts';
import { openDatabase } from '../src/server/db/open.ts';
import { ClaudePlanLimitsCheckResponse } from '../src/shared/contracts/accounts.ts';
import { ConfigError, loadConfig } from '../src/server/lib/config.ts';
import { ensureDir } from '../src/server/lib/fsModes.ts';
import { makeSetupHome } from '../test/e2e/helpers/homes.ts';
import { acquireInstanceLock, alreadyRunningMessage } from '../src/server/lib/instance.ts';
import {
  FIXED_NOW,
  FIXED_TIMEZONE,
  PREVIEW_LABEL,
  seedFile,
  type Scale,
} from '../test/fixtures/seed.ts';
import type { SourceAdapter } from '../src/server/collectors/types.ts';
import { fails, scriptedAdapter, succeeds } from '../test/fixtures/scripted-adapters/scripted.ts';
import { loadScenario, scriptedAppServer } from '../test/collectors/chatgpt/scripted.ts';
import { createScriptedGithub } from '../test/fixtures/github/world.ts';
import { SCENARIOS, type Scenario } from '../test/fixtures/world/write.ts';
import { ensureBuilt } from './lib/build.ts';

const ROOT = resolve(import.meta.dirname, '..');

const RETRY_OUTCOMES = ['succeeds', 'fails', 'fails-once'] as const;
type RetryOutcome = (typeof RETRY_OUTCOMES)[number];

function parseArgs(argv: string[]): {
  scale: Scale;
  scenario: Scenario;
  retry: RetryOutcome;
  github: 'gh' | 'signed-out';
  check: boolean;
} {
  const out = {
    scale: 'typical' as Scale,
    scenario: 'typical' as Scenario,
    retry: 'succeeds' as RetryOutcome,
    github: 'gh' as 'gh' | 'signed-out',
    check: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i]!.split('=', 2) as [string, string | undefined];
    const value = () => inline ?? argv[++i];
    if (flag === '--check') out.check = true;
    else if (flag === '--scale') {
      const v = value();
      if (v !== 'typical' && v !== 'year')
        throw new ConfigError(`--scale must be typical or year, got "${v}".`);
      out.scale = v;
    } else if (flag === '--scenario') {
      const v = value() as Scenario;
      if (!SCENARIOS.includes(v))
        throw new ConfigError(`--scenario must be one of ${SCENARIOS.join(', ')}, got "${v}".`);
      out.scenario = v;
    } else if (flag === '--retry') {
      const v = value() as RetryOutcome;
      if (!RETRY_OUTCOMES.includes(v))
        throw new ConfigError(`--retry must be one of ${RETRY_OUTCOMES.join(', ')}, got "${v}".`);
      out.retry = v;
    } else if (flag === '--github') {
      const v = value();
      if (v !== 'gh' && v !== 'signed-out')
        throw new ConfigError(`--github must be gh or signed-out, got "${v}".`);
      out.github = v;
    } else
      throw new ConfigError(
        `Unknown option ${flag}. Use --scale, --scenario, --retry, --github or --check.`,
      );
  }
  return out;
}

/** The scripted adapters the preview gives the refresh runner. */
function previewAdapters(retry: RetryOutcome): SourceAdapter[] {
  const codex =
    retry === 'succeeds'
      ? [succeeds({ imported: 4 })]
      : retry === 'fails'
        ? [fails()]
        : [fails(), succeeds({ imported: 4 })];
  return [
    scriptedAdapter('codex', codex),
    scriptedAdapter('claude', [succeeds({ imported: 0 })]),
    scriptedAdapter('paseo', [succeeds({ imported: 0 })]),
  ];
}

try {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig({
    ...process.env,
    AGENT_PRODUCTIVITY_DATA_DIR:
      process.env['AGENT_PRODUCTIVITY_DATA_DIR'] || join(ROOT, '.preview-data'),
  });

  await ensureBuilt(ROOT, console.log);

  // A running preview owns its data folder: never replace the database under it.
  ensureDir(config.dataDir);
  const probe = acquireInstanceLock(config.lockPath, { port: config.port });
  if (!probe.ok) throw new AlreadyRunningError(probe.holder?.port ?? null, config.lockPath);

  const summary = seedFile(config.dbPath, { scale: args.scale, scenario: args.scenario });
  console.log(
    `Seeded ${config.dbPath}: ${summary.counts['sessions']} sessions, ${summary.counts['events']} usage events, ${summary.counts['pullRequests']} merged PRs (${args.scale}, ${args.scenario}).`,
  );

  // The scripted GitHub is built from the seeded repos, so the file is read once here and closed before boot opens it.
  const seeded = openDatabase(config.dbPath);
  const scripted = createScriptedGithub(seeded, {
    now: () => FIXED_NOW,
    signedIn: args.github === 'gh',
  });
  seeded.close();

  // A temporary Claude Code settings folder (its path has a space, like the real macOS data folder) and a scripted Codex.
  const claudeHome = mkdtempSync(join(tmpdir(), 'agent-productivity-preview-claude-'));
  const claudeConfig = join(claudeHome, 'claude config');
  mkdirSync(claudeConfig, { recursive: true });
  process.on('exit', () => rmSync(claudeHome, { recursive: true, force: true }));
  const codex = scriptedAppServer(loadScenario('chatgpt-with-threads'));
  // What first-launch Setup looks at: a temporary home with the invented fixture folders, and a `codex` that is "on the PATH".
  const machine = makeSetupHome();
  process.on('exit', () => machine.close());

  const deps = {
    now: () => FIXED_NOW,
    timezone: FIXED_TIMEZONE,
    previewLabel: PREVIEW_LABEL,
    scheduler: false,
    adapters: previewAdapters(args.retry),
    github: scripted.boot,
    chatgpt: { launch: () => codex.launch() },
    claude: {
      env: { CLAUDE_CONFIG_DIR: claudeConfig },
      home: claudeHome,
      planLimits: {
        readCredential: async () =>
          ({ state: 'ok', accessToken: 'synthetic-oauth-token' }) as const,
        net: async () =>
          Response.json({
            five_hour: {
              utilization: 23,
              resets_at: new Date(FIXED_NOW + 3_600_000).toISOString(),
            },
            seven_day: {
              utilization: 62,
              resets_at: new Date(FIXED_NOW + 86_400_000).toISOString(),
            },
          }),
      },
    },
    setup: { local: { env: machine.env, home: machine.home }, codexOnPath: () => true },
  } as const;

  if (args.check) {
    const listen: ListenFn = async () => ({ close: (cb) => cb?.() });
    const server = await boot(config, { ...deps, directoryLease: probe, listen });
    const host = { host: `127.0.0.1:${config.port}` };
    const bootstrap = (await (
      await server.app.request(`http://127.0.0.1:${config.port}/api/bootstrap`, { headers: host })
    ).json()) as {
      today: string;
      timezone: string;
    };
    const page = await (
      await server.app.request(`http://127.0.0.1:${config.port}/`, { headers: host })
    ).text();
    // One refresh through the real route, with the scripted adapters: it must start, finish, and leave no source running.
    const write = {
      ...host,
      'x-agent-productivity-request': '1',
      'content-type': 'application/json',
    };
    const started = await server.app.request(`http://127.0.0.1:${config.port}/api/refresh`, {
      method: 'POST',
      headers: write,
      body: '{}',
    });
    const run = (await started.json()) as { id: number };
    let refreshed = 'running';
    for (let wait = 0; wait < 100 && refreshed === 'running'; wait += 1) {
      await new Promise((done) => setTimeout(done, 10));
      refreshed = (
        (await (
          await server.app.request(`http://127.0.0.1:${config.port}/api/refresh/${run.id}`, {
            headers: host,
          })
        ).json()) as { state: string }
      ).state;
    }
    // GitHub, scripted: the account card is there, and a repo can be added and read (3 merged PRs) without leaving the machine.
    const sources = (await (
      await server.app.request(`http://127.0.0.1:${config.port}/api/sources`, { headers: host })
    ).json()) as { accounts?: { id: string; status: string }[] };
    const github = sources.accounts?.find((account) => account.id === 'github');
    const added = await server.app.request(`http://127.0.0.1:${config.port}/api/repos`, {
      method: 'POST',
      headers: write,
      body: JSON.stringify({ input: 'https://github.com/kelvin/dotfiles' }),
    });
    let notesPrs = 0;
    for (let wait = 0; wait < 200 && notesPrs === 0; wait += 1) {
      await new Promise((done) => setTimeout(done, 10));
      const repos = (await (
        await server.app.request(`http://127.0.0.1:${config.port}/api/repos`, { headers: host })
      ).json()) as { active: { id: string; mergedPrsLast12Months: number }[] };
      notesPrs =
        repos.active.find((repo) => repo.id === 'kelvin/dotfiles')?.mergedPrsLast12Months ?? 0;
    }
    // The two accounts, scripted: ChatGPT's card is there and an explicit Claude plan check returns limits.
    const accountCards = (
      (await (
        await server.app.request(`http://127.0.0.1:${config.port}/api/sources`, { headers: host })
      ).json()) as { accounts?: { id: string; status: string }[] }
    ).accounts;
    const chatgptCard = accountCards?.find((account) => account.id === 'chatgpt');
    const claudeCheck = await server.app.request(
      `http://127.0.0.1:${config.port}/api/accounts/claude/plan-limits/check`,
      { method: 'POST', headers: write, body: '{}' },
    );
    const checked = ClaudePlanLimitsCheckResponse.safeParse(await claudeCheck.json());
    const claudeOk =
      claudeCheck.ok &&
      checked.data?.account.planLimits?.state === 'ok' &&
      checked.data.account.planLimits.report?.rateLimits?.length === 2;
    const accountsOk = chatgptCard !== undefined && claudeOk;
    // Setup, scripted: discovery over the temporary home answers, and finds both providers there.
    const looked = await server.app.request(`http://127.0.0.1:${config.port}/api/setup/discover`, {
      method: 'POST',
      headers: write,
    });
    const discovered = (looked.status === 200 ? await looked.json() : {}) as {
      sources?: { id: string; status: string }[];
    };
    const setupOk =
      discovered.sources?.find((source) => source.id === 'codex')?.status === 'ok' &&
      discovered.sources?.find((source) => source.id === 'claude')?.status === 'ok';
    const githubOk =
      github !== undefined &&
      github.status === (args.github === 'gh' ? 'existing' : 'needsapp') &&
      added.status === 201 &&
      notesPrs === 3;
    await server.shutdown();
    const labelled = page.includes(PREVIEW_LABEL);
    console.log(
      `Check: /api/bootstrap says today is ${bootstrap.today} in ${bootstrap.timezone}; the page ${labelled ? 'shows' : 'does NOT show'} "${PREVIEW_LABEL}"; a refresh with the scripted adapters (--retry ${args.retry}) ${started.status === 202 ? `ended ${refreshed}` : `was refused (${started.status})`}. GitHub (scripted, ${args.github}): ${github ? github.status : 'no account card'}; adding kelvin/dotfiles ${added.status === 201 ? `read ${notesPrs} merged PRs` : `was refused (${added.status})`}. Accounts (scripted): ChatGPT ${chatgptCard ? chatgptCard.status : 'has no card'}; the Claude plan check ${claudeOk ? 'returned two windows' : 'failed'}. Setup (scripted machine): discovery ${setupOk ? 'found Codex and Claude Code' : 'did NOT find them'}.`,
    );
    process.exit(
      labelled &&
        bootstrap.today === '2026-11-04' &&
        bootstrap.timezone === FIXED_TIMEZONE &&
        started.status === 202 &&
        refreshed !== 'running' &&
        githubOk &&
        accountsOk &&
        setupOk
        ? 0
        : 1,
    );
  }

  const server = await boot(config, { ...deps, directoryLease: probe });
  console.log(
    [
      '',
      `Preview: ${server.url}`,
      `"${PREVIEW_LABEL}" is shown on every page. Nothing here was read from your machine, accounts or GitHub.`,
      `Clock fixed at Wed 4 Nov 2026, 9:42 AM, ${FIXED_TIMEZONE}. Data folder: ${config.dataDir}`,
      'Press Control-C to stop.',
    ].join('\n'),
  );
  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(1);
    stopping = true;
    void server.shutdown().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (error) {
  if (error instanceof AlreadyRunningError) {
    console.log(
      alreadyRunningMessage(error.port === null ? null : { port: error.port }, error.lockPath),
    );
    process.exit(0);
  }
  console.error(
    error instanceof ConfigError || error instanceof PortInUseError
      ? error.message
      : `Could not start the preview: ${(error as Error).message}`,
  );
  process.exit(1);
}
