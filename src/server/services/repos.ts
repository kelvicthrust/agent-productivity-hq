import type {
  AddRepoRequest,
  GithubRepoAccount,
  Repo,
  RepoDiscoveryResponse,
} from '../../shared/contracts/repos.ts';
import { ApiError } from '../../shared/contracts/errors.ts';
import { lookbackStart, todayIn, utcBounds } from '../../shared/domain/periods.ts';
import { NO_CREDENTIAL_MESSAGE } from '../collectors/github/auth.ts';
import type { NoCredential } from '../collectors/github/client.ts';
import type { CredentialResult, GithubAuth, NetFetch } from '../collectors/github/ports.ts';
import { parseRepoInput } from '../../shared/domain/repoInput.ts';
import {
  APP_INSTALL_URL,
  checkRepo,
  inaccessibleMessage,
  type RepoCheck,
} from '../collectors/github/repoCheck.ts';
import { discoverRepoPage } from '../collectors/github/repoDiscovery.ts';
import { formatWaitUntil } from '../collectors/github/sync.ts';
import { inTransaction, type Db } from '../db/open.ts';
import {
  getRepo,
  getRepoByNodeId,
  getRepoBySlug,
  listRepoRows,
  recordRepoIdentity,
  setRepoAccess,
  stopRepo,
  trackRepo,
} from '../db/queries/repos.ts';
import { GITHUB_APP_GUIDE_URL } from './accounts-github.ts';

// Tracked repositories (data-and-sources › Adding a repo and Stop tracking; P-14 … P-18). The canonical id is the lowercased
// `full_name` GitHub answers with, and the node id is kept, so a repo added again (or under a new name) finds its row.
//
//   add      parse → already active? 409 → ask GitHub whether this sign-in can read it → track (new, or a stopped one comes
//            back with every stored PR and a new first pass) → 201. A repo that cannot be read is an error and NOTHING is
//            stored, so the form keeps the input (P-16).
//   stop     the row stays (history within retention is kept), the sync skips it, the active views drop it. Idempotent.
//   recheck  "Check again": asks GitHub once more and stores what it says; a repo that has come back is read on the next run.

export interface RepoWriteDeps {
  db: Db;
  now: () => number;
  /** The report timezone. */
  timezone: string;
  /** The only way out of this process. */
  net: NetFetch;
  /** `accounts.auth` of the account service. */
  auth: GithubAuth;
  /**
   * Starts a GitHub refresh after access or attribution changes. Best effort; a throw is swallowed.
   */
  requestSync?: (() => void) | undefined;
}

type ReadDeps = { db: Db; nowMs: number; timezone: string };

/** One repo as the API shows it, with the merged PRs stored inside the lookback. */
function toRepo(row: ReturnType<typeof listRepoRows>[number]): Repo {
  return {
    id: row.id,
    displayName: row.displayName,
    githubNodeId: row.githubNodeId,
    trackingState: row.trackingState,
    accessState: row.accessState,
    accessError: row.accessError,
    mergedPrsLast12Months: row.mergedSince,
    backfillComplete: row.backfillComplete,
    lastSyncSuccessAt:
      row.lastSyncSuccessAt === null ? null : new Date(row.lastSyncSuccessAt).toISOString(),
    stoppedAt: row.stoppedAt === null ? null : new Date(row.stoppedAt).toISOString(),
  };
}

const sinceLookback = ({ nowMs, timezone }: Pick<ReadDeps, 'nowMs' | 'timezone'>): number =>
  utcBounds(lookbackStart(todayIn(nowMs, timezone)), timezone).start;

/**
 * The repos this machine knows, split into those being tracked and those stopped. An inaccessible repo is still active: it
 * stays in the list with `accessState` saying so. `mergedPrsLast12Months` counts stored merged PRs inside the lookback.
 */
export function listRepos(
  db: Db,
  options: { nowMs: number; timezone: string },
): { active: Repo[]; stopped: Repo[] } {
  const rows = listRepoRows(db, sinceLookback(options));
  return {
    active: rows.filter((r) => r.trackingState === 'active').map(toRepo),
    stopped: rows.filter((r) => r.trackingState === 'stopped').map(toRepo),
  };
}

/** One repo by canonical id, as the API shows it. */
function repoById(db: Db, id: string, options: { nowMs: number; timezone: string }): Repo {
  const row = listRepoRows(db, sinceLookback(options)).find((candidate) => candidate.id === id);
  if (!row) throw new ApiError('not_found', 'That repository isn’t in your list.');
  return toRepo(row);
}

