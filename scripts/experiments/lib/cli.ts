import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs, UsageError } from './args.ts';
import { defaultFindingsPath, validateMeta } from './meta.ts';
import { FindingsBuilder, verdictWord, writeFindings, writeResultJson } from './findings.ts';
import { createNet } from './net.ts';
import { createReadGuard } from './readonly.ts';
import { assertNoSecrets, LeakError, withholdSecrets } from './secrets.ts';
import { createSpawner } from './spawn.ts';
import { createTempWorkspace, openTempWorkspace } from './workspace.ts';
import type {
  Experiment,
  ExperimentContext,
  ExperimentMeta,
  ParsedArgs,
  RunTrace,
  TempWorkspace,
} from './types.ts';

// Runs one experiment: parses the flags every script shares, builds the guarded context, runs the script, writes the
// findings and decides the exit code. 0 = no criterion failed, 1 = at least one failed, 2 = the script itself stopped.

/** Flags every script understands. Anything else is the script's own. */
export const STANDARD_FLAGS = [
  'help',
  'list-reads',
  'out',
  'json',
  'bin',
  'net-fixture',
  'home',
  'now',
] as const;

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Readonly<Record<string, string | undefined>>;
}

const processIo = (): Io => ({
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  env: process.env,
});

export function defineExperiment(experiment: Experiment): Experiment {
  const problems = validateMeta(experiment.meta);
  if (problems.length > 0)
    throw new Error(`Invalid experiment ${experiment.meta.id}: ${problems.join('; ')}`);
  return experiment;
}

const bullets = (items: string[]): string =>
  items.length > 0 ? items.map((i) => `  - ${i}`).join('\n') : '  - none';

export function describeMeta(meta: ExperimentMeta): string {
  return [
    `${meta.id} · ${meta.title}`,
    meta.question,
    'Reads:',
    bullets(meta.reads),
    'Prints:',
    bullets(meta.prints),
    'Writes:',
    bullets(meta.writes),
    'Network:',
    bullets(meta.network),
    'Starts programs:',
    bullets(meta.spawns),
  ].join('\n');
}

const USAGE = [
  'Flags for every experiment:',
  '  --help              this text',
  '  --list-reads        list what the script reads, prints, writes, contacts and starts, and stop',
  '  --out <file>        write the findings here instead of docs/implementation/experiments/<id>.md (the file must be named <id>.md)',
  '  --json <file>       also write the structured result',
  '  --bin <name>=<path> use this program for <name> (repeatable)',
  '  --net-fixture <f>   answer network requests from a fixture file and contact nothing (self-test)',
  '  --home <dir>        treat this folder as the home folder when building default paths',
  '  --now <iso>         use this time as now (self-test)',
].join('\n');

