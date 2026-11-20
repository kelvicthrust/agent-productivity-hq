import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { FIXTURES } from '../../experiments/harness.ts';

// Provider homes for the transcript feed tests: a temp folder with the invented fixture transcripts (test/fixtures/live) copied in, and
// every file given a modified time of "a second before the test's clock", so the feeds see them as being written now.

export const T0 = Date.parse('2026-11-19T10:00:00Z');
export const at = (seconds: number): number => T0 + seconds * 1000;

export const S1 = '11111111-1111-4111-8111-111111111111';
export const S2 = '22222222-2222-4222-8222-222222222222';
export const R1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const R2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const R3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function filesBelow(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesBelow(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

/** Sets the modified time of a file, or of every file below a folder. */
export function stamp(path: string, ms: number): void {
  const when = new Date(ms);
  const files = statSync(path).isDirectory() ? filesBelow(path) : [path];
  for (const file of files) utimesSync(file, when, when);
}

export interface Homes {
  /** A Claude config dir holding `projects/` (the fixture transcripts). */
  claudeDir: string;
  /** A Codex home holding `sessions/` and `archived_sessions/`. */
  codexHome: string;
  /** The folder that holds both, for tests that search for stray paths. */
  root: string;
}

export function makeHomes(clock: number): Homes {
  const root = mkdtempSync(join(tmpdir(), 'live-feed-'));
  made.push(root);
  const claudeDir = join(root, '.claude');
  const codexHome = join(root, '.codex');
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  cpSync(join(FIXTURES, 'live/claude/projects'), join(claudeDir, 'projects'), { recursive: true });
  cpSync(join(FIXTURES, 'live/codex/sessions'), join(codexHome, 'sessions'), { recursive: true });
  cpSync(join(FIXTURES, 'live/codex/archived_sessions'), join(codexHome, 'archived_sessions'), {
    recursive: true,
  });
  stamp(root, clock - 1000);
  return { claudeDir, codexHome, root };
}
