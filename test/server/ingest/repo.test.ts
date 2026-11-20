import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalGithubRepo,
  createRepoResolver,
  originUrl,
} from '../../../src/server/collectors/ingest/repo.ts';
import { tempDir } from '../helpers.ts';

// Repo association from local git config only (data-and-sources › Repo association).

const config = (url: string) =>
  `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;

function repoAt(dir: string, url: string | null) {
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git/config'), url === null ? '[core]\n' : config(url));
}

describe('canonicalGithubRepo', () => {
  it.each([
    ['git@github.com:Owner/Name.git', 'owner/name'],
    ['https://github.com/Owner/Name', 'owner/name'],
    ['https://github.com/Owner/Name.git', 'owner/name'],
    ['https://github.com/Owner/Name/', 'owner/name'],
    ['ssh://git@github.com/Owner/Name', 'owner/name'],
    ['ssh://git@github.com:22/Owner/Name.git', 'owner/name'],
    ['git://github.com/Owner/Name.git', 'owner/name'],
    ['https://SENTINEL_USER:SENTINEL_TOKEN_x@github.com/Owner/My.Repo.git', 'owner/my.repo'],
  ])('%s -> %s', (url, expected) => {
    expect(canonicalGithubRepo(url)).toBe(expected);
  });

  it.each([
    'https://gitlab.com/Owner/Name',
    'git@bitbucket.org:Owner/Name.git',
    'https://github.com/Owner',
    'https://github.com/Owner/Name/extra',
    'file:///srv/repo',
    '/local/path',
    '',
  ])('%s is not a GitHub repository', (url) => {
    expect(canonicalGithubRepo(url)).toBeNull();
  });
  it('is null for no URL', () => {
    expect(canonicalGithubRepo(null)).toBeNull();
    expect(canonicalGithubRepo(undefined)).toBeNull();
  });
});

describe('originUrl', () => {
  it('reads the origin remote and ignores other remotes and sections', () => {
    const text =
      '[remote "upstream"]\n url = git@github.com:a/b.git\n[remote "origin"]\n url = git@github.com:c/d.git # comment\n[branch "main"]\n url = x\n';
    expect(originUrl(text)).toBe('git@github.com:c/d.git');
    expect(originUrl('[core]\n')).toBeNull();
  });
});

describe('createRepoResolver', () => {
  it('finds the repo from a working directory below the git folder', () => {
    const root = tempDir();
    repoAt(join(root, 'proj'), 'git@github.com:Kelvin/Proj.git');
    mkdirSync(join(root, 'proj/src/deep'), { recursive: true });
    const resolve = createRepoResolver();
    expect(resolve(join(root, 'proj'))).toEqual({ repoId: 'kelvin/proj', basis: 'git_config' });
    expect(resolve(join(root, 'proj/src/deep'))).toEqual({
      repoId: 'kelvin/proj',
      basis: 'git_config',
    });
  });

  it('follows a worktree pointer to the shared config', () => {
    const root = tempDir();
    repoAt(join(root, 'main'), 'https://github.com/Kelvin/Main.git');
    mkdirSync(join(root, 'main/.git/worktrees/wt'), { recursive: true });
    writeFileSync(join(root, 'main/.git/worktrees/wt/commondir'), '../..\n');
    mkdirSync(join(root, 'wt'), { recursive: true });
    writeFileSync(join(root, 'wt/.git'), `gitdir: ${join(root, 'main/.git/worktrees/wt')}\n`);
    expect(createRepoResolver()(join(root, 'wt'))).toEqual({
      repoId: 'kelvin/main',
      basis: 'git_config',
    });
  });

  it('follows a relative gitdir pointer (a submodule keeps its own config)', () => {
    const root = tempDir();
    mkdirSync(join(root, 'sub'), { recursive: true });
    mkdirSync(join(root, 'sup/.git/modules/sub'), { recursive: true });
    writeFileSync(join(root, 'sup/.git/modules/sub/config'), config('git@github.com:k/sub.git'));
    mkdirSync(join(root, 'sup/sub'), { recursive: true });
    writeFileSync(join(root, 'sup/sub/.git'), 'gitdir: ../.git/modules/sub\n');
    expect(createRepoResolver()(join(root, 'sup/sub'))).toEqual({
      repoId: 'k/sub',
      basis: 'git_config',
    });
  });

  it('says unknown for a repo with no remote or a remote that is not on GitHub', () => {
    const root = tempDir();
    repoAt(join(root, 'local'), null);
    repoAt(join(root, 'lab'), 'https://gitlab.com/o/n.git');
    const resolve = createRepoResolver();
    expect(resolve(join(root, 'local'))).toEqual({ repoId: null, basis: null });
    expect(resolve(join(root, 'lab'))).toEqual({ repoId: null, basis: null });
  });

  it('uses the provider hint only when git says nothing, and marks the basis', () => {
    const root = tempDir();
    repoAt(join(root, 'local'), null);
    const resolve = createRepoResolver();
    expect(resolve(join(root, 'local'), 'https://github.com/Hint/Repo.git')).toEqual({
      repoId: 'hint/repo',
      basis: 'session_meta',
    });
    repoAt(join(root, 'real'), 'git@github.com:Real/One.git');
    expect(resolve(join(root, 'real'), 'https://github.com/Hint/Repo.git').repoId).toBe('real/one');
  });

  it('gives nothing for a directory that no longer exists, so the stored repo is kept', () => {
    const root = tempDir();
    repoAt(root, 'git@github.com:k/above.git'); // a repo above the deleted folder must not claim it
    const gone = join(root, 'deleted-checkout');
    mkdirSync(gone);
    rmSync(gone, { recursive: true });
    expect(createRepoResolver()(gone)).toEqual({ repoId: null, basis: null });
    expect(createRepoResolver()(null)).toEqual({ repoId: null, basis: null });
    expect(createRepoResolver()('relative/path')).toEqual({ repoId: null, basis: null });
  });

  it('remembers what it resolved for the run', () => {
    const root = tempDir();
    repoAt(join(root, 'p'), 'git@github.com:k/p.git');
    const resolve = createRepoResolver();
    expect(resolve(join(root, 'p')).repoId).toBe('k/p');
    writeFileSync(join(root, 'p/.git/config'), config('git@github.com:k/changed.git'));
    expect(resolve(join(root, 'p')).repoId).toBe('k/p'); // cached for this run; the next run asks again
    expect(createRepoResolver()(join(root, 'p')).repoId).toBe('k/changed');
  });
});