export async function runExperiment(
  experiment: Experiment,
  argv: readonly string[],
  io: Io = processIo(),
): Promise<number> {
  const { meta } = experiment;
  const say = (text: string) => {
    assertNoSecrets(text, 'print this line');
    io.stdout(`${text}\n`);
  };

  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.stderr(`${error instanceof UsageError ? error.message : 'Bad arguments.'}\n${USAGE}\n`);
    return 2;
  }
  if (args.has('help')) {
    say(`${describeMeta(meta)}\n\n${USAGE}`);
    return 0;
  }
  if (args.has('list-reads')) {
    say(describeMeta(meta));
    return 0;
  }

  const nowFlag = args.get('now');
  const fixedNow = nowFlag ? Date.parse(nowFlag) : Number.NaN;
  if (nowFlag && Number.isNaN(fixedNow)) {
    io.stderr('--now must be an ISO time such as 2026-11-08T12:00:00Z\n');
    return 2;
  }
  const now = () => (nowFlag ? fixedNow : Date.now());

  const bins = new Map<string, string>();
  for (const spec of args.all('bin')) {
    const eq = spec.indexOf('=');
    if (eq < 1) {
      io.stderr('--bin must look like name=path\n');
      return 2;
    }
    bins.set(spec.slice(0, eq), resolve(spec.slice(eq + 1)));
  }

  const guard = createReadGuard(io.env);
  const spawner = createSpawner({ allowed: meta.spawns, bins, announce: say });
  const netFixture = args.get('net-fixture');
  const net = createNet({
    hosts: meta.network,
    fixturePath: netFixture ? resolve(netFixture) : undefined,
    announce: say,
  });
  const findings = new FindingsBuilder(meta, now);
  let workspaceFolders = 0;
  const workspaces: TempWorkspace[] = [];

  const ctx: ExperimentContext = {
    meta,
    args,
    env: io.env,
    home: args.get('home') ? resolve(args.get('home')!) : homedir(),
    now,
    willRead(label, path) {
      const abs = guard.declare(path);
      say(`Will read: ${label}: ${abs}`);
      return abs;
    },
    fs: guard,
    spawn: (program, programArgs, options) => spawner.run(program, programArgs, options),
    session: (program, programArgs) => spawner.session(program, programArgs),
    fetch: (url, init) => net.fetch(url, init),
    workspace: {
      create(prefix) {
        const workspace = createTempWorkspace(prefix);
        workspaceFolders++;
        workspaces.push(workspace);
        say(`Will write only inside this temporary folder: ${workspace.dir}`);
        return workspace;
      },
      open: (dir) => openTempWorkspace(dir),
    },
    out: { line: say },
    findings,
  };

  say(`${meta.id} · ${meta.title}`);
  say(
    'Read-only and metadata-only: nothing is changed, and no message text, token or credential is printed or stored.',
  );

  const finish = (): RunTrace => ({
    ...guard.trace(),
    programsStarted: spawner.started(),
    hostsContacted: net.contacted(),
    workspaceFolders,
  });

  try {
    await experiment.run(ctx);
  } catch (error) {
    spawner.killAll();
    const text =
      error instanceof LeakError
        ? error.message
        : withholdSecrets(
            error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error',
          );
    io.stderr(`${meta.id} stopped: ${text.slice(0, 300)}\n`);
    return 2;
  }
  spawner.killAll();

  try {
    const doc = findings.build(finish());
    const outPath = args.get('out') ? resolve(args.get('out')!) : defaultFindingsPath(meta.id);
    writeFindings(doc, outPath);
    const jsonPath = args.get('json');
    if (jsonPath) writeResultJson(doc, resolve(jsonPath));
    say('');
    for (const c of doc.criteria)
      say(`${verdictWord(c.verdict)}  ${c.id}${c.detail ? `: ${c.detail}` : ''}`);
    say(`Result: ${verdictWord(doc.overall)}`);
    say(`Findings written to ${outPath}`);
    return doc.overall === 'fail' ? 1 : 0;
  } catch (error) {
    io.stderr(
      `${meta.id} stopped: ${(error instanceof LeakError ? error.message : error instanceof Error ? `${error.name}: ${withholdSecrets(error.message)}` : 'unknown error').slice(0, 300)}\n`,
    );
    return 2;
  }
}

/** True when `filename` is the file Node was started with. Compares real paths, so a symlinked folder (like /var -> /private/var) still counts. */
export function isMain(filename: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(filename);
  } catch {
    return resolve(entry) === filename;
  }
}

/** Put this at the bottom of a script: it runs the experiment only when the file is started directly, not when imported. */
export function runIfMain(importMeta: { filename: string }, experiment: Experiment): void {
  if (process.argv.includes('--hook')) return; // hook mode is handled by runHookIfMain
  if (isMain(importMeta.filename)) {
    void runExperiment(experiment, process.argv.slice(2)).then((code) => {
      process.exitCode = code;
    });
  }
}

export interface HookInput {
  /** What the host program wrote to the hook's standard input (at most 1 MB). */
  stdin: string;
  args: ParsedArgs;
  now(): number;
  /** The workspace folder given with --dir. Throws unless an experiment script created it under the temp folder. */
  workspace(): TempWorkspace;
}

/**
 * For E8's status-line hook: when the file is started with `--hook`, read standard input, call `handler`, print nothing
 * and always exit 0, so a hook can never disturb Claude Code. Returns true when it handled the start.
 */
export function runHookIfMain(
  importMeta: { filename: string },
  handler: (input: HookInput) => void | Promise<void>,
): boolean {
  const argv = process.argv.slice(2);
  if (!argv.includes('--hook') || !isMain(importMeta.filename)) return false;
  void (async () => {
    try {
      const args = parseArgs(argv);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        size += (chunk as Buffer).length;
        if (size > 1_000_000) break;
        chunks.push(chunk as Buffer);
      }
      await handler({
        stdin: Buffer.concat(chunks).toString('utf8'),
        args,
        now: () => Date.now(),
        workspace: () => openTempWorkspace(args.get('dir') ?? ''),
      });
    } catch {
      // A hook must never disturb the program that runs it.
    }
    process.exitCode = 0;
  })();
  return true;
}
