import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The preview command shows SYNTHETIC data and must never read this Mac (M5, G5_5): it boots with scripted adapters and no `local`
// machine, so neither the real Codex and Claude Code adapters nor the refresh discovery are ever built. The standalone and
// Paseo-managed entry points pass `local` through liveBootDeps. First-launch Setup (M10) can be tried in the preview, and its discovery looks at a TEMPORARY home made for the
// purpose (`makeSetupHome`, invented fixture folders, removed at exit), handed over as `setup`, never as `local`. A source-level check, because the preview cannot be started here (no port) and a regression would only show on a
// developer's machine as their own history appearing under the "Synthetic preview data" label.

const read = (path: string) => readFileSync(join(import.meta.dirname, '../..', path), 'utf8');
const code = (text: string) => text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('the preview command and this machine', () => {
  it('builds no real adapter, runs no discovery and gives boot no machine', () => {
    const preview = code(read('scripts/preview-seed.ts'));
    expect(preview).not.toMatch(/createLocalAdapters|createDiscoveryStep|collectors\/discovery/);
    expect(preview).not.toMatch(/collectors\/(claude|codex)\//);
    expect(preview).not.toMatch(/liveBootDeps|src\/server\/(?:live|main|managed)\b/);
    // The one machine the preview has is Setup's temporary one: nothing but that exact form may be named `local`.
    const withoutSetupMachine = preview.replace(
      /setup:\s*\{\s*local:\s*\{\s*env:\s*machine\.env,\s*home:\s*machine\.home\s*\}/,
      '',
    );
    expect(withoutSetupMachine).not.toMatch(/\blocal\s*:/);
    expect(preview).toMatch(/const machine = makeSetupHome\(\)/);
    expect(preview).not.toMatch(/homedir/);
    expect(preview).toMatch(/scriptedAdapter\(/);
  });

  it('passes the real host through the two production startup paths', () => {
    const live = code(read('src/server/live.ts'));
    expect(live).toMatch(/const home = homedir\(\)/);
    expect(live).toMatch(/const env = process\.env/);
    expect(live).toMatch(/local:\s*\{\s*env,\s*home\s*\}/);
    const main = code(read('src/server/main.ts'));
    expect(main).toMatch(/\bboot\(config,\s*liveBootDeps\(\)\)/);
    const managed = code(read('src/server/managed.ts'));
    expect(managed).toMatch(
      /\bboot\(config,\s*\{\s*\.\.\.liveBootDeps\(\),\s*version,\s*remote:\s*startup\.remote\s*\}\)/,
    );
  });
});
