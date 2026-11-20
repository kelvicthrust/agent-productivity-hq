import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, parse, relative, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { clearTimeout, setTimeout } from 'node:timers';
import { promisify } from 'node:util';
import { LaunchError, runtimeInstallFailed, runtimeRequired } from './errors.ts';

const execute = promisify(execFile);
const nodeVersion = '26.13.1';
const nodeDistribution = `node-v${nodeVersion}-darwin-arm64`;
const nodeArchive = `${nodeDistribution}.tar.xz`;
const nodeUrl = `https://nodejs.org/dist/v${nodeVersion}/${nodeArchive}`;
// Published at https://nodejs.org/en/blog/release/v26.13.1/
const nodeSha256 = 'af6202f5370a3a5209e85dc543758dfd9f44c8726626a236730cd603a67a8559';
const maxDownloadBytes = 48 * 1024 * 1024;

export function isSupportedNodeVersion(version: string): boolean {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match || match[0] !== version) return false;
  const major = Number(match[1]);
  // SQLite transaction state was backported to 22.16 but never shipped on 23.x.
  return major >= 24 || (major === 22 && Number(match[2]) >= 16);
}

export function nodeEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return env;
}

async function nodeVersionAt(
  path: string,
  signal: AbortSignal,
  cwd?: string,
): Promise<string | null> {
  try {
    const { stdout } = await execute(
      path,
      [
        '-p',
        "process.platform + ' ' + process.arch + ' ' + (process.versions.electron ? 'electron' : process.versions.node)",
      ],
      { cwd, env: nodeEnvironment(), signal, timeout: 1_500, maxBuffer: 1024 },
    );
    const match = /^darwin arm64 ([\d.]+)$/.exec(stdout.trimEnd());
    return match && isSupportedNodeVersion(match[1]!) ? match[1]! : null;
  } catch {
    if (signal.aborted) throw runtimeInstallFailed();
    return null;
  }
}

interface NodeHostPaths {
  home: string;
  path: string;
  nvmDirectory: string | undefined;
  execPath: string;
  systemNodes: readonly string[];
}

function nodeHostPaths(): NodeHostPaths {
  return {
    home: homedir(),
    path: process.env.PATH ?? '',
    nvmDirectory: process.env.NVM_DIR,
    execPath: basename(process.execPath) === 'node' ? process.execPath : '',
    systemNodes: [
      '/opt/homebrew/opt/node@26/bin/node',
      '/opt/homebrew/opt/node@24/bin/node',
      '/opt/homebrew/opt/node@22/bin/node',
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
    ],
  };
}

async function nvmNodes(nvmDirectory: string): Promise<string[]> {
  const versions = join(nvmDirectory, 'versions', 'node');
  const entries = await readdir(versions).catch(() => []);
  return entries
    .filter((version) => version.startsWith('v') && isSupportedNodeVersion(version.slice(1)))
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
    .map((version) => join(versions, version, 'bin', 'node'));
}

function within(directory: string, path: string): boolean {
  const nested = relative(directory, path);
  return !isAbsolute(nested) && nested !== '..' && !nested.startsWith(`..${sep}`);
}

export async function findHostNode(
  directory: string,
  signal: AbortSignal,
  host = nodeHostPaths(),
): Promise<string | null> {
  const cwd = await realpath(process.cwd());
  const plugin = await realpath(directory);
  const home = await realpath(host.home).catch(() => host.home);
  const nvmDirectory =
    host.nvmDirectory && isAbsolute(host.nvmDirectory)
      ? host.nvmDirectory
      : join(host.home, '.nvm');
  const installed = new Set([
    host.execPath,
    ...host.systemNodes,
    ...(await nvmNodes(nvmDirectory)),
  ]);
  const candidates = [
    host.execPath,
    ...host.path
      .split(delimiter)
      .filter(isAbsolute)
      .map((base) => join(base, 'node')),
    ...installed,
  ];
  const inWorkingDirectory = (path: string, knownInstall: boolean) =>
    dirname(path) === cwd ||
    (cwd !== parse(cwd).root && (cwd !== home || !knownInstall) && within(cwd, path));
  const volta = join(home, '.volta');
  const mise = join(home, '.local', 'share', 'mise');
  const checked = new Set<string>();
  for (const candidate of candidates) {
    if (signal.aborted) throw runtimeInstallFailed();
    if (!isAbsolute(candidate)) continue;
    const manager =
      candidate === join(volta, 'bin', 'node')
        ? volta
        : candidate === join(mise, 'shims', 'node') ||
            /^installs\/node\/[^/]+\/bin\/node$/.test(relative(mise, candidate))
          ? mise
          : null;
    const knownInstall = installed.has(candidate) || manager !== null;
    if (inWorkingDirectory(candidate, knownInstall) || within(plugin, candidate)) continue;
    const paths = await Promise.all([realpath(candidate), realpath(dirname(candidate))]).catch(
      () => null,
    );
    if (!paths) continue;
    const [path, parent] = paths;
    const lexical = join(parent, basename(candidate));
    const knownTarget = installed.has(path) || (manager !== null && within(manager, path));
    if (
      inWorkingDirectory(path, knownTarget) ||
      inWorkingDirectory(lexical, knownInstall) ||
      within(plugin, path) ||
      within(plugin, lexical)
    )
      continue;
    if (checked.has(lexical)) continue;
    checked.add(lexical);
    // Manager shims can select the tool from their invoked basename and the working directory.
    if (await nodeVersionAt(lexical, signal, plugin)) return lexical;
  }
  return null;
}

