import { z } from 'zod';
import { openSession, type NoCredential } from './client.ts';
import type { GithubAuth, GithubRoute, NetFetch } from './ports.ts';
import { DEFAULT_BACKOFF_MS } from './rateLimit.ts';
import { isGithubRepoSlug } from '../../../shared/domain/repoInput.ts';

// "Can this sign-in read this repository?" (data-and-sources › Adding a repo, step 2): `GET /repos/{owner}/{name}`.
//   200            the repository: its canonical id is the lowercased `full_name`, its node id is kept so a rename resolves
//   404, 403       inaccessible. Under the GitHub App's token a 404 usually means the App is not installed on that owner (a user
//                  token sees only repos where the App is installed AND the person has access, R20), so the sentence says so
//   301 (moved)    a renamed or transferred repository: lib/net.ts does not follow the redirect, so the sentence says so
//   401            Reconnect needed (after one refresh, which the session does itself)
// Used by adding a repo and by "Check again". It writes nothing; the service stores the answer.

/** Where a person manages the installations of the Apps they own (the App's own install page needs its slug, which is not known). */
export const APP_INSTALL_URL = 'https://github.com/settings/installations';

export type Inaccessible =
  'not_found' | 'forbidden' | 'moved' | 'app_not_installed' | 'identity_conflict';

export type RepoCheck =
  | {
      kind: 'ok';
      /** Lowercased `owner/name`. */
      id: string;
      /** `full_name` as GitHub spells it. */
      displayName: string;
      nodeId: string | null;
      via: GithubRoute;
    }
  | { kind: 'inaccessible'; reason: Inaccessible; message: string; via: GithubRoute }
  | { kind: 'no_credential'; failure: NoCredential }
  /** `until` is epoch ms. */
  | { kind: 'rate_limited'; until: number }
  | { kind: 'unreachable' };

export const installMessage = (owner: string): string =>
  `Install your Agent Productivity HQ GitHub App on ${owner} and give it this repository, then check again.`;

export const notGrantedMessage = (id: string): string =>
  `GitHub didn’t grant access to ${id}. Check the name, or that your GitHub connection can read this repository, then try again.`;

export const movedMessage = (id: string): string =>
  `GitHub says ${id} has moved to a new name. Add it again using its current owner/name.`;

/** The sentence for a repository GitHub does not hand to this sign-in (used by the sync, too). */
export function inaccessibleMessage(reason: Inaccessible, owner: string, name: string): string {
  const id = `${owner}/${name}`.toLowerCase();
  if (reason === 'identity_conflict') {
    return `GitHub returned a conflicting repository identity for ${id}. Check its current name on GitHub.`;
  }
  if (reason === 'moved') return movedMessage(id);
  return reason === 'app_not_installed' ? installMessage(owner) : notGrantedMessage(id);
}

const RepoBody = z.object({
  node_id: z.string().min(1).optional(),
  full_name: z.string().refine(isGithubRepoSlug),
});

export async function checkRepo(
  net: NetFetch,
  auth: GithubAuth,
  owner: string,
  name: string,
  now: () => number,
): Promise<RepoCheck> {
  const opened = await openSession(net, auth, now);
  if (!opened.ok) return credentialStop(opened.failure, now);
  const { session } = opened;
  const reply = await session.get(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
  );
  // After the request: a 401 may have been answered with a token of the other route.
  const via = session.via;
  switch (reply.kind) {
    case 'ok': {
      const body = RepoBody.safeParse(reply.body);
      if (!body.success) return { kind: 'unreachable' };
      return {
        kind: 'ok',
        id: body.data.full_name.toLowerCase(),
        displayName: body.data.full_name,
        nodeId: body.data.node_id ?? null,
        via,
      };
    }
    case 'not_found': {
      // Under the App's token a 404 is the "not installed on this owner" case; under gh it is a name that does not exist or
      // a repository this person cannot read.
      const reason = via === 'app' ? 'app_not_installed' : 'not_found';
      return {
        kind: 'inaccessible',
        reason,
        message: inaccessibleMessage(reason, owner, name),
        via,
      };
    }
    case 'forbidden':
    case 'rejected':
      return {
        kind: 'inaccessible',
        reason: 'forbidden',
        message: inaccessibleMessage('forbidden', owner, name),
        via,
      };
    case 'moved':
      return {
        kind: 'inaccessible',
        reason: 'moved',
        message: inaccessibleMessage('moved', owner, name),
        via,
      };
    case 'rate_limited':
      return { kind: 'rate_limited', until: reply.until };
    case 'no_credential':
      return credentialStop(reply.failure, now);
    case 'unreachable':
      return { kind: 'unreachable' };
  }
}

/** No credential to check with. A rate limit on the sign-in check is the same "limited until <time>" answer as one on the repository. */
function credentialStop(failure: NoCredential, now: () => number): RepoCheck {
  return failure.reason === 'rate_limited'
    ? { kind: 'rate_limited', until: failure.until ?? now() + DEFAULT_BACKOFF_MS }
    : { kind: 'no_credential', failure };
}
