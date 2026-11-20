import type { GithubBoot } from '../../../src/server/boot.ts';
import type { Db } from '../../../src/server/db/open.ts';
import { getMeta } from '../../../src/server/db/queries/meta.ts';
import { listActiveRepos } from '../../../src/server/db/queries/repos.ts';
import {
  createFakeGithub,
  createMemoryKeyring,
  type FakeGithub,
  type MemoryKeyring,
} from './scripted-github.ts';

// The scripted GitHub for a SEEDED database: the preview command and the browser specs both use it (nothing touches the network,
// this Mac's Keychain or `gh`). It knows who the seed says you are (`app_meta.github_login`), every repo the seed tracks and can
// still read (so a sync of the seeded repos finds them and changes nothing), and a few repos that are NOT tracked, so "add a
// repository" has something to find. A name that is in neither list answers 404, which is how "not accessible" is tried.

export const UNTRACKED_REPO = 'kelvin/dotfiles';
const DAY_MS = 86_400_000;

export interface ScriptedGithub {
  github: FakeGithub;
  keyring: MemoryKeyring;
  /** What boot (and `createApp`'s account service) is given. */
  boot: GithubBoot;
}

export function createScriptedGithub(
  db: Db,
  options: { now: () => number; signedIn?: boolean },
): ScriptedGithub {
  const now = options.now;
  const github = createFakeGithub({ login: getMeta(db, 'github_login') || 'kelvin', now });
  for (const repo of listActiveRepos(db)) {
    if (repo.accessState === 'inaccessible') continue;
    github.addRepo({ fullName: repo.displayName, nodeId: repo.nodeId ?? `R_${repo.id}` });
  }
  const merged = (daysAgo: number) => new Date(now() - daysAgo * DAY_MS).toISOString();
  github.addRepo({ fullName: UNTRACKED_REPO, nodeId: 'R_kwDOdotfiles' }, [
    {
      nodeId: 'PR_dotfiles_1',
      number: 1,
      title: 'Add the init command',
      mergedAt: merged(2),
      author: github.login,
      mergedBy: github.login,
    },
    {
      nodeId: 'PR_dotfiles_2',
      number: 2,
      title: 'Read notes from a folder',
      mergedAt: merged(9),
      author: github.login,
      mergedBy: 'review-bot',
    },
    {
      nodeId: 'PR_dotfiles_3',
      number: 3,
      title: 'Fix the date parser',
      mergedAt: merged(30),
      author: 'a-colleague',
      mergedBy: github.login,
    },
  ]);
  if (options.signedIn === false) github.signOutGh();
  const keyring = createMemoryKeyring();
  return { github, keyring, boot: { net: github.net, keyring, gh: github.gh } };
}
