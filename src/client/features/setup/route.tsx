import { Button } from '@astryxdesign/core/Button';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useOutletContext } from 'react-router';
import { CrewArt } from '../../components/CrewArt';
import { useSources } from '../../components/RefreshBanner';
import { cx } from '../../lib/cx';
import { githubRepoAccount } from '../../lib/repos';
import { useCompleteSetup, useSetupDiscovery, type Discovery } from '../../lib/setup';
import { AccountsStep } from './AccountsStep';
import { SETUP_COPY } from './copy';
import { messageOf } from './data';
import { Alert, BUTTON } from './parts';
import { ReposStep } from './ReposStep';
import { SetupProgress } from './SetupProgress';
import { SourcesStep } from './SourcesStep';

// First-launch Setup (TECH › J1 Set up coverage): three steps, each of which can be skipped, ending in "Finish setup", which marks setup
// done, starts the first refresh and lands on Overview (skeletons and "Importing…" until the run ends). The route has no navigation and no
// filters (SetupLayout), and nothing on it asks for a folder, a path, an API key, a password or a cookie: discovery is automatic, and the only
// field besides the repository is GitHub's non-secret client ID, which appears only when `gh` is not signed in.
//
// Where the state lives (TECH › State ownership): the sources, accounts and repos are server state, read through the same queries the
// Sources page uses. Which step is showing, and the last discovery answer, are transient and live here, for as long as the page is on
// screen. The step is not in the URL: a reload starts again at step 1, and discovery only looks, so nothing is lost.

const LAST = SETUP_COPY.steps.length - 1;

// Back and Skip share a line on a phone and the primary action has the line below, so no label is cut short ("Skip this step" does not
// fit beside two other buttons at 320px).
const SECONDARY = 'max-[719px]:flex-[1_1_40%]';
const PRIMARY = 'max-[719px]:basis-full';