// ---- what GitHub's answer means to the caller ----

/** Why there is no sign-in to check with, as the error the form shows. */
function noCredentialError(failure: NoCredential): ApiError {
  switch (failure.reason) {
    case 'needs_app':
      return new ApiError('github_app_required', failure.message, {
        details: { guideUrl: GITHUB_APP_GUIDE_URL },
      });
    case 'unreachable':
    case 'rate_limited':
      return new ApiError('upstream_unavailable', failure.message);
    case 'not_connected':
    case 'needs_connect':
      return new ApiError(
        'github_not_connected',
        'Connect GitHub first, so the dashboard can check access to this repository.',
        { details: { reason: failure.reason } },
      );
    case 'reconnect':
    case 'keychain_refused':
      return new ApiError('github_not_connected', failure.message, {
        details: { reason: failure.reason },
      });
  }
}

/** A check that got no answer about the repository: the error to throw. `ok` and `inaccessible` are answers. */
function unansweredError(
  check: Exclude<RepoCheck, { kind: 'ok' | 'inaccessible' }>,
  deps: RepoWriteDeps,
): ApiError {
  switch (check.kind) {
    case 'no_credential':
      if (check.failure.reason === 'rate_limited' && check.failure.until !== undefined) {
        return unansweredError({ kind: 'rate_limited', until: check.failure.until }, deps);
      }
      return noCredentialError(check.failure);
    case 'rate_limited':
      return new ApiError(
        'upstream_unavailable',
        `GitHub is limiting requests until ${formatWaitUntil(check.until, deps.now(), deps.timezone)}. Try again then.`,
      );
    case 'unreachable':
      return new ApiError('upstream_unavailable', NO_CREDENTIAL_MESSAGE.unreachable);
  }
}

/** A page or row selected under one account must never be queried with another account's token, even after a 401. */
function authForAccount(auth: GithubAuth, expected: GithubRepoAccount): GithubAuth {
  const verify = (result: CredentialResult): CredentialResult => {
    if (
      result.ok &&
      (result.credential.via !== expected.via ||
        result.credential.login.toLowerCase() !== expected.login.toLowerCase())
    ) {
      throw new ApiError(
        'github_account_changed',
        'Your GitHub connection changed. Choose a repository from the current account.',
      );
    }
    return result;
  };
  return {
    credential: async () => verify(await auth.credential()),
    refreshAfter401: async (used) => verify(await auth.refreshAfter401(used)),
  };
}

export async function discoverRepos(
  deps: RepoWriteDeps,
  account: GithubRepoAccount,
  page: number,
  signal: AbortSignal,
): Promise<RepoDiscoveryResponse> {
  const result = await discoverRepoPage(
    deps.net,
    authForAccount(deps.auth, account),
    deps.now,
    page,
    signal,
  );
  if (result.kind !== 'ok') throw unansweredError(result, deps);

  return {
    repositories: result.repositories.map((repo) => {
      const slug = repo.displayName.toLowerCase();
      const bySlug = getRepoBySlug(deps.db, slug);
      const tracked =
        getRepoByNodeId(deps.db, repo.nodeId) ??
        (bySlug?.nodeId === null && bySlug.slug === slug ? bySlug : null);
      return {
        ...repo,
        trackingState: tracked?.trackingState ?? 'untracked',
        trackedRepoId: tracked?.id ?? null,
      };
    }),
    nextPage: result.nextPage,
  };
}

const requestSync = (deps: RepoWriteDeps): void => {
  try {
    deps.requestSync?.();
  } catch {
    // Starting the refresh is a courtesy: the repo is tracked either way and the next run reads it.
  }
};

// ---- add ----

