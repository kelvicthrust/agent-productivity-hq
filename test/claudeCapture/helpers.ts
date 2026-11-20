import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach } from 'vitest';
import {
  createClaudeCapture,
  type ClaudeCapture,
  type ClaudeCaptureOptions,
} from '../../src/server/integrations/claudeCapture/index.ts';

import {
  capturePaths,
  snapshotDirectory,
} from '../../src/server/integrations/claudeCapture/paths.ts';
import {
  activeSnapshotPath,
  writeState,
} from '../../src/server/integrations/claudeCapture/state.ts';

// Every test here runs in a throwaway folder whose path contains a space, with CLAUDE_CONFIG_DIR and the home folder passed
// in explicitly: nothing reads or writes the real ~/.claude, and process.env is never changed.

export const FIXTURES = resolve(import.meta.dirname, '../fixtures/claude-settings');
export const ASSET = resolve(
  import.meta.dirname,
  '../../src/server/integrations/claudeCapture/assets/claude-statusline.mjs',
);

export const fixture = (...parts: string[]): string =>
  readFileSync(join(FIXTURES, ...parts), 'utf8');
export const fixtureBytes = (...parts: string[]): Buffer => readFileSync(join(FIXTURES, ...parts));

/** Every string a fixture plants where real text would be. None may reach a snapshot, a state file or a response. */
export const SENTINEL = /SENTINEL_/;

/** A fixed start for the fake clock (epoch ms): 2026-11-04 20:00 UTC. */
export const NOW = Date.parse('2026-11-04T20:00:00Z');
export const DAY = 86_400_000;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    // Make anything a test locked (a decoy credentials file) removable again.
    try {
      chmodAll(root);
    } catch {
      // best effort
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function chmodAll(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      chmodSync(path, 0o700);
      chmodAll(path);
    } else {
      chmodSync(path, 0o600);
    }
  }
}

export interface Rig {
  /** The throwaway root; its name has a space. */
  root: string;
  /** CLAUDE_CONFIG_DIR, with a space in its name. */
  configDir: string;
  settingsPath: string;
  /** The dashboard's data folder, with a space in its name. */
  dataDir: string;
  /** A stand-in for the home folder (used only when CLAUDE_CONFIG_DIR is not set). */
  home: string;
  clock: { now: number };
  capture: ClaudeCapture;
  writeSettings(content: string | object): void;
  readSettingsText(): string;
  readSettingsJson(): Record<string, unknown>;
  /** A fresh capture object over the same folders (another Node path, say), as a restart of the dashboard would give. */
  another(options?: Partial<ClaudeCaptureOptions>): ClaudeCapture;
}

export interface RigOptions {
  /** A fixture under test/fixtures/claude-settings/settings to start with. */
  settings?: string;
  /** Raw text for the settings file (wins over `settings`). */
  rawSettings?: string;
  projectDirs?: () => readonly string[];
  nodePath?: string;
  /** Leave CLAUDE_CONFIG_DIR unset, so the settings file is `<home>/.claude/settings.json`. */
  homeDefault?: boolean;
}

