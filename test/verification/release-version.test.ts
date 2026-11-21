import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';

const manifests = [
  'package.json',
  'packages/cli/package.json',
  'plugins/paseo-agent-productivity/package.json',
];

function check(version: string, previous?: string, pluginVersion = version) {
  const root = mkdtempSync(join(tmpdir(), 'release-version-'));
  try {
    const script = join(root, 'scripts/check-release-version.ts');
    mkdirSync(dirname(script));
    copyFileSync(new URL('../../scripts/check-release-version.ts', import.meta.url), script);
    for (const manifest of manifests) {
      const path = join(root, manifest);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({ version: manifest === manifests[2] ? pluginVersion : version }),
      );
    }
    return spawnSync(process.execPath, previous === undefined ? [script] : [script, previous], {
      encoding: 'utf8',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it('reports the current version for a build-only run', () => {
  expect(check('1.0.3')).toMatchObject({ status: 0, stdout: '1.0.3\n' });
});

it.each([
  ['1.0.2', '1.0.3'],
  ['1.9.9', '1.10.0'],
  ['1.10.0', '2.0.0'],
])('selects a release for a version bump from %s to %s', (previous, version) => {
  expect(check(version, previous)).toMatchObject({ status: 0, stdout: version + '\n' });
});

it('skips publication when the version is unchanged', () => {
  expect(check('1.0.3', '1.0.3')).toMatchObject({ status: 0, stdout: '' });
});

it('rejects a lower version', () => {
  const result = check('1.9.9', '1.10.0');
  expect(result).toMatchObject({ status: 1, stdout: '' });
  expect(result.stderr).toContain('Package version 1.9.9 must be newer than 1.10.0.');
});

it('rejects a prerelease or a mismatched manifest', () => {
  expect(check('1.0.3-rc.1', '1.0.2')).toMatchObject({ status: 1, stdout: '' });
  const result = check('1.0.3', '1.0.2', '1.0.2');
  expect(result).toMatchObject({ status: 1, stdout: '' });
  expect(result.stderr).toContain('The app, CLI, and Paseo package versions must match.');
});
