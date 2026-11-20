import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPECTED, ROOT } from './harness.ts';
import { LIB_RULES, scanLibFile, scanScript } from './static-rules.ts';

// G3_7: read-only, found by reading the code. Scripts cannot import files, processes or sockets, print outside ctx.out or
// call a write; the lib files that can are few, named, and limited to the functions they need.

describe('scripts follow the rules', () => {
  it.each(EXPECTED)('$id: $script', ({ id, script }) => {
    let source: string;
    try {
      source = readFileSync(join(ROOT, script), 'utf8');
    } catch {
      throw new Error(`${script} does not exist`);
    }
    expect(scanScript(id, source)).toEqual([]);
  });

  it('there is no script beyond the ones this milestone delivers', () => {
    const names = readdirSync(join(ROOT, 'scripts/experiments')).filter((n) => n.endsWith('.ts'));
    expect(names.sort()).toEqual(EXPECTED.map((e) => e.script.split('/').pop()!).sort());
  });
});

describe('the scan itself catches what it should (negative controls)', () => {
  const header =
    "import { defineExperiment, runIfMain } from './lib/cli.ts';\nexport const experiment = defineExperiment({} as never);\nrunIfMain(import.meta, experiment);\n";
  const clean = `${header}// writeFileSync('x') in a comment is fine\nconst url = 'https://example.test'; // fetch( in a comment too\n`;

  it('passes a clean script', () => {
    expect(scanScript('E1', clean)).toEqual([]);
  });

  it.each([
    ['importing fs', "import { readFileSync } from 'node:fs';\n", /node:fs/],
    [
      'importing fs/promises',
      "import { readFile } from 'node:fs/promises';\n",
      /node:fs\/promises/,
    ],
    [
      'importing child_process',
      "import { spawn } from 'node:child_process';\n",
      /node:child_process/,
    ],
    ['importing net', "import net from 'node:net';\n", /node:net/],
    ['an unlisted package', "import x from 'left-pad';\n", /left-pad/],
    [
      'a package for another script',
      "import { Entry } from '@napi-rs/keyring';\n",
      /not allowed for E1/,
    ],
    ['a relative import outside lib', "import x from '../src/server/boot.ts';\n", /not allowed/],
    ['a write call', "x.writeFileSync('a', 'b');\n", /write, delete or permission/],
    ['a delete call', "rmSync('a');\n", /write, delete or permission/],
    ['an exec call', "execSync('ls');\n", /child_process or an exec/],
    ['a direct fetch', "await fetch('https://example.test');\n", /direct fetch/],
    ['globalThis.fetch', "await globalThis.fetch('https://example.test');\n", /direct fetch/],
    ['a WebSocket', "new WebSocket('wss://example.test');\n", /direct fetch/],
    ['eval', "eval('1');\n", /eval or Function/],
    ['require', "require('fs');\n", /require/],
    ['console.log', "console.log('x');\n", /printing outside ctx.out/],
    ['process.stdout.write', "process.stdout.write('x');\n", /printing outside ctx.out/],
    ['process.env', 'const t = process.env.HOME;\n', /process\.env/],
    ['process.exit', 'process.exit(0);\n', /process\.exit/],
  ])('flags %s', (_name, line, message) => {
    expect(scanScript('E1', `${header}${line}`).join(' | ')).toMatch(message);
  });

  it('flags a script that does not declare itself or is never started', () => {
    expect(scanScript('E1', 'export const x = 1;\n').join(' | ')).toMatch(/defineExperiment/);
    expect(
      scanScript(
        'E1',
        "import { defineExperiment } from './lib/cli.ts';\nexport const experiment = defineExperiment({} as never);\n",
      ).join(' | '),
    ).toMatch(/runIfMain/);
  });

  it('lets the two scripts that need an SDK import exactly that SDK', () => {
    expect(scanScript('E3', `${header}import { x } from '@getpaseo/client';\n`)).toEqual([]);
    expect(scanScript('E6', `${header}import { Entry } from '@napi-rs/keyring';\n`)).toEqual([]);
    expect(
      scanScript('E3', `${header}import { Entry } from '@napi-rs/keyring';\n`).length,
    ).toBeGreaterThan(0);
  });
});

describe('the lib: only the files that must write or spawn can, and only what they need', () => {
  const dir = join(ROOT, 'scripts/experiments/lib');
  const libFiles = readdirSync(dir).filter((n) => n.endsWith('.ts'));

  it('every lib file is covered by a rule, and no rule is stale', () => {
    expect(libFiles.sort()).toEqual(Object.keys(LIB_RULES).sort());
  });

  it.each(libFiles)('%s', (name) => {
    expect(scanLibFile(name, readFileSync(join(dir, name), 'utf8'))).toEqual([]);
  });

  it('only findings.ts, runbook.ts, safefile.ts and workspace.ts import a write function from node:fs, and readonly.ts imports none', () => {
    const writes =
      /^(?:write|append|mkdir|mkdtemp|rm|rmdir|unlink|rename|copy|cp|chmod|chown|truncate|symlink|link|create)/;
    const withWrites = libFiles.filter((n) => (LIB_RULES[n]?.fs ?? []).some((f) => writes.test(f)));
    expect(withWrites.sort()).toEqual(['findings.ts', 'runbook.ts', 'safefile.ts', 'workspace.ts']);
    expect((LIB_RULES['readonly.ts']?.fs ?? []).filter((f) => writes.test(f))).toEqual([]);
  });

  it('files an experiment writes (the findings and the temporary workspace) go through safefile.ts, which refuses a symlink or hard link', () => {
    for (const name of ['findings.ts', 'workspace.ts']) {
      const fs = LIB_RULES[name]?.fs ?? [];
      expect(
        fs.filter((f) => /^(?:write|append)File/.test(f)),
        name,
      ).toEqual([]);
      expect(readFileSync(join(dir, name), 'utf8'), name).toContain("from './safefile.ts'");
    }
    const safefile = readFileSync(join(dir, 'safefile.ts'), 'utf8');
    expect(safefile).toContain('O_NOFOLLOW');
    expect(safefile).toContain('nlink');
  });

  it('the lib scan catches a stray import and an extra fs function', () => {
    expect(scanLibFile('redact.ts', "import { readFileSync } from 'node:fs';\n").join(' ')).toMatch(
      /node:fs/,
    );
    expect(
      scanLibFile('readonly.ts', "import { writeFileSync, readFileSync } from 'node:fs';\n").join(
        ' ',
      ),
    ).toMatch(/beyond its allowance: writeFileSync/);
    expect(scanLibFile('shape.ts', "await fetch('https://x.test');\n").join(' ')).toMatch(
      /fetch outside net\.ts/,
    );
    expect(scanLibFile('unknown.ts', '').join(' ')).toMatch(/not in the lib rules/);
  });
});