export function rig(options: RigOptions = {}): Rig {
  const root = mkdtempSync(join(tmpdir(), 'crew claude '));
  roots.push(root);
  const home = join(root, 'Home Dir');
  const configDir = options.homeDefault ? join(home, '.claude') : join(root, 'Claude Config');
  const dataDir = join(root, 'Application Support', 'agent-productivity');
  mkdirSync(configDir, { recursive: true });
  const settingsPath = join(configDir, 'settings.json');
  const clock = { now: NOW };

  const build = (extra: Partial<ClaudeCaptureOptions> = {}): ClaudeCapture =>
    createClaudeCapture({
      dataDir,
      env: options.homeDefault ? {} : { CLAUDE_CONFIG_DIR: configDir },
      home,
      now: () => clock.now,
      ...(options.nodePath === undefined ? {} : { nodePath: options.nodePath }),
      ...(options.projectDirs === undefined ? {} : { projectDirs: options.projectDirs }),
      ...extra,
    });

  const made: Rig = {
    root,
    configDir,
    settingsPath,
    dataDir,
    home,
    clock,
    capture: build(),
    writeSettings(content) {
      writeFileSync(
        settingsPath,
        typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`,
      );
    },
    readSettingsText: () => readFileSync(settingsPath, 'utf8'),
    readSettingsJson: () =>
      JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>,
    another: (extra) => build(extra),
  };
  if (options.rawSettings !== undefined) made.writeSettings(options.rawSettings);
  else if (options.settings !== undefined)
    made.writeSettings(fixture('settings', options.settings));
  return made;
}

/** Every file under `dir` as `relative path → content hash` (a folder is `dir`, an unreadable file `unreadable`). */
export function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const path = join(current, name);
      const key = relative(dir, path);
      if (statSync(path).isDirectory()) {
        out[key] = 'dir';
        walk(path);
      } else {
        try {
          out[key] = createHash('sha256').update(readFileSync(path)).digest('hex');
        } catch {
          out[key] = 'unreadable';
        }
      }
    }
  };
  walk(dir);
  return out;
}

/** Names of the entries directly inside `dir`, sorted. */
export const names = (dir: string): string[] => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};

export const modeOf = (path: string): number => statSync(path).mode & 0o777;

// ---- the hook as a child process -----------------------------------------------------------------------------------------

export interface ChildRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
  /** Wall time of the child, Node start-up included. */
  ms: number;
}

/** Runs a program, feeds it `stdin` and collects everything. */
export function runChild(
  command: string,
  args: string[],
  options: { stdin?: Buffer | string; cwd?: string } = {},
): Promise<ChildRun> {
  return new Promise((resolvePromise, reject) => {
    const started = performance.now();
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.stdin.on('error', () => undefined);
    child.on('close', (code, signal) =>
      resolvePromise({
        code,
        signal,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString('utf8'),
        ms: performance.now() - started,
      }),
    );
    child.stdin.end(options.stdin);
  });
}

/** Installs the hook the way `apply` does (script and config in the data folder), without touching any settings. */
export function installHookFiles(dataDir: string, previousCommand: string | null | 'omit'): string {
  mkdirSync(dataDir, { recursive: true });
  const script = join(dataDir, 'claude-statusline.mjs');
  copyFileSync(ASSET, script);
  const paths = capturePaths(dataDir);
  const snapshotId = '0123456789abcdef01234567';
  mkdirSync(snapshotDirectory(paths, snapshotId), { recursive: true });
  writeState(paths, {
    v: 2,
    phase: 'active',
    snapshotId,
    settingsPath: '',
    settingsRealPath: '',
    node: process.execPath,
    script,
    wrapper: '',
    expectedStatusLine: null,
    previousStatusLine: null,
    backupPath: null,
    installedAt: NOW,
  });
  if (previousCommand !== 'omit') {
    writeFileSync(
      join(dataDir, 'claude-statusline.config.json'),
      `${JSON.stringify({ previousCommand })}\n`,
    );
  }
  return script;
}

/** Runs the installed hook as Claude Code would: `node <script>` with the status-line JSON on stdin. */
export const runHookScript = (dataDir: string, stdin: Buffer | string): Promise<ChildRun> =>
  runChild(process.execPath, [join(dataDir, 'claude-statusline.mjs')], { stdin });

export function testSnapshotPath(dataDir: string): string {
  const paths = capturePaths(dataDir);
  return activeSnapshotPath(paths) ?? paths.snapshot;
}

export const readSnapshotFile = (dataDir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(testSnapshotPath(dataDir), 'utf8')) as Record<string, unknown>;

export const writeSnapshotFile = (dataDir: string, snapshot: object): void => {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(testSnapshotPath(dataDir), `${JSON.stringify(snapshot, null, 2)}\n`);
};

export function installByHand(
  world: Rig,
  capture = world.capture,
): ReturnType<ClaudeCapture['plan']> {
  const plan = capture.plan();
  capture.change({ action: 'prepare_install', confirm: plan.previewDigest });
  world.writeSettings({
    ...(plan.settingsFileExists ? world.readSettingsJson() : {}),
    statusLine: plan.next,
  });
  capture.change({ action: 'verify_install' });
  return plan;
}

export function removeByHand(world: Rig, previousStatusLine: unknown): void {
  world.capture.change({ action: 'begin_remove' });
  const settings = world.readSettingsJson();
  if (previousStatusLine === null) {
    delete settings['statusLine'];
  } else {
    settings['statusLine'] = previousStatusLine;
  }
  world.writeSettings(settings);
  world.capture.change({ action: 'verify_remove' });
}

export const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
