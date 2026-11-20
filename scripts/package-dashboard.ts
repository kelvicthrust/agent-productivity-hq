import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  nunitoNoticeFile,
  packageNotices,
  shantellNoticeFile,
  thirdPartyNoticesFile,
} from './third-party-notices.ts';

const root = resolve(import.meta.dirname, '..');
const nodeModules = join(root, 'node_modules');

const serverDependencies = [
  '@getpaseo/client',
  '@hono/node-server',
  '@napi-rs/keyring',
  'hono',
  'zod',
];
const keychainBinding = '@napi-rs/keyring-darwin-arm64';

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  description?: string;
  license?: string;
  repository?: { type: string; url: string };
  publishConfig?: { access: string };
  bin?: Record<string, string>;
  engines?: Record<string, string>;
  files?: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

function readManifest(directory: string): Manifest {
  return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as Manifest;
}

function dependencyDirectory(name: string, importer: string) {
  const locations = createRequire(join(importer, 'package.json')).resolve.paths(name) ?? [];
  const path = locations
    .filter((location) => location === nodeModules || location.startsWith(nodeModules + sep))
    .map((location) => join(location, name))
    .find((candidate) => existsSync(join(candidate, 'package.json')));
  if (!path) return;
  const directory = realpathSync(path);
  if (!directory.startsWith(nodeModules + sep)) {
    throw new Error(`Cannot bundle ${name} outside the project's node_modules.`);
  }
  return directory;
}

// Read the already-installed, lockfile-pinned pnpm graph and materialize ordinary files for npm pack.
// The server graph uses one version per package. If that changes, fail rather than replacing a dependency.
function stageDependencies(destination: string, kind: 'cli' | 'paseo'): Record<string, string> {
  const copied = new Map<string, string>();

  function copy(name: string, importer: string, optional = false): string | undefined {
    const directory = dependencyDirectory(name, importer);
    if (!directory && optional) return;
    if (!directory) throw new Error(`Missing ${name} from ${importer}. Run pnpm install first.`);

    const manifest = readManifest(directory);
    const existing = copied.get(name);
    if (existing && existing !== directory)
      throw new Error(`Conflicting installed copies of ${name}`);
    if (existing) return manifest.version;

    copied.set(name, directory);
    cpSync(directory, join(destination, 'node_modules', name), { recursive: true });
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      copy(dependency, directory);
    }
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
      copy(dependency, directory, dependency !== keychainBinding);
    }
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      copy(peer, directory, manifest.peerDependenciesMeta?.[peer]?.optional === true);
    }
    return manifest.version;
  }

  const locked = readManifest(root).dependencies;
  const direct: Record<string, string> = {};
  for (const name of serverDependencies) {
    const version = copy(name, root);
    if (!version || version !== locked?.[name]) {
      throw new Error(`Staged ${name} does not match package.json. Run pnpm install first.`);
    }
    direct[name] = version;
  }
  const bundled = [...copied.keys()].map((name) => join(destination, 'node_modules', name));
  writeFileSync(
    join(destination, thirdPartyNoticesFile),
    [
      kind === 'paseo'
        ? 'Third-party notices for the Agent HQ Paseo plugin'
        : 'Third-party notices for Agent Productivity HQ',
      `Dashboard libraries: runtime/app/dist/client/${thirdPartyNoticesFile}`,
      `Nunito license: runtime/app/dist/client/${nunitoNoticeFile}`,
      `Shantell Sans license: runtime/app/dist/client/${shantellNoticeFile}`,
      '',
      packageNotices(bundled),
      '',
    ].join('\n'),
  );
  return direct;
}

export function packDashboard(kind: 'cli' | 'paseo'): string {
  const source = join(root, kind === 'paseo' ? 'plugins/paseo-agent-productivity' : 'packages/cli');
  const output = join(root, 'dist', kind);
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error(
      'Build the dashboard package on macOS ARM64 to include the matching Keychain binding.',
    );
  }

  const scratch = mkdtempSync(join(tmpdir(), 'agent-productivity-pack-'));
  try {
    const stage = join(scratch, 'package');
    const app = join(stage, 'runtime/app');
    execFileSync('pnpm', ['build', '--outDir', join(app, 'dist/client'), '--sourcemap', 'false'], {
      cwd: root,
      stdio: 'inherit',
    });
    execFileSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.paseo.json', '--outDir', app], {
      cwd: root,
      stdio: 'inherit',
    });
    for (const asset of [
      'src/server/db/migrations',
      'src/server/integrations/claudeCapture/assets/claude-statusline.mjs',
      'src/server/integrations/claudeHooks/assets/claude-hook.mjs',
    ]) {
      cpSync(join(root, asset), join(app, asset), { recursive: true });
    }

    const {
      name,
      version,
      private: isPrivate,
      description,
      license,
      repository,
      publishConfig,
      files,
      bin,
      engines,
    } = readManifest(source);
    if (!files) throw new Error('The dashboard package requires a files allowlist.');
    const dependencies = stageDependencies(stage, kind);
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({ name: 'agent-productivity', version, type: 'module' }),
    );
    for (const file of files) cpSync(join(source, file), join(stage, file), { recursive: true });
    copyFileSync(join(root, 'LICENSE'), join(stage, 'LICENSE'));
    writeFileSync(
      join(stage, 'package.json'),
      JSON.stringify({
        name,
        version,
        private: isPrivate,
        description,
        license,
        repository,
        publishConfig,
        type: 'module',
        os: ['darwin'],
        cpu: ['arm64'],
        files: [...files, 'runtime', 'LICENSE', thirdPartyNoticesFile],
        dependencies,
        bundleDependencies: true,
        ...(kind === 'cli' ? { bin, engines } : {}),
      }),
    );
    mkdirSync(output, { recursive: true });
    const filename = execFileSync(
      'npm',
      ['pack', '--ignore-scripts', '--loglevel=error', '--pack-destination', output],
      { cwd: stage, encoding: 'utf8' },
    ).trim();
    console.log(filename);
    return join(output, filename);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
