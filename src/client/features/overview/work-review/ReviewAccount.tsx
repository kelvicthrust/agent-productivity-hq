import { Button } from '@astryxdesign/core/Button';
import { Dialog } from '@astryxdesign/core/Dialog';
import { useEffect, useId, useRef, useState } from 'react';
import { ApiRequestError } from '../../../lib/api';
import { markShown, wasShown } from '../../../lib/shownOnce';
import { REVIEW_LINK } from './Preview';
import { ReviewAutomation } from './ReviewAutomation';
import { useConnectReviewAccount, useDisconnectReviewAccount, useReviewAccount } from './data';

const USAGE_SETTINGS = 'https://chatgpt.com/settings/usage';
const AUTHORIZATION_ENDPOINT = 'https://auth.openai.com/api/accounts/authorize';
const WELCOME_KEY = 'agent-productivity:work-review-chatgpt-welcome-shown';
const TOUCH = 'max-[719px]:min-h-11';

function authorizationUrl(url: string | undefined): string | null {
  return url?.startsWith(`${AUTHORIZATION_ENDPOINT}?`) ? url : null;
}

function ManageUsage() {
  return (
    <a href={USAGE_SETTINGS} target="_blank" rel="noopener noreferrer" className={REVIEW_LINK}>
      Manage usage
    </a>
  );
}

function PlanWelcome() {
  const [open, setOpen] = useState(() => !wasShown(WELCOME_KEY));
  const id = useId();
  function dismiss() {
    markShown(WELCOME_KEY);
    setOpen(false);
  }
  return (
    <Dialog
      isOpen={open}
      onOpenChange={(next) => !next && dismiss()}
      aria-labelledby={id}
      aria-describedby={`${id}-description`}
      width={460}
    >
      {open && (
        <div className="flex flex-col gap-3">
          <h2 id={id} className="font-display text-title-section text-ink">
            You’re using your ChatGPT plan
          </h2>
          <p id={`${id}-description`} className="text-copy text-ink">
            Generating a Work Review uses the allowance of your connected ChatGPT plan. You can
            review your limits in ChatGPT settings.
          </p>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <ManageUsage />
            <Button
              label="Got it"
              size="sm"
              variant="primary"
              className={TOUCH}
              onClick={dismiss}
            />
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function ReviewAccount() {
  const result = useReviewAccount(true);
  const connect = useConnectReviewAccount();
  const disconnect = useDisconnectReviewAccount();
  const id = useId();
  const signInLink = useRef<HTMLAnchorElement>(null);
  const status = result.data?.status;
  const authUrl = authorizationUrl(connect.data?.url);
  const pending = status === 'pending';
  const canConnect = status === 'disconnected' || status === 'needs_consent';
  const canDisconnect =
    pending ||
    status === 'connected' ||
    status === 'needs_consent' ||
    (status !== 'disconnected' && Boolean(result.data?.account));
  const mutationError = connect.error ?? disconnect.error;
  const busy = connect.isPending || disconnect.isPending;

  function startSignIn(newProfile: boolean) {
    if (busy) return;
    connect.reset();
    disconnect.reset();
    connect.mutate(newProfile, {
      onSuccess: ({ url }) => {
        const approvedUrl = authorizationUrl(url);
        if (approvedUrl && window.location.hostname === '127.0.0.1') {
          window.open(approvedUrl, '_blank', 'noopener,noreferrer');
        }
      },
    });
  }

  useEffect(() => {
    if (pending && authUrl) signInLink.current?.focus();
  }, [pending, authUrl]);

  const plan = (
    <section
      aria-labelledby={`${id}-title`}
      className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border border-border bg-surface p-4 shadow-card"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h3 id={`${id}-title`} className="font-display text-title-section text-ink">
          ChatGPT plan
        </h3>
        <p role="status" className="text-copy text-ink-muted [overflow-wrap:anywhere]">
          {status === 'connected' ? (
            <>Using ChatGPT plan{result.data?.account ? ` · ${result.data.account}` : ''}</>
          ) : result.data?.message ? (
            result.data.message
          ) : status === 'unavailable' ? (
            'Sign in with ChatGPT is unavailable for Work Review on this installation.'
          ) : pending ? (
            'Waiting for ChatGPT sign-in.'
          ) : result.isPending ? (
            'Checking the Work Review connection…'
          ) : status === 'needs_consent' ? (
            'Sign in again to allow Work Review to use your ChatGPT plan.'
          ) : status === 'disconnected' ? (
            'Connect a ChatGPT account for Work Review. Generation uses that plan’s allowance.'
          ) : null}
        </p>
        {(canConnect || pending) && (
          <p id={`${id}-instructions`} className="text-caption text-ink-muted">
            Finish sign-in in a browser on the Mac running HQ.
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {status === 'connected' && <ManageUsage />}
        {canConnect && (
          <Button
            label={connect.isPending ? 'Starting sign-in…' : 'Continue with ChatGPT'}
            data-oai-siwc-button=""
            aria-describedby={`${id}-instructions`}
            aria-disabled={busy || undefined}
            size="sm"
            variant="primary"
            className={TOUCH}
            onClick={() => startSignIn(false)}
          />
        )}
        {status === 'disconnected' && result.data?.account && (
          <Button
            label="Use a different ChatGPT account"
            size="sm"
            variant="secondary"
            className={TOUCH}
            aria-disabled={busy || undefined}
            aria-describedby={`${id}-instructions`}
            onClick={() => startSignIn(true)}
          />
        )}
        {pending && authUrl && (
          <a
            ref={signInLink}
            data-oai-siwc-button=""
            href={authUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-describedby={`${id}-instructions`}
            className={REVIEW_LINK}
          >
            Open ChatGPT sign-in
          </a>
        )}
        {canDisconnect && (
          <Button
            label={
              disconnect.isPending
                ? 'Disconnecting…'
                : pending
                  ? 'Cancel sign-in'
                  : 'Disconnect ChatGPT'
            }
            aria-disabled={busy || undefined}
            size="sm"
            variant="secondary"
            className={TOUCH}
            onClick={() => {
              if (busy) return;
              disconnect.mutate(undefined, { onSuccess: () => connect.reset() });
            }}
          />
        )}
        {result.isError && (
          <Button
            label="Retry connection check"
            size="sm"
            variant="secondary"
            className={TOUCH}
            onClick={() => void result.refetch()}
          />
        )}
      </div>
      {result.isError && (
        <p role="alert" className="basis-full text-copy text-danger">
          Couldn’t read the Work Review connection.
        </p>
      )}
      {mutationError && (
        <p role="alert" className="basis-full text-copy text-danger">
          {mutationError instanceof ApiRequestError
            ? mutationError.message
            : 'Couldn’t change the Work Review connection. Try again.'}
        </p>
      )}
      {pending && !authUrl && (
        <p
          className="basis-full text-copy text-ink-muted"
          role={connect.data ? 'alert' : undefined}
        >
          {connect.data
            ? 'HQ couldn’t use the returned sign-in URL. Cancel and try again.'
            : 'Continue in the browser where you started sign-in, or cancel and start again here.'}
        </p>
      )}
      {status === 'connected' && <PlanWelcome />}
    </section>
  );

  return (
    <>
      {plan}
      <ReviewAutomation connected={status === 'connected' && !result.isError} accountBusy={busy} />
    </>
  );
}