export async function addRepo(
  deps: RepoWriteDeps,
  input: string,
  { githubAccount, repositoryNodeId }: Omit<AddRepoRequest, 'input'> = {},
): Promise<{ repo: Repo; reactivated: boolean }> {
  const parsed = parseRepoInput(input);
  if (!parsed.ok) {
    throw new ApiError('invalid_input', parsed.message, {
      details: { fields: { input: parsed.message } },
    });
  }
  const typedId = `${parsed.owner}/${parsed.name}`.toLowerCase();
  const read = { nowMs: deps.now(), timezone: deps.timezone };

  // Already tracked under this name: no need to ask GitHub, and it works offline (P-15).
  const known = getRepoBySlug(deps.db, typedId);
  if (
    !githubAccount &&
    !repositoryNodeId &&
    known?.trackingState === 'active' &&
    known.slug === typedId
  ) {
    throw new ApiError('already_tracked', `${known.displayName} is already tracked.`, {
      details: { repo: known.id },
    });
  }

  const auth = githubAccount ? authForAccount(deps.auth, githubAccount) : deps.auth;
  const check = await checkRepo(deps.net, auth, parsed.owner, parsed.name, deps.now);
  if (check.kind === 'inaccessible') {
    throw new ApiError('repo_inaccessible', check.message, {
      details: {
        reason: check.reason,
        repo: typedId,
        ...(check.reason === 'app_not_installed'
          ? { owner: parsed.owner, installUrl: APP_INSTALL_URL }
          : {}),
      },
    });
  }
  if (check.kind !== 'ok') throw unansweredError(check, deps);
  if (repositoryNodeId && check.nodeId !== repositoryNodeId) {
    throw new ApiError(
      'repo_inaccessible',
      'GitHub returned a different repository for that name. Check its current name on GitHub.',
      {
        details: { repo: typedId, reason: 'identity_conflict' },
      },
    );
  }

  const tracked = trackRepo(deps.db, {
    id: check.id,
    nodeId: check.nodeId,
    displayName: check.displayName,
    now: deps.now(),
  });
  if (
    tracked.attributionChanged ||
    tracked.outcome === 'added' ||
    tracked.outcome === 'reactivated'
  ) {
    requestSync(deps);
  }
  if (tracked.outcome === 'identity_conflict') {
    throw new ApiError(
      'repo_inaccessible',
      inaccessibleMessage('identity_conflict', parsed.owner, parsed.name),
      {
        details: { repo: typedId },
      },
    );
  }
  if (tracked.outcome === 'already_tracked') {
    // Found by node id: the same repository under another name (a rename), or a spelling the first lookup missed.
    throw new ApiError('already_tracked', `${tracked.repo.displayName} is already tracked.`, {
      details: { repo: tracked.repo.id },
    });
  }
  return {
    repo: repoById(deps.db, tracked.repo.id, read),
    reactivated: tracked.outcome === 'reactivated',
  };
}

// ---- stop ----

/** Stops tracking `owner/name`. Idempotent for a repo that is already stopped; a repo this machine never saw is not found. */
export function stopTracking(
  deps: Pick<RepoWriteDeps, 'db' | 'now'>,
  owner: string,
  name: string,
): void {
  const result = stopRepo(deps.db, `${owner}/${name}`.toLowerCase(), deps.now());
  if (result === 'not_found') {
    throw new ApiError('not_found', 'That repository isn’t in your list.');
  }
}

// ---- recheck ----

/** "Check again": the repo with what GitHub says now. Whether it is readable or not, the answer is the repo (200), not an error. */
export async function recheckRepo(deps: RepoWriteDeps, owner: string, name: string): Promise<Repo> {
  const before = getRepoBySlug(deps.db, `${owner}/${name}`.toLowerCase());
  if (!before) throw new ApiError('not_found', 'That repository isn’t in your list.');
  const read = { nowMs: deps.now(), timezone: deps.timezone };

  const [currentOwner = '', currentName = ''] = before.slug.split('/');
  const check = await checkRepo(deps.net, deps.auth, currentOwner, currentName, deps.now);
  if (check.kind === 'inaccessible') {
    setRepoAccess(deps.db, before.id, { state: 'inaccessible', error: check.message });
  } else if (check.kind === 'ok') {
    const needsRefresh = inTransaction(deps.db, () => {
      const current = getRepo(deps.db, before.id);
      if (!current) return false;
      const { matches, attributionChanged } = recordRepoIdentity(
        deps.db,
        current,
        check,
        deps.now(),
      );
      setRepoAccess(
        deps.db,
        before.id,
        matches
          ? { state: 'ok' }
          : {
              state: 'inaccessible',
              error: inaccessibleMessage('identity_conflict', currentOwner, currentName),
            },
      );
      return (
        attributionChanged ||
        (matches && current.trackingState === 'active' && current.accessState !== 'ok')
      );
    });
    if (needsRefresh) requestSync(deps);
  } else {
    throw unansweredError(check, deps);
  }
  return repoById(deps.db, before.id, read);
}
