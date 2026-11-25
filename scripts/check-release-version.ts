import { existsSync, readFileSync } from 'node:fs';

const manifests = [
  '../package.json',
  '../packages/cli/package.json',
  '../plugins/paseo-agent-productivity/package.json',
];
const versions = manifests.map((path) => {
  const manifest = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as {
    version: string;
  };
  return manifest.version;
});
const [version] = versions;
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
if (!version || !stable.test(version)) {
  throw new Error('Release builds require a stable X.Y.Z package version.');
}
if (versions.some((candidate) => candidate !== version)) {
  throw new Error('The app, CLI, and Paseo package versions must match.');
}

const previous = process.argv[2];
if (previous !== undefined) {
  if (!stable.test(previous)) throw new Error('The previous app version must be stable X.Y.Z.');
  if (version === previous) process.exit(0);

  const previousParts = previous.split('.');
  for (const [index, part] of version.split('.').entries()) {
    const last = previousParts[index]!;
    if (part === last) continue;
    if (BigInt(part) < BigInt(last)) {
      throw new Error(`Package version ${version} must be newer than ${previous}.`);
    }
    break;
  }

  const notesPath = `docs/releases/v${version}.md`;
  const notes = new URL(`../${notesPath}`, import.meta.url);
  const heading = `# What's new in v${version}`;
  if (!existsSync(notes)) {
    throw new Error(`Create ${notesPath} before releasing v${version}.`);
  }
  const [firstLine, ...body] = readFileSync(notes, 'utf8').trim().split(/\r?\n/);
  if (firstLine !== heading || !body.some((line) => line.trim() !== '')) {
    throw new Error(`${notesPath} needs the heading "${heading}" and release notes below it.`);
  }
}
console.log(version);
