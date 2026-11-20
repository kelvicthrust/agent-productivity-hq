import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A machine for first-launch Setup specs (G10_1; P-39, P-40): a TEMPORARY home folder holding copies of the invented fixture
// folders where Claude Code and Codex keep their history, in the state a spec asks for. Discovery is given this home and the
// returned environment; nothing here reads or writes this computer's real folders, and nothing reads a variable of the process.
//
//   found    the fixture folder is there and readable
//   absent   nothing is there: the provider has not run on this machine
//   denied   the folder is there and cannot be read (chmod 000), as macOS does without Files and Folders access
//
// A provider can sit at its documented default (`~/.claude`, `~/.codex`) or at an override location named by the provider's own
// variable (CLAUDE_CONFIG_DIR, CODEX_HOME), which is the case P-39 asks for. `close()` puts permissions back and removes the home.
// No file here is a path the owner is asked for: the point of Setup is that nobody types one.

export type FolderState = 'found' | 'absent' | 'denied';
export type FolderLocation = 'default' | 'override';

export interface SetupHomeOptions {
  /** Default: found. */
  claude?: FolderState;
  codex?: FolderState;
  /** Default: the documented default folder. An override moves the folder and sets the provider's variable in `env`. */
  claudeAt?: FolderLocation;
  codexAt?: FolderLocation;
}

export interface SetupHome {
  /** What discovery calls `~`. */
  home: string;
  /** The environment discovery is given: only the override variables a spec asked for. */
  env: Record<string, string | undefined>;
  /** The folders that were made unreadable, so a spec can name them. */
  denied: string[];
  /** Restores permissions and removes the home. Safe to call twice. */
  close(): void;
}

const FIXTURES = join(import.meta.dirname, '../../fixtures');

/** Whether `chmod 000` keeps this user out: root reads anything, so a spec that needs `denied` skips there. */
export const CAN_DENY = process.getuid?.() !== 0;

/** Every folder and file below `path`, deepest first, so permissions can be restored from the leaves up. */
function everything(path: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const name of entries) {
      const child = join(current, name);
      found.push(child);
      if (statSync(child, { throwIfNoEntry: false })?.isDirectory()) walk(child);
    }
  };
  walk(path);
  return found.reverse();
}

export function makeSetupHome(options: SetupHomeOptions = {}): SetupHome {
  const home = mkdtempSync(join(tmpdir(), 'crew-setup-home-'));
  const env: Record<string, string | undefined> = {};
  const denied: string[] = [];

  const claude = options.claude ?? 'found';
  if (claude !== 'absent') {
    const dir =
      options.claudeAt === 'override'
        ? join(home, 'elsewhere/claude-config')
        : join(home, '.claude');
    if (options.claudeAt === 'override') env['CLAUDE_CONFIG_DIR'] = dir;
    cpSync(join(FIXTURES, 'claude/projects'), join(dir, 'projects'), { recursive: true });
    if (claude === 'denied') denied.push(join(dir, 'projects'));
  } else if (options.claudeAt === 'override') {
    // The variable is set but nothing is there: still "not found", and still no path is asked for.
    env['CLAUDE_CONFIG_DIR'] = join(home, 'elsewhere/claude-config');
  }

  const codex = options.codex ?? 'found';
  if (codex !== 'absent') {
    const dir =
      options.codexAt === 'override' ? join(home, 'elsewhere/codex-home') : join(home, '.codex');
    if (options.codexAt === 'override') env['CODEX_HOME'] = dir;
    mkdirSync(dir, { recursive: true });
    cpSync(join(FIXTURES, 'codex/home'), dir, { recursive: true });
    if (codex === 'denied') denied.push(dir);
  } else if (options.codexAt === 'override') {
    env['CODEX_HOME'] = join(home, 'elsewhere/codex-home');
  }

  for (const path of denied) chmodSync(path, 0o000);

  let closed = false;
  return {
    home,
    env,
    denied,
    close() {
      if (closed) return;
      closed = true;
      for (const path of denied) {
        try {
          chmodSync(path, 0o700);
        } catch {
          // already gone
        }
      }
      for (const path of everything(home)) {
        try {
          chmodSync(path, statSync(path).isDirectory() ? 0o700 : 0o600);
        } catch {
          // already gone
        }
      }
      rmSync(home, { recursive: true, force: true });
    },
  };
}