export function SetupRoute() {
  const [step, setStep] = useState(0);
  const [answer, setAnswer] = useState<Discovery | null>(null);
  // D7 draws "Step N of 3" at the right of the app bar. The bar belongs to the layout, which hands its actions slot down the outlet.
  const barSlot = useOutletContext<HTMLElement | null>();
  const [finishProblem, setFinishProblem] = useState<string | null>(null);
  const discovery = useSetupDiscovery();
  const sources = useSources(step >= 1);
  const complete = useCompleteSetup();
  const navigate = useNavigate();
  const body = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const started = useRef(false);
  const finishStarted = useRef(false);

  const { mutate: discover } = discovery;
  const look = useCallback(() => discover(undefined, { onSuccess: setAnswer }), [discover]);
  // The first look starts when the page opens (the ref keeps StrictMode's second effect from asking twice).
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    look();
  }, [look]);

  // Moving between steps puts the focus on the new step's heading, so the keyboard and a screen reader start where the content does.
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    body.current?.querySelector<HTMLElement>('h2')?.focus();
  }, [step]);

  function go(next: number) {
    moved.current = true;
    setFinishProblem(null);
    setStep(Math.min(LAST, Math.max(0, next)));
  }

  function finish() {
    if (finishStarted.current) return;
    finishStarted.current = true;
    setFinishProblem(null);
    // Nothing is optimistic: the run was started and the bootstrap read again before this resolves, so Overview does not bounce back.
    complete.mutate(undefined, {
      onSuccess: () => void navigate('/', { replace: true }),
      onError: (error) => {
        finishStarted.current = false;
        setFinishProblem(SETUP_COPY.finishFailed(messageOf(error, SETUP_COPY.fallback)));
      },
    });
  }

  const looking = discovery.isPending;
  const failed = discovery.isError;
  const found = (answer?.sources ?? []).some(
    (source) => source.id !== 'paseo' && (source.status === 'ok' || source.status === 'partial'),
  );
  // The crew art looks around until the look is done, then is awake if something was found.
  const mood = looking || answer === null || !found ? 'search' : 'awake';
  const finishing = complete.isPending;
  const copy = SETUP_COPY.actions;
  const accounts = sources.data ? (sources.data.accounts ?? []) : undefined;
  const github = accounts?.find((account) => account.id === 'github');
  const githubConnected = github?.status === 'existing' || github?.status === 'connected';
  const githubAccount = githubRepoAccount(github);
  const githubChecking = accounts === undefined && !sources.isError;
  const continueWithoutGithub = step === 1 && !githubConnected && !githubChecking;

  return (
    <div className="flex flex-col gap-6 pt-2">
      {barSlot &&
        createPortal(
          <span className="text-caption text-ink-muted">
            {SETUP_COPY.stepOf(step + 1, SETUP_COPY.steps.length)}
          </span>,
          barSlot,
        )}
      {/* A div, not a <header>: the page has one banner, the app bar, and a header inside <main> is read as a second one by tools that ignore context. */}
      <div className="flex items-center gap-6 max-[719px]:flex-col max-[719px]:items-start">
        <CrewArt mood={mood} className="shrink-0" />
        <div className="min-w-0">
          {/* The page is named "Setup" for assistive technology and the tab title, as every screen is; what the owner reads is D7's heading. */}
          <h1 id="page-title" tabIndex={-1} className="font-display text-title-page text-ink">
            <span className="sr-only">{SETUP_COPY.title}: </span>
            {SETUP_COPY.lead}
          </h1>
          <p className="mt-1 max-w-[60ch] text-copy text-ink-muted">{SETUP_COPY.intro}</p>
        </div>
      </div>

      {/* D7's three pills, wrapping at every width (SetupProgress); the same `step` that picks the body and the app bar's caption. */}
      <SetupProgress activeStep={step} />

      <div ref={body} className="flex flex-col gap-4">
        {step === 0 && (
          <SourcesStep answer={answer} looking={looking} failed={failed} onLookAgain={look} />
        )}
        {step === 1 && (
          <AccountsStep
            accounts={accounts}
            accountsFailed={sources.isError}
            answer={answer}
            looking={looking}
            onLookAgain={look}
          />
        )}
        {step === 2 && (
          <ReposStep
            githubAccount={githubAccount}
            githubChecking={githubChecking}
            onNeedsGithub={() => go(1)}
          />
        )}

        {finishProblem !== null && <Alert>{finishProblem}</Alert>}

        {/* Primary on the right; Back and Skip on its left. On a phone Back and Skip share the first line and the primary action has the
            line below, full width. DOM order is the visual order either way, so the keyboard meets them the way the eye does. */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {step > 0 && (
            <Button
              label={step === 2 && !githubConnected ? SETUP_COPY.repos.backToAccounts : copy.back}
              variant="secondary"
              className={cx(BUTTON, SECONDARY)}
              onClick={() => go(step - 1)}
            />
          )}
          {step < LAST && !continueWithoutGithub && (
            <Button
              label={copy.skip}
              variant="ghost"
              className={cx(BUTTON, SECONDARY)}
              onClick={() => go(step + 1)}
            />
          )}
          {step < LAST ? (
            <Button
              label={continueWithoutGithub ? copy.withoutGithub : copy.next}
              variant="primary"
              aria-disabled={(step === 0 && (looking || answer === null)) || undefined}
              aria-describedby={
                step === 0 && (looking || answer === null) ? 'setup-wait' : undefined
              }
              className={cx(BUTTON, PRIMARY)}
              onClick={() => {
                if (step === 0 && (looking || answer === null) && !failed) return;
                go(step + 1);
              }}
            />
          ) : (
            <Button
              label={finishing ? copy.finishing : copy.finish}
              variant="primary"
              aria-busy={finishing || undefined}
              aria-disabled={finishing || undefined}
              className={cx(BUTTON, PRIMARY)}
              onClick={finish}
            />
          )}
        </div>
        {step === 0 && (looking || answer === null) && !failed && (
          <p
            id="setup-wait"
            className="text-right text-caption text-ink-muted max-[719px]:text-left"
          >
            {SETUP_COPY.waitingForLook}
          </p>
        )}
      </div>
    </div>
  );
}
