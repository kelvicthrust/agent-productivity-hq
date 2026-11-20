import { Button } from '@astryxdesign/core/Button';
import { useToast } from '@astryxdesign/core/Toast';
import { useRef, useState } from 'react';
import { useSources } from '../../../components/RefreshBanner';
import { RepoPicker } from '../../../components/RepoPicker';
import { useBootstrap } from '../../../lib/bootstrap';
import { SOURCES_COPY } from '../../../lib/copy';
import { AddRepoForm } from './AddRepoForm';
import { REPO_COPY } from './copy';
import {
  githubRepoAccount,
  problemOf,
  useAddRepo,
  useRecheckRepo,
  useRepoList,
  useStopTracking,
  type Problem,
} from '../../../lib/repos';
import { focusGithubSection } from '../github/anchor';
import { RepoRow, StoppedRow } from './RepoRows';

// Tracked repositories (G6_10): add by owner/name or address, each repo's state, Check again, Stop tracking behind an inline
// confirm, and the repos that were stopped (their history is kept, so Track again brings it back). The list is server state
// (`useRepoList`); what lives here is only which confirm is open and which button is waiting for its answer.

export function TrackedRepos() {
  const copy = SOURCES_COPY.repos;
  const toast = useToast();
  const list = useRepoList();
  const bootstrap = useBootstrap().data;
  const stop = useStopTracking();
  const recheck = useRecheckRepo();
  const again = useAddRepo();
  const addInput = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const [adding, setAdding] = useState(false);
  const sources = useSources();
  const account = githubRepoAccount(
    sources.data?.accounts?.find((candidate) => candidate.id === 'github'),
  );
  /** The repo whose Stop tracking confirm is open. One at a time. */
  const [confirming, setConfirming] = useState<string | null>(null);
  /** Why the last Track again failed, shown on that repo's row. */
  const [trackProblem, setTrackProblem] = useState<{ id: string; problem: Problem } | null>(null);

  const errorToast = (text: string) => toast({ body: text, type: 'error', isAutoHide: true });

  function stopTracking(id: string, name: string) {
    if (stop.isPending) return;
    stop.mutate(id, {
      onSuccess: () => {
        setConfirming(null);
        // "Undo" tracks the repo again (a stopped repo comes back on the same rows). It asks GitHub for access once more, so it
        // can fail, and says so in a toast of its own.
        const dismiss = toast({
          body: copy.toast.stopped(name),
          isAutoHide: true,
          endContent: (
            <Button
              label={REPO_COPY.undo}
              size="sm"
              variant="ghost"
              className="max-[719px]:min-h-11"
              onClick={() => {
                dismiss();
                undoStop(name);
              }}
            />
          ),
        });
        // The row is gone: the next thing to do is usually to add another, so focus lands on the field.
        (addInput.current ?? addButton.current)?.focus();
      },
      onError: (error) =>
        errorToast(REPO_COPY.couldNotStop(problemOf(error, REPO_COPY.fallback).message)),
    });
  }

  function undoStop(name: string) {
    again.mutate(name, {
      onSuccess: () => toast({ body: copy.toast.trackingAgain(name) }),
      onError: (error) =>
        errorToast(REPO_COPY.couldNotUndo(problemOf(error, REPO_COPY.fallback).message)),
    });
  }

  function checkAgain(id: string) {
    if (recheck.isPending) return;
    recheck.mutate(id, {
      onSuccess: (repo) =>
        toast({
          body:
            repo.accessState === 'ok'
              ? REPO_COPY.accessBack(repo.displayName)
              : copy.toast.stillNoAccess(repo.displayName),
        }),
      onError: (error) =>
        errorToast(REPO_COPY.couldNotCheck(problemOf(error, REPO_COPY.fallback).message)),
    });
  }

  function trackAgain(id: string, name: string) {
    if (again.isPending) return;
    setTrackProblem(null);
    again.mutate(name, {
      onSuccess: () => toast({ body: copy.toast.trackingAgain(name) }),
      onError: (error) => setTrackProblem({ id, problem: problemOf(error, REPO_COPY.fallback) }),
    });
  }

  // A repo GitHub no longer grants comes last, as in the design (the server lists by name).
  const active = [...(list.data?.active ?? [])].sort(
    (a, b) => Number(a.accessState === 'inaccessible') - Number(b.accessState === 'inaccessible'),
  );
  const stopped = list.data?.stopped ?? [];

  return (
    <section
      aria-labelledby="src-repos-title"
      className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4 shadow-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id="src-repos-title" className="font-display text-title-section text-ink">
            {copy.title}
          </h2>
          <p className="mt-0.5 text-caption text-ink-muted">{copy.scope}</p>
        </div>
        <Button
          ref={addButton}
          label={adding ? 'Close repository picker' : copy.add}
          variant="secondary"
          size="sm"
          aria-expanded={adding}
          aria-controls="src-repo-picker"
          className="max-[719px]:min-h-11"
          onClick={() => setAdding(!adding)}
        />
      </div>
      <div id="src-repo-picker" hidden={!adding}>
        {adding &&
          (account ? (
            <RepoPicker
              key={`${account.via}:${account.login.toLowerCase()}`}
              account={account}
              inputRef={addInput}
              focusSearch
              onNeedsGithub={focusGithubSection}
              onTracked={(repo) =>
                toast({
                  body: repo.reactivated
                    ? copy.toast.trackingAgain(repo.displayName)
                    : copy.toast.tracking(repo.displayName, true),
                })
              }
            />
          ) : (
            <AddRepoForm inputRef={addInput} />
          ))}
      </div>
      {list.isError ? (
        <p role="alert" className="text-copy text-danger">
          {REPO_COPY.loadFailed}
        </p>
      ) : !list.data || !bootstrap ? (
        <p role="status" className="text-copy text-ink-muted">
          {REPO_COPY.loading}
        </p>
      ) : (
        <>
          {active.length === 0 ? (
            <p className="text-copy text-ink-muted">{copy.none}</p>
          ) : (
            <ul className="flex flex-col">
              {active.map((repo) => (
                <RepoRow
                  key={repo.id}
                  repo={repo}
                  confirming={confirming === repo.id}
                  checking={recheck.isPending && recheck.variables === repo.id}
                  stopping={stop.isPending && stop.variables === repo.id}
                  onCheck={() => checkAgain(repo.id)}
                  onAskStop={() => setConfirming(repo.id)}
                  onCancelStop={() => setConfirming(null)}
                  onStop={() => stopTracking(repo.id, repo.displayName)}
                />
              ))}
            </ul>
          )}
          {stopped.length > 0 && (
            <div className="flex flex-col gap-2">
              <div>
                <h3 className="text-label font-semibold text-ink">{copy.previouslyTracked}</h3>
                <p className="text-caption text-ink-muted">{copy.historyKept}</p>
              </div>
              <ul className="flex flex-col">
                {stopped.map((repo) => (
                  <StoppedRow
                    key={repo.id}
                    repo={repo}
                    today={bootstrap.today}
                    timeZone={bootstrap.timezone}
                    tracking={again.isPending && again.variables === repo.displayName}
                    problem={trackProblem?.id === repo.id ? trackProblem.problem : null}
                    onTrackAgain={() => trackAgain(repo.id, repo.displayName)}
                  />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
