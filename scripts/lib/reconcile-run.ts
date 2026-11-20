import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalAdapters, type DiscoveryEnv } from '../../src/server/collectors/discovery.ts';
import type { AdapterReport } from '../../src/server/collectors/types.ts';
import { migrate } from '../../src/server/db/migrate.ts';
import { openDatabase } from '../../src/server/db/open.ts';
import { readSessionFigures } from '../../src/server/db/queries/ingest.ts';
import type { Logger } from '../../src/server/lib/logger.ts';
import {
  diagnose,
  renderDiagnosis,
  type DiagnoseMaterial,
  type ProviderDiagnosis,
} from './diagnose.ts';
import {
  appSessions,
  compareProvider,
  notRun,
  parseClaudeReport,
  parseCodexReport,
  providerFails,
  providerPasses,
  type OracleSession,
  type ProviderId,
  type ProviderReport,
} from './reconcile.ts';

// Runs the reconciliation for one machine: import its Codex and Claude Code history into a temporary database with the REAL
// adapters (discovery and all), ask ccusage (or read a report file) for the same sessions, and compare (scripts/lib/reconcile.ts).
// The temporary database is deleted afterwards and nothing is written anywhere else. Reads only the folders discovery names.

export type OracleSource =
  /** A saved `ccusage <provider> session --json --offline` report. */
  | { kind: 'file'; path: string }
  /** Run a program: `program ...prefix <provider> session --json --offline`. */
  | { kind: 'program'; program: string; prefix?: readonly string[] };

export interface ReconcileOptions {
  env: DiscoveryEnv;
  home: string;
  sources: Record<ProviderId, OracleSource>;
  /** The environment ccusage is started with. Default: this process's own. */
  ccusageEnv?: NodeJS.ProcessEnv;
}

export interface ReconcileResult {
  reports: ProviderReport[];
  /** What each importer said about its own attempt (status and counts, no text). */
  imports: Record<ProviderId, string>;
  /** The two sides of every comparison, kept so `--diagnose` can say why a session differs. */
  material: DiagnoseMaterial;
}

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function ccusageReport(
  source: OracleSource,
  provider: ProviderId,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  if (source.kind === 'file') {
    try {
      return Promise.resolve(JSON.parse(readFileSync(source.path, 'utf8')) as unknown);
    } catch {
      return Promise.reject(new Error('the ccusage report file could not be read as JSON'));
    }
  }
  const args = [...(source.prefix ?? []), provider, 'session', '--json', '--offline'];
  return new Promise((resolve, reject) => {
    execFile(
      source.program,
      args,
      { env, timeout: 180_000, maxBuffer: 512 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          reject(
            new Error(
              code === 'ENOENT'
                ? 'ccusage is not installed here (no program named that on PATH)'
                : 'ccusage did not finish a session report',
            ),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout) as unknown);
        } catch {
          reject(new Error('the ccusage output is not JSON'));
        }
      },
    );
  });
}

const sayImport = (report: AdapterReport): string => {
  if (report.result === 'skipped') return 'not found on this machine';
  const parts = [report.result, `${report.imported ?? 0} new sessions`];
  if (report.unreadable) parts.push(`${report.unreadable} unreadable`);
  if (report.unsupported) parts.push(`${report.unsupported} unsupported`);
  return parts.join(', ');
};

export async function runReconcile(options: ReconcileOptions): Promise<ReconcileResult> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-productivity-reconcile-'));
  const db = openDatabase(join(dir, 'reconcile.db'));
  try {
    migrate(db);
    const imports = { claude: 'not run', codex: 'not run' } as Record<ProviderId, string>;
    for (const adapter of createLocalAdapters({ env: options.env, home: options.home })) {
      const report = await adapter.refresh({
        db,
        now: Date.now,
        logger: quiet,
        progress: () => {},
      });
      imports[adapter.id as ProviderId] = sayImport(report);
    }
    const reports: ProviderReport[] = [];
    const material: DiagnoseMaterial = {
      app: { claude: [], codex: [] },
      oracle: { claude: null, codex: null },
    };
    for (const provider of ['codex', 'claude'] as const) {
      const stored = readSessionFigures(db, provider);
      const app = appSessions(provider, stored);
      material.app[provider] = app;
      let oracle: OracleSession[] | null;
      try {
        const raw = await ccusageReport(
          options.sources[provider],
          provider,
          options.ccusageEnv ?? process.env,
        );
        oracle = provider === 'claude' ? parseClaudeReport(raw) : parseCodexReport(raw);
        if (oracle === null) {
          reports.push(
            notRun(
              provider,
              'The ccusage report has no session list in a shape this tool reads.',
              app.length,
            ),
          );
          continue;
        }
      } catch (error) {
        reports.push(notRun(provider, (error as Error).message + '.', app.length));
        continue;
      }
      material.oracle[provider] = oracle;
      reports.push(compareProvider(provider, app, oracle));
    }
    return { reports, imports, material };
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- the self-test: invented fixture homes against the fixture oracles -------------------------------------------------------

const FIXTURES = join(import.meta.dirname, '../../test/fixtures');

function fixtureHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'agent-productivity-reconcile-home-'));
  cpSync(join(FIXTURES, 'claude/projects'), join(home, '.claude/projects'), { recursive: true });
  cpSync(join(FIXTURES, 'codex/home'), join(home, '.codex'), { recursive: true });
  return home;
}

