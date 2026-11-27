import { existsSync, readFileSync } from 'node:fs';

export const releaseManifests = [
  'package.json',
  'packages/cli/package.json',
  'plugins/paseo-agent-productivity/package.json',
] as const;

const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function selectReleaseVersion(value: unknown): string {
  if (typeof value !== 'string' || !stable.test(value)) {
    throw new Error('Release builds require a stable X.Y.Z package version.');
  }
  return value;
}

export function compareStableVersions(version: string, previous: string): number {
  const previousParts = previous.split('.').map(BigInt);
  for (const [index, part] of version.split('.').map(BigInt).entries()) {
    const last = previousParts[index]!;
    if (part !== last) return part < last ? -1 : 1;
  }
  return 0;
}

function checkReleaseVersion(previous: string | undefined): string {
  const versions = releaseManifests.map((path) => {
    const manifest = JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')) as {
      version: unknown;
    };
    return manifest.version;
  });
  const version = selectReleaseVersion(versions[0]);
  if (versions.some((candidate) => candidate !== version)) {
    throw new Error('The app, CLI, and Paseo package versions must match.');
  }

  if (previous === undefined) return version;
  if (!stable.test(previous)) throw new Error('The previous app version must be stable X.Y.Z.');
  const order = compareStableVersions(version, previous);
  if (order === 0) return '';
  if (order < 0) throw new Error(`Package version ${version} must be newer than ${previous}.`);

  const notesPath = `docs/releases/v${version}.md`;
  const notes = new URL(`../${notesPath}`, import.meta.url);
  const heading = `# What's new in v${version}`;
  if (!existsSync(notes)) throw new Error(`Create ${notesPath} before releasing v${version}.`);
  const [firstLine, ...body] = readFileSync(notes, 'utf8').trim().split(/\r?\n/);
  if (firstLine !== heading || !body.some((line) => line.trim() !== '')) {
    throw new Error(`${notesPath} needs the heading "${heading}" and release notes below it.`);
  }
  return version;
}

if (import.meta.main) {
  const version = checkReleaseVersion(process.argv[2]);
  if (version) console.log(version);
}
