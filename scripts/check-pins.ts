// Dependency pin check (pnpm check:pins). Fails when a pin that docs/archive/implementation/execution-record.md
// explains has drifted: it reads the installed packages, not just package.json.
//
//   - every dependency is an exact version (no ^ or ~): no silent upgrades;
//   - TypeScript satisfies typescript-eslint's peer range (it caps TypeScript below 6.1);
//   - ESLint's major is one every installed ESLint plugin accepts (jsx-a11y stops at 9);
//   - TanStack Query's React peer range accepts the installed React;
//   - Astryx core and theme-stone are the same exact version (theme-stone peers core exactly);
//   - pnpm refuses too-new releases instead of silently exempting them, and runs no install scripts
//     that are not explicitly decided.
//
// Runs under Node's built-in TypeScript support: erasable syntax only, explicit .ts import extensions.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
type Json = Record<string, unknown>;
const readJson = (rel: string): Json => JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as Json;
const installed = (name: string): Json => readJson(`node_modules/${name}/package.json`);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const problems: string[] = [];
const fail = (msg: string): void => {
  problems.push(msg);
};

type Version = [number, number, number];
const parseVersion = (v: string): Version => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) throw new Error(`not a version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
const cmp = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const pkg = readJson('package.json');

// 1. exact pins
for (const block of ['dependencies', 'devDependencies'] as const) {
  for (const [name, range] of Object.entries((pkg[block] ?? {}) as Record<string, string>)) {
    if (!/^\d+\.\d+\.\d+$/.test(range))
      fail(`${name} is "${range}" in package.json: pin an exact version`);
  }
}

// 2. TypeScript against typescript-eslint's peer range
const tsVersion = parseVersion(str(installed('typescript')['version']));
const tseslintPeers = (installed('typescript-eslint')['peerDependencies'] ?? {}) as Record<
  string,
  string
>;
const tsRange = tseslintPeers['typescript'] ?? '';
const lower = /(?:>=)\s*(\d+\.\d+\.\d+)/.exec(tsRange);
const upper = /<\s*(\d+\.\d+\.\d+)/.exec(tsRange);
if (!lower?.[1] || !upper?.[1]) {
  fail(
    `typescript-eslint's typescript peer range "${tsRange}" has a new shape: update scripts/check-pins.ts`,
  );
} else if (
  cmp(tsVersion, parseVersion(lower[1])) < 0 ||
  cmp(tsVersion, parseVersion(upper[1])) >= 0
) {
  fail(`typescript ${tsVersion.join('.')} is outside typescript-eslint's peer range "${tsRange}"`);
}

// 3. ESLint major against every installed ESLint plugin's peer range
const eslintMajor = parseVersion(str(installed('eslint')['version']))[0];
for (const plugin of ['eslint-plugin-jsx-a11y', 'eslint-plugin-react-hooks', 'typescript-eslint']) {
  const range = str(
    ((installed(plugin)['peerDependencies'] ?? {}) as Record<string, string>)['eslint'],
  );
  const majors = range.split('||').map((part) => Number(/(\d+)/.exec(part)?.[1]));
  if (!majors.includes(eslintMajor))
    fail(`eslint ${eslintMajor} is not accepted by ${plugin} (peer "${range}")`);
}

// 3b. TanStack Query's React peer range against the installed React
const reactMajor = parseVersion(str(installed('react')['version']))[0];
const queryReactRange = str(
  ((installed('@tanstack/react-query')['peerDependencies'] ?? {}) as Record<string, string>)[
    'react'
  ],
);
const queryReactMajors = queryReactRange.split('||').map((part) => Number(/(\d+)/.exec(part)?.[1]));
if (!queryReactMajors.includes(reactMajor))
  fail(`react ${reactMajor} is not accepted by @tanstack/react-query (peer "${queryReactRange}")`);

// 4. Astryx core and theme-stone: one exact version
const core = str(installed('@astryxdesign/core')['version']);
const stone = str(installed('@astryxdesign/theme-stone')['version']);
const stonePeer = str(
  ((installed('@astryxdesign/theme-stone')['peerDependencies'] ?? {}) as Record<string, string>)[
    '@astryxdesign/core'
  ],
);
if (core !== stone)
  fail(`@astryxdesign/core ${core} and theme-stone ${stone} must be the same version`);
if (stonePeer !== core)
  fail(`theme-stone peers @astryxdesign/core "${stonePeer}" but ${core} is installed`);

// 5. pnpm supply-chain settings
const wsPath = join(ROOT, 'pnpm-workspace.yaml');
const ws = (existsSync(wsPath) ? parse(readFileSync(wsPath, 'utf8')) : {}) as Json;
if (!ws['cacheDir'])
  fail(
    'pnpm-workspace.yaml: cacheDir must be set (project-local cache; offline installs need it, see the execution record)',
  );
if (ws['minimumReleaseAgeStrict'] !== true)
  fail('pnpm-workspace.yaml: minimumReleaseAgeStrict must be true');
if (ws['minimumReleaseAgeExclude'])
  fail(
    'pnpm-workspace.yaml: minimumReleaseAgeExclude must stay empty unless the execution record explains each entry',
  );
const builds = (ws['allowBuilds'] ?? {}) as Record<string, unknown>;
for (const [name, allowed] of Object.entries(builds)) {
  if (typeof allowed !== 'boolean')
    fail(`pnpm-workspace.yaml: allowBuilds.${name} must be true or false`);
}

// 6. engines
const nodeRange = str(((pkg['engines'] ?? {}) as Record<string, string>)['node']);
if (!/^>=26(\.|$)/.test(nodeRange))
  fail(`engines.node is "${nodeRange}": expected the Node 26 line (">=26...")`);

if (problems.length > 0) {
  console.error(`Pin check failed:\n${problems.map((p) => ` - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(
  `pins ok: typescript ${tsVersion.join('.')} (typescript-eslint peer "${tsRange}"), eslint ${eslintMajor}, astryx ${core}, node "${nodeRange}", node running ${process.version}`,
);