export interface SelftestCase {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Proves the tool can tell a match from a one-token difference, and that every way of getting ccusage's report works, on INVENTED
 * data (DRAFT-documented-shape). It says nothing about real files: that is what the real run is for.
 */
export async function selftest(): Promise<SelftestCase[]> {
  const home = fixtureHome();
  const cases: SelftestCase[] = [];
  try {
    const file = (name: string): OracleSource => ({ kind: 'file', path: join(FIXTURES, name) });
    const fake = (provider: ProviderId): OracleSource => ({
      kind: 'program',
      program: process.execPath,
      prefix: [join(FIXTURES, provider, 'fake-ccusage.ts')],
    });
    const run = (sources: Record<ProviderId, OracleSource>) =>
      runReconcile({ env: {}, home, sources });
    const record = (name: string, ok: boolean, detail: string) => cases.push({ name, ok, detail });

    const exact = await run({
      claude: file('claude/oracle.json'),
      codex: file('codex/oracle.json'),
    });
    record(
      'the fixture oracles agree to the token',
      exact.reports.every(providerPasses) && exact.reports.every((r) => r.compared.length === 3),
      exact.reports
        .map((r) => `${r.provider}: ${r.compared.length} compared, ${r.differing} differ`)
        .join('; '),
    );

    const off = await run({
      claude: file('claude/oracle-one-token-off.json'),
      codex: file('codex/oracle-one-token-off.json'),
    });
    record(
      'a one-token difference is found in both providers',
      off.reports.every(providerFails),
      off.reports
        .map(
          (r) =>
            `${r.provider}: ${r.compared.filter((c) => Object.values(c.difference).some((n) => n !== 0)).length} session(s) differ`,
        )
        .join('; '),
    );

    const spawned = await run({ claude: fake('claude'), codex: fake('codex') });
    record(
      'ccusage is asked for its report the way the real one is (a program, four arguments)',
      spawned.reports.every(providerPasses),
      spawned.reports.map((r) => `${r.provider}: ${r.state}`).join('; '),
    );

    const missing = await run({
      claude: { kind: 'program', program: 'ccusage-is-not-installed-here' },
      codex: { kind: 'program', program: 'ccusage-is-not-installed-here' },
    });
    record(
      'without ccusage nothing is claimed: both providers say NOT RUN',
      missing.reports.every(
        (r) => r.state === 'not-run' && !providerPasses(r) && !providerFails(r),
      ),
      missing.reports.map((r) => `${r.provider}: ${r.state}`).join('; '),
    );

    // --diagnose, on invented homes whose saved oracles are a PRETEND ccusage that counts differently from the importer (no compaction
    // usage, no replay skipped for Codex; the later copy owns a shared message for Claude Code): the importer follows the real ccusage, so
    // the diagnosis has a difference to name. None of this is a fact about a real ccusage.
    const diagHome = join(FIXTURES, 'reconcile-diagnose/home');
    const diagRun = await runReconcile({
      env: {},
      home: diagHome,
      sources: {
        claude: file('reconcile-diagnose/claude-oracle.json'),
        codex: file('reconcile-diagnose/codex-oracle.json'),
      },
    });
    const diagnoses = await diagnose({ env: {}, home: diagHome, material: diagRun.material });
    const full = diagnoses.filter((d): d is ProviderDiagnosis => 'matched' in d);
    const codex = full.find((d) => d.provider === 'codex');
    const claude = full.find((d) => d.provider === 'claude');
    const top = (d: ProviderDiagnosis | undefined): string =>
      d?.tallies[0]
        ? `${d.tallies[0].rule}${d.tallies[0].addon === '' ? '' : `, ${d.tallies[0].addon}`} (${d.tallies[0].matches} of ${d.matched})`
        : 'none';
    const asBuilt = codex?.tallies.find((t) => t.rule === 'as-built');
    record(
      'the diagnosis finds the counting that makes a pretend Codex ccusage differ from the importer',
      codex?.tallies[0]?.matches === codex?.matched &&
        codex?.tallies[0]?.addon === 'none' &&
        asBuilt?.matches === 0 &&
        codex?.selfCheckMismatches === 0,
      `codex: the importer today reproduces ${asBuilt?.matches ?? 0} of ${codex?.matched ?? 0}; the rule that reproduces every matched session is ${top(codex)}`,
    );
    record(
      'the diagnosis finds who owns a message two invented Claude Code transcripts both hold',
      claude?.tallies[0]?.rule === 'latest' &&
        claude.tallies[0].matches === claude.matched &&
        claude.selfCheckMismatches === 0,
      `claude: the rule that reproduces every matched session is ${top(claude)}`,
    );
    const text = renderDiagnosis(diagnoses);
    record(
      'the diagnosis prints no text, path or id from the invented files',
      !/SENTINEL|\/fixture|\/nowhere|reconcile-diagnose|gpt-5-codex|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(
        text,
      ),
      `${text.split('\n').length} lines, counts and plain words only`,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  return cases;
}
