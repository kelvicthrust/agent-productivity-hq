import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const registry = 'https://registry.npmjs.org/';
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const [, , version, directory] = process.argv;
if (!version || !stable.test(version) || !directory) {
  throw new Error('Usage: node scripts/publish-release-npm.ts <X.Y.Z> <release directory>');
}

interface RegistryMetadata {
  'dist-tags': { latest?: string };
  versions: Record<string, { dist: { integrity?: string } }>;
}

async function metadata(name: string): Promise<RegistryMetadata> {
  const response = await fetch(
    `${registry}${encodeURIComponent(name)}?release-check=${Date.now()}`,
    {
      signal: AbortSignal.timeout(15_000),
      headers: { accept: 'application/vnd.npm.install-v1+json', 'cache-control': 'no-cache' },
    },
  );
  if (!response.ok) throw new Error(`Cannot read ${name} on npm (HTTP ${response.status}).`);
  return (await response.json()) as RegistryMetadata;
}

function compareStable(left: string, right: string): number {
  if (!stable.test(left)) throw new Error(`Unexpected npm latest tag version ${left}.`);
  const rightParts = right.split('.');
  for (const [index, part] of left.split('.').entries()) {
    const a = BigInt(part);
    const b = BigInt(rightParts[index]!);
    if (a !== b) return a > b ? 1 : -1;
  }
  return 0;
}

function checkLatest(name: string, data: RegistryMetadata, targetVersion: string) {
  const latest = data['dist-tags'].latest;
  if (latest && compareStable(latest, targetVersion) > 0) {
    throw new Error(`${name}@${latest} is already latest. Refusing to promote ${targetVersion}.`);
  }
  return latest;
}

function npm(...args: string[]) {
  execFileSync('npm', [...args, `--registry=${registry}`], { stdio: 'inherit' });
}

const packages = await Promise.all(
  ['agent-productivity-hq', 'paseo-agent-productivity-hq'].map(async (basename) => {
    const name = `@kelvicthrust/${basename}`;
    const archive = resolve(directory, `kelvicthrust-${basename}-${version}.tgz`);
    const expected = readFileSync(archive);
    const data = await metadata(name);
    checkLatest(name, data, version);
    const existing = data.versions[version];
    if (existing) {
      const integrity = 'sha512-' + createHash('sha512').update(expected).digest('base64');
      if (existing.dist.integrity !== integrity) {
        throw new Error(`${name}@${version} already exists on npm with different bytes.`);
      }
    }
    const downloadUrl = `${registry}${name}/-/${basename}-${version}.tgz`;
    return { name, archive, expected, existing, downloadUrl };
  }),
);

for (const pkg of packages) {
  if (!pkg.existing)
    npm('publish', pkg.archive, '--ignore-scripts', '--access=public', '--tag=next');
}

async function verifyDownload(pkg: (typeof packages)[number]) {
  // npm may accept the publish before its scan makes the tarball downloadable.
  const deadline = Date.now() + 25 * 60_000;
  while (true) {
    const response = await fetch(pkg.downloadUrl, { signal: AbortSignal.timeout(30_000) });
    if (response.ok) {
      const actual = Buffer.from(await response.arrayBuffer());
      if (!actual.equals(pkg.expected)) {
        throw new Error(`Downloaded ${pkg.name}@${version} differs from the verified build.`);
      }
      console.log(`Verified ${pkg.name}@${version} from npm.`);
      return;
    }
    if (response.status !== 404 || Date.now() >= deadline) {
      throw new Error(`Cannot download ${pkg.name}@${version} from npm (HTTP ${response.status}).`);
    }
    console.log(`Waiting for npm to make ${pkg.name}@${version} available.`);
    await delay(30_000);
  }
}

await Promise.all(packages.map(verifyDownload));
const promotions = await Promise.all(
  packages.map(async ({ name }) => ({
    name,
    latest: checkLatest(name, await metadata(name), version),
  })),
);
for (const { name, latest } of promotions) {
  if (latest !== version) npm('dist-tag', 'add', `${name}@${version}`, 'latest');
}
