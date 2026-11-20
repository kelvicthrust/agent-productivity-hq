import { Button } from '@astryxdesign/core/Button';
import { useState } from 'react';
import type { GithubRepoAccount, Repo } from '../../../shared/contracts/repos';
import { RepoPicker } from '../../components/RepoPicker';
import { StatusTag, type StatusKind } from '../../components/StatusTag';
import { SOURCES_COPY, STATUS_TEXT } from '../../lib/copy';
import { useRecheckRepo, useRepos, useStopTracking } from '../../lib/repos';
import { SETUP_COPY } from './copy';
import { messageOf } from './data';
import { ACTIONS, Alert, BUTTON, ROW, StepCard } from './parts';

const COPY = SETUP_COPY.repos;
const REPOS = SOURCES_COPY.repos;

function tagFor(repo: Repo, checking: boolean): { kind: StatusKind; text: string } {
  if (checking) return { kind: 'checking', text: COPY.rechecking };
  switch (repo.accessState) {
    case 'ok':
      return { kind: 'ok', text: STATUS_TEXT.accessConfirmed };
    case 'inaccessible':
      return { kind: 'inaccessible', text: STATUS_TEXT.inaccessible };
    case 'unknown':
      return { kind: 'none', text: COPY.accessUnknown };
  }
}

function RepoRow({ repo }: { repo: Repo }) {
  const recheck = useRecheckRepo();
  const remove = useStopTracking();
  const [problem, setProblem] = useState<string | null>(null);
  const tag = tagFor(repo, recheck.isPending);
  const bad = repo.accessState === 'inaccessible';

  return (
    <li className={ROW}>
      <div className="flex min-w-0 flex-col gap-1">
        {/* A repo name has no spaces to break at: on a narrow window it wraps anywhere instead of widening the page. */}
        <b className="text-copy font-bold text-ink [overflow-wrap:anywhere]">{repo.displayName}</b>
        <span aria-live="polite">
          <StatusTag kind={tag.kind}>{tag.text}</StatusTag>
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-1 text-caption text-ink-muted">
        {bad ? (
          <span className="text-danger">{repo.accessError ?? COPY.accessUnknown}</span>
        ) : (
          <span>{REPOS.importsAfterSetup}</span>
        )}
        {problem !== null && <Alert>{problem}</Alert>}
      </div>
      <div className={ACTIONS}>
        {bad && (
          <Button
            label={REPOS.recheck}
            size="sm"
            variant="secondary"
            aria-busy={recheck.isPending || undefined}
            aria-disabled={recheck.isPending || undefined}
            className={BUTTON}
            onClick={() => {
              if (recheck.isPending) return;
              setProblem(null);
              recheck.mutate(repo.id, {
                onError: (error) => setProblem(messageOf(error, SETUP_COPY.fallback)),
              });
            }}
          />
        )}
        <Button
          label={remove.isPending ? COPY.removing : REPOS.remove}
          size="sm"
          variant="ghost"
          aria-label={`${REPOS.remove} ${repo.displayName}`}
          aria-busy={remove.isPending || undefined}
          aria-disabled={remove.isPending || undefined}
          className={BUTTON}
          onClick={() => {
            if (remove.isPending) return;
            setProblem(null);
            remove.mutate(repo.id, {
              onError: (error) => setProblem(messageOf(error, SETUP_COPY.fallback)),
            });
          }}
        />
      </div>
    </li>
  );
}

export function ReposStep({
  githubAccount,
  githubChecking,
  onNeedsGithub,
}: {
  githubAccount: GithubRepoAccount | null;
  githubChecking: boolean;
  onNeedsGithub: () => void;
}) {
  const repos = useRepos();
  return (
    <StepCard id="setup-step-repos" title={COPY.title} scope={COPY.scope}>
      {githubAccount ? (
        <RepoPicker
          key={`${githubAccount.via}:${githubAccount.login.toLowerCase()}`}
          account={githubAccount}
          onNeedsGithub={onNeedsGithub}
        />
      ) : (
        <p role="status" className="text-copy text-ink-muted">
          {githubChecking ? COPY.githubLoading : COPY.githubRequired}
        </p>
      )}
      {repos.isError ? (
        <p role="alert" className="text-copy text-danger">
          {COPY.loadFailed}
        </p>
      ) : repos.data === undefined ? (
        <p role="status" className="text-copy text-ink-muted">
          {COPY.loading}
        </p>
      ) : repos.data.length === 0 ? (
        <p className="text-copy text-ink-muted">{REPOS.none}</p>
      ) : (
        <ul className="flex flex-col">
          {repos.data.map((repo) => (
            <RepoRow key={repo.id} repo={repo} />
          ))}
        </ul>
      )}
      {githubAccount && <p className="text-caption text-ink-muted">{COPY.skipNote}</p>}
    </StepCard>
  );
}
