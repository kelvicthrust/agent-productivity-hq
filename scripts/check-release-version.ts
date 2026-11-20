import { readFileSync } from 'node:fs';

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
if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  throw new Error('Release builds require a stable X.Y.Z package version.');
}
if (versions.some((candidate) => candidate !== version)) {
  throw new Error('The app, CLI, and Paseo package versions must match.');
}
console.log(version);