async function privateRuntimeRoot(home: string, create = false): Promise<string | null> {
  if (!isAbsolute(home)) return null;
  let path = await realpath(home).catch(() => null);
  if (path === null) return null;
  for (const name of ['Library', 'Application Support', 'agent-productivity', 'paseo-runtime']) {
    path = join(path, name);
    if (create) {
      await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
    }
    const stat = await lstat(path).catch(() => null);
    if (!stat?.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o022) return null;
  }
  return path;
}

async function privateDirectory(path: string): Promise<boolean> {
  const stat = await lstat(path).catch(() => null);
  return Boolean(stat?.isDirectory() && stat.uid === process.getuid?.() && !(stat.mode & 0o077));
}

async function privateFile(path: string): Promise<boolean> {
  const stat = await lstat(path).catch(() => null);
  return Boolean(stat?.isFile() && stat.uid === process.getuid?.() && !(stat.mode & 0o077));
}

async function cachedNode(root: string, signal: AbortSignal): Promise<string | null> {
  if (!(await privateDirectory(root))) return null;
  const installed = join(root, nodeDistribution);
  const node = join(installed, 'bin', 'node');
  const receipt = join(installed, 'archive.sha256');
  if (
    !(await privateDirectory(installed)) ||
    !(await privateDirectory(dirname(node))) ||
    !(await privateFile(node)) ||
    !(await privateFile(join(installed, 'LICENSE'))) ||
    !(await privateFile(receipt)) ||
    (await readFile(receipt, 'utf8').catch(() => null)) !== `${nodeSha256}\n`
  ) {
    return null;
  }
  return (await nodeVersionAt(node, signal)) === nodeVersion ? node : null;
}

async function downloadArchive(archive: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(nodeUrl, { redirect: 'error', signal, credentials: 'omit' });
  if (!response.ok || !response.body) throw runtimeInstallFailed();
  const hash = createHash('sha256');
  let bytes = 0;
  const verify = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxDownloadBytes) {
        callback(runtimeInstallFailed());
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body),
    verify,
    createWriteStream(archive, { mode: 0o600, flags: 'wx' }),
    { signal },
  );
  if (hash.digest('hex') !== nodeSha256) {
    throw runtimeInstallFailed(
      'The Node.js download failed its integrity check. Retry the install.',
    );
  }
}

async function installPrivateNode(root: string, signal: AbortSignal): Promise<string> {
  const installed = join(root, nodeDistribution);
  if (await lstat(installed).catch(() => null)) {
    const cached = await cachedNode(root, signal);
    if (cached) return cached;
    throw runtimeInstallFailed(
      `The private runtime folder is incomplete. On the Paseo host, move ${nodeDistribution} out of ~/Library/Application Support/agent-productivity/paseo-runtime, then click Install runtime again.`,
    );
  }

  const scratch = await mkdtemp(join(root, '.install-'));
  const archive = join(scratch, nodeArchive);
  const stage = join(scratch, nodeDistribution);
  const node = join(stage, 'bin', 'node');
  const license = join(stage, 'LICENSE');
  try {
    await downloadArchive(archive, signal);
    await mkdir(stage, { mode: 0o700 });
    await execute(
      '/usr/bin/tar',
      [
        '-xJf',
        archive,
        '-C',
        stage,
        '--strip-components=1',
        `${nodeDistribution}/bin/node`,
        `${nodeDistribution}/LICENSE`,
      ],
      { env: { PATH: '/usr/bin:/bin' }, signal, timeout: 15_000, maxBuffer: 4096 },
    );
    await Promise.all([chmod(dirname(node), 0o700), chmod(node, 0o700), chmod(license, 0o600)]);
    if ((await nodeVersionAt(node, signal)) !== nodeVersion) throw runtimeInstallFailed();
    await writeFile(join(stage, 'archive.sha256'), `${nodeSha256}\n`, { mode: 0o600, flag: 'wx' });
    if (signal.aborted) throw runtimeInstallFailed();
    try {
      await rename(stage, installed);
    } catch (error) {
      const alreadyInstalled = await cachedNode(root, signal);
      if (alreadyInstalled) return alreadyInstalled;
      throw error;
    }
    return join(installed, 'bin', 'node');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function resolveNodeExecutable(
  directory: string,
  signal: AbortSignal,
  install: boolean,
  host = nodeHostPaths(),
): Promise<string> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new LaunchError('dashboard-unavailable', 'Install this package on an Apple Silicon Mac.');
  }
  const existing = await findHostNode(directory, signal, host);
  if (existing) return existing;
  const root = await privateRuntimeRoot(host.home);
  const cached = root && (await cachedNode(root, signal));
  if (cached) return cached;
  if (!install) throw runtimeRequired();
  const download = new AbortController();
  const abort = () => download.abort();
  const timeout = setTimeout(abort, 45_000);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    const installRoot = await privateRuntimeRoot(host.home, true);
    if (!(installRoot && (await privateDirectory(installRoot)))) {
      throw runtimeInstallFailed(
        'The runtime cache needs a private directory at ~/Library/Application Support/agent-productivity/paseo-runtime on the Paseo host. Check its ownership and permissions, then retry.',
      );
    }
    return await installPrivateNode(installRoot, download.signal);
  } catch (error) {
    if (error instanceof LaunchError) throw error;
    throw runtimeInstallFailed();
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}
