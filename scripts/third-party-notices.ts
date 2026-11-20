import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const thirdPartyNoticesFile = 'THIRD-PARTY-NOTICES.txt';
export const nunitoNoticeFile = 'licenses/Nunito-OFL.txt';
export const nunitoLicenseSource = new URL('../src/client/theme/fonts/OFL.txt', import.meta.url);
export const playpenNoticeFile = 'licenses/Playpen-Sans-OFL.txt';
export const playpenLicenseSource = new URL(
  '../src/client/theme/fonts/OFL-PlaypenSans.txt',
  import.meta.url,
);

// These exact releases omit their project license from the npm package, or (Vite)
// use a package notice that includes dependencies of the build tool itself.
const upstreamLicenses: Record<
  string,
  { identifier: string; file: string; napi?: boolean; preferUpstream?: boolean }
> = {
  // https://github.com/meta/astryx/blob/v0.7.9/LICENSE
  '@astryxdesign/core@0.7.9': { identifier: 'MIT', file: 'astryx-0.7.9.txt' },
  // https://github.com/meta/stylex/blob/0.19.1/LICENSE
  '@stylexjs/stylex@0.19.1': { identifier: 'MIT', file: 'stylex-0.19.1.txt' },
  // https://github.com/vitejs/vite/blob/v8.3.6/LICENSE
  'vite@8.3.6': { identifier: 'MIT', file: 'vite-8.3.6.txt', preferUpstream: true },
  // https://github.com/getpaseo/paseo/blob/v0.15.3/LICENSE
  '@getpaseo/client@0.15.3': { identifier: 'Apache-2.0', file: 'paseo-0.15.3.txt' },
  '@getpaseo/protocol@0.15.3': { identifier: 'Apache-2.0', file: 'paseo-0.15.3.txt' },
  '@getpaseo/relay@0.15.3': { identifier: 'Apache-2.0', file: 'paseo-0.15.3.txt' },
  // https://github.com/Brooooooklyn/keyring-node/blob/v2.1.2/LICENSE
  '@napi-rs/keyring-darwin-arm64@2.1.2': {
    identifier: 'MIT',
    file: 'keyring-2.1.2.txt',
    napi: true,
  },
};

const licenseFile = /^(?:licen[cs]e|copying)(?:\.(?:txt|md|markdown))?$/i;
const noticeFile = /^(?:licen[cs]e|copying|notice)(?:$|[._-])/i;

function upstreamText(file: string) {
  return readFileSync(new URL(`./licenses/${file}`, import.meta.url), 'utf8').trimEnd();
}

export function packageNotices(directories: Iterable<string>) {
  const packages = new Map<string, string>();
  for (const directory of directories) {
    const { name, version, license } = JSON.parse(
      readFileSync(join(directory, 'package.json'), 'utf8'),
    ) as { name: string; version: string; license?: string };
    const key = `${name}@${version}`;
    if (packages.has(key)) continue;

    const upstream = upstreamLicenses[key];
    const identifier = license ?? upstream?.identifier;
    const files = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && noticeFile.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const hasLicense = files.some((file) => licenseFile.test(file));
    if (!identifier || (!upstream && !hasLicense)) {
      throw new Error(`Missing third-party license for ${key}. Verify its upstream terms.`);
    }
    const texts = files
      .filter((file) => !(upstream?.preferUpstream && licenseFile.test(file)))
      .map((file) => `${file}\n\n${readFileSync(join(directory, file), 'utf8').trimEnd()}`);
    if (upstream && (upstream.preferUpstream || !hasLicense)) {
      texts.unshift(`LICENSE (upstream)\n\n${upstreamText(upstream.file)}`);
    }
    if (upstream?.napi) {
      // The binding's crate notice uses copyright placeholders for these four crates.
      // Their crates.io releases point to 8bab46e, 4694e6d and 37109f1 in napi-rs/napi-rs.
      texts.push(
        `N-API Rust crates (napi 3.14.2, napi-derive 3.6.12, napi-derive-backend 6.1.5, napi-sys 3.4.0)\n\n${upstreamText('napi-rs.txt')}`,
      );
    }
    packages.set(key, `## ${key} (${identifier})\n\n${texts.join('\n\n')}`);
  }
  return [...packages.keys()]
    .sort()
    .map((key) => packages.get(key))
    .join('\n\n');
}
