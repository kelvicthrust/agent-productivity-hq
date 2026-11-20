import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Claude credential reads and its outbound address each stay behind one port. The legacy removal flow
// remains separate, and account percentages do not reach session, link, or repository data.

const ROOT = join(import.meta.dirname, '../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

const files = sourceFiles(join(ROOT, 'src'))
  .filter((path) => /\.(ts|tsx|mjs)$/.test(path))
  .map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, 'utf8') }));

const where = (pattern: RegExp): string[] =>
  files.filter(({ text }) => pattern.test(text)).map(({ path }) => path);

describe('Claude plan usage and ChatGPT: what the code may not do', () => {
  it('names the sole Claude usage address in the outbound allowlist only', () => {
    expect(where(/https?:\/\/api\.anthropic\.com/i)).toEqual(['src/server/lib/net.ts']);
    expect(where(/oauth-2025-04-20/)).toEqual(['src/server/integrations/claudePlan/usage.ts']);
  });

  it('confines Claude Code’s credential store to its explicit check adapter', () => {
    const reader = 'src/server/integrations/claudePlan/credentials.ts';
    expect(where(/\.credentials\.json|Claude Code-credentials/i)).toEqual([reader]);
    expect(where(/find-generic-password|\bsecurity\s+find/)).toEqual([]);
    expect(where(/@napi-rs\/keyring/)).toEqual(['src/server/collectors/github/live.ts', reader]);
  });

  it('names Claude Code’s settings files only inside integrations/claudeCapture and, for the owner’s opt-in hooks switch, integrations/claudeHooks', () => {
    const named = where(/settings\.local\.json|['"`/]settings\.json/);
    expect(
      named.filter(
        (path) =>
          !path.startsWith('src/server/integrations/claudeCapture/') &&
          !path.startsWith('src/server/integrations/claudeHooks/'),
      ),
    ).toEqual([]);
  });

  it('starts a program from one ChatGPT file only, and the Claude hook starts one only to run the owner’s own status line', () => {
    const spawns = where(/\bspawn\(/);
    expect(spawns).toEqual([
      'src/server/collectors/chatgpt/live.ts',
      'src/server/integrations/claudeCapture/assets/claude-statusline.mjs',
    ]);
  });

  it('has no account percentage in the contracts of a series, a repo row, a session or a link', () => {
    for (const name of ['series', 'overview', 'prs', 'usage']) {
      const text = readFileSync(join(ROOT, `src/shared/contracts/${name}.ts`), 'utf8');
      expect(text, name).not.toMatch(/usedPercent|used_percentage|rateLimits/);
    }
  });
});
