import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

// Repo association (data-and-sources › Repo association): a session's working directory to the GitHub repository it belongs to,
// from local git configuration only. No `git` process runs and nothing touches the network.
//
//   1. walk up from the recorded `cwd` to the nearest `.git` (a folder, or a file `gitdir: …` for a worktree or submodule)
//   2. read `[remote "origin"] url` from that repository's config
//   3. keep only `owner/name`, lowercased, for a github.com remote; the URL itself is never stored or logged (it can hold a token)
//   4. otherwise fall back to the provider's own hint (Codex `session_meta.git.repository_url`)
//   5. no remote, or a remote that is not on GitHub: unknown repo (null)
// A directory that no longer exists resolves to nothing, so the session keeps the repo stored earlier (a deleted checkout must
// not be attributed to whatever folder is above it).

export type RepoBasis = 'git_config' | 'session_meta';

export interface RepoResolution {
  repoId: string | null;
  basis: RepoBasis | null;
}

const NONE: RepoResolution = { repoId: null, basis: null };
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_WALK = 64;

const GITHUB =
  /^(?:(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?github\.com(?::\d+)?\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i;

/** `owner/name` (lowercase) for a github.com remote URL in any of its usual forms, else null. */
export function canonicalGithubRepo(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = url.trim().match(GITHUB);
  if (!match) return null;
  const [, owner, name] = match;
  if (!owner || !name || owner === '.' || owner === '..' || name === '.' || name === '..') {
    return null;
  }
  return `${owner}/${name}`.toLowerCase();
}

function readSmall(path: string): string | null {
  let fd: number | null = null;
  try {
    // O_NONBLOCK: a FIFO named `.git`, `config` or `commondir` (the working directory is arbitrary text from a transcript) would otherwise
    // stop this synchronous read until something wrote to it; it is opened without waiting and refused as not a file.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    if (!fstatSync(fd).isFile()) return null;
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES);
    const read = readSync(fd, buffer, 0, MAX_CONFIG_BYTES, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The `url` of `[remote "origin"]` in a git config's text, or null. */
export function originUrl(config: string): string | null {
  let inOrigin = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inOrigin = /^\[\s*remote\s+"origin"\s*\]/i.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const match = line.match(/^url\s*=\s*(.*)$/i);
    if (match)
      return (match[1] ?? '')
        .replace(/\s+[#;].*$/, '')
        .replace(/^"(.*)"$/, '$1')
        .trim();
  }
  return null;
}

/** Where the config of the repository whose `.git` is at `dotGit` lives, following a worktree or submodule pointer. */
function configPath(dotGit: string): string | null {
  let info;
  try {
    info = statSync(dotGit);
  } catch {
    return null;
  }
  if (info.isDirectory()) return join(dotGit, 'config');
  if (!info.isFile()) return null;
  const pointer = (readSmall(dotGit) ?? '').match(/^gitdir:\s*(.+)$/m);
  if (!pointer?.[1]) return null;
  const gitDir = isAbsolute(pointer[1].trim())
    ? pointer[1].trim()
    : resolve(dirname(dotGit), pointer[1].trim());
  // A linked worktree keeps the shared config in its "common dir"; a submodule's git dir has its own.
  const common = readSmall(join(gitDir, 'commondir'))?.trim();
  return join(common ? resolve(gitDir, common) : gitDir, 'config');
}

/**
 * A resolver for one refresh. It remembers each folder it has resolved (and each repository it has read), so a thousand sessions
 * in a hundred folders cost a hundred walks, not a thousand.
 */
export function createRepoResolver(): (
  cwd: string | null | undefined,
  hintUrl?: string | null,
) => RepoResolution {
  const byFolder = new Map<string, RepoResolution>();
  const byRepo = new Map<string, string | null>();

  function viaGit(cwd: string): RepoResolution {
    const cached = byFolder.get(cwd);
    if (cached) return cached;
    let result = NONE;
    let exists = false;
    try {
      exists = statSync(cwd).isDirectory();
    } catch {
      exists = false;
    }
    if (exists) {
      let directory = cwd;
      for (let step = 0; step < MAX_WALK; step += 1) {
        const dotGit = join(directory, '.git');
        const known = byRepo.get(dotGit);
        let repo: string | null | undefined = known;
        if (repo === undefined) {
          const path = configPath(dotGit);
          repo = path === null ? undefined : canonicalGithubRepo(originUrl(readSmall(path) ?? ''));
          if (path !== null) byRepo.set(dotGit, repo ?? null);
        }
        if (repo !== undefined) {
          result = repo ? { repoId: repo, basis: 'git_config' } : NONE;
          break;
        }
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    byFolder.set(cwd, result);
    return result;
  }

  return (cwd, hintUrl) => {
    const viaConfig = cwd && isAbsolute(cwd) ? viaGit(cwd) : NONE;
    if (viaConfig.repoId) return viaConfig;
    const hinted = canonicalGithubRepo(hintUrl);
    return hinted ? { repoId: hinted, basis: 'session_meta' } : NONE;
  };
}
