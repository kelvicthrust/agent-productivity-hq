// `node scripts/reconcile-usage.ts`: do the app's totals equal ccusage's to the token? (M5, G5_3; findings for E1 and E2.)
//
// Run it on the Mac whose Codex and Claude Code history you want to check. It imports that history into a TEMPORARY database with
// the app's real importers, asks `ccusage claude session --json --offline` and `ccusage codex session --json --offline` for the
// same sessions, and compares three sessions per provider category by category: the largest, one with subagents (Claude Code) or
// a spawned thread (Codex), and the next largest. It also says how far each session's stored start is from its first usage.
//
// It reads only the folders the app itself reads (CODEX_HOME or ~/.codex; CLAUDE_CONFIG_DIR or ~/.config/claude and ~/.claude)
// and writes nothing but the temporary database, which it deletes. The report is metadata only: counts, token numbers and the
// first eight characters of a session id; never a prompt, a reply, a path or a project name. ccusage is only the oracle: it is
// not installed by this repository and not a dependency.
//
//   --claude-oracle <file>   a saved `ccusage claude session --json --offline` report, instead of running ccusage
//   --codex-oracle <file>    a saved `ccusage codex session --json --offline` report
//   --ccusage <program>      the ccusage program to run (default: ccusage on PATH; never npx)
//   --home <folder>          read this folder as the home folder instead of yours (for a copy of someone's history)
//   --out <file>             also write the report to this file (paste its contents back; it holds no private text)
//   --diagnose               after the report, say WHY sessions differ, in counts only: for each candidate explanation (compaction
//                            usage, a replayed parent prefix, which session owns a message two transcripts hold) how many of ALL
//                            matched sessions it would get exactly right. Reads the same folders again; never prints text or a path.
//   --selftest               prove the tool on invented fixture data and exit
//
// Exit codes: 0 every compared session matched to the token, or nothing could be compared (reported as NOT RUN, never as a pass);
// 1 at least one compared session differs; 2 bad usage or a crash. Runs under Node's built-in TypeScript support.
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { diagnose, renderDiagnosis } from './lib/diagnose.ts';
import { runReconcile, selftest, type OracleSource } from './lib/reconcile-run.ts';
import { providerFails, providerPasses, renderReport } from './lib/reconcile.ts';

function usage(message: string): never {
  console.error(`${message}\nSee the comment at the top of scripts/reconcile-usage.ts.`);
  process.exit(2);
}

let args;
try {
  args = parseArgs({
    options: {
      'claude-oracle': { type: 'string' },
      'codex-oracle': { type: 'string' },
      ccusage: { type: 'string' },
      home: { type: 'string' },
      out: { type: 'string' },
      diagnose: { type: 'boolean' },
      selftest: { type: 'boolean' },
    },
    allowPositionals: false,
  }).values;
} catch (error) {
  usage((error as Error).message);
}

try {
  if (args.selftest) {
    const cases = await selftest();
    for (const c of cases)
      console.log(`${c.ok ? 'ok     ' : 'FAILED '} ${c.name}\n         ${c.detail}`);
    const failed = cases.filter((c) => !c.ok).length;
    console.log(
      failed === 0
        ? `\nselftest: ${cases.length} of ${cases.length} cases behaved as they must, on invented data. This says nothing about your own history.`
        : `\nselftest: ${failed} of ${cases.length} cases did NOT behave as they must.`,
    );
    process.exit(failed === 0 ? 0 : 1);
  }

  const program = args.ccusage ?? 'ccusage';
  const source = (file: string | undefined): OracleSource =>
    file ? { kind: 'file', path: file } : { kind: 'program', program };
  const home = args.home ?? homedir();
  console.log(
    `Reading Codex and Claude Code history under ${args.home ? 'the folder you gave' : 'your home folder'} (metadata only; a temporary database, deleted afterwards).\n`,
  );
  const { reports, imports, material } = await runReconcile({
    env: process.env,
    home,
    sources: {
      claude: source(args['claude-oracle']),
      codex: source(args['codex-oracle']),
    },
  });
  const report = [
    `Import: Codex ${imports.codex}; Claude Code ${imports.claude}.`,
    '',
    renderReport(reports),
  ].join('\n');
  console.log(report);
  let text = report;
  if (args.diagnose) {
    console.log('Reading the history again to say why sessions differ (counts only)...\n');
    const diagnosis = renderDiagnosis(await diagnose({ env: process.env, home, material }));
    console.log(diagnosis);
    text = `${report}\n${diagnosis}`;
  }
  if (args.out) writeFileSync(args.out, text + '\n');
  const anyDifference = reports.some(providerFails);
  const notMet = reports
    .filter((r) => !providerPasses(r) && !providerFails(r))
    .map((r) => r.provider);
  if (!anyDifference && notMet.length > 0) {
    console.log(
      `Not met: ${notMet.join(' and ')} could not be compared, so G5_3 is not shown for ${notMet.length === 1 ? 'it' : 'them'}.`,
    );
  }
  process.exit(anyDifference ? 1 : 0);
} catch (error) {
  console.error(`The reconciliation stopped: ${(error as Error).message}`);
  process.exit(2);
}
