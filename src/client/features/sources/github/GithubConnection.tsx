import { Button } from '@astryxdesign/core/Button';
import { useToast } from '@astryxdesign/core/Toast';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AccountStatus, SourceStatus } from '../../../../shared/contracts/sources';
import { GITHUB_APP_GUIDE_LABEL, GithubAppGuide } from '../../../components/GithubAppGuide';
import { Icon } from '../../../components/Icon';
import { StatusTag, type StatusKind } from '../../../components/StatusTag';
import { useBootstrap } from '../../../lib/bootstrap';
import { REFRESH_COPY, SOURCES_COPY, STATUS_TEXT } from '../../../lib/copy';
import { formatWhen, upperFirst } from '../../../lib/format';
import { invalidateServerState } from '../../../lib/queryClient';
import { sourceRefreshFailed } from '../../../lib/sourceStatus';
import { GITHUB_TITLE_ID } from './anchor';
import { ClientIdField } from './ClientIdField';
import { GITHUB_COPY } from './copy';
import {
  messageOf,
  useConnect,
  useDisconnect,
  useGithub,
  useSignInPoll,
  type Connected,
} from './data';
import { DeviceCodePanel, type DeviceFlow } from './DeviceCodePanel';

// The GitHub connection (G6_5 client half, G6_10): which sign-in the dashboard is using, Connect and Disconnect, and, when `gh`
// is not signed in, the one-time App setup: the registration guide, the client-ID field and the device-code panel.
//
// Where the state lives (TECH › State ownership): the card is server state (`GET /api/sources` accounts[0]; every write below
// invalidates it); which device sign-in this page started, and the problem the last Connect had, are local to this section and
// last as long as it is on screen. A sign-in the server still has going after a reload has no code to show here, so the card says
// "Waiting for sign-in…" with Cancel and "Start again", which asks GitHub for a new code.

type Card = AccountStatus;

const ROW =
  'grid grid-cols-[minmax(160px,220px)_minmax(0,1fr)_auto] items-start gap-x-6 gap-y-2 max-[719px]:grid-cols-1';
const BUTTON = 'max-[719px]:min-h-11 aria-disabled:cursor-default aria-disabled:opacity-70';

/** A status tag as short words (it never wraps); the server's longer sentence goes under it as a detail. */
function tagFor(card: Card): { kind: StatusKind; text: string } {
  switch (card.status) {
    case 'existing':
      return { kind: 'existing', text: STATUS_TEXT.existingSignIn };
    case 'connected':
      return { kind: 'connected', text: STATUS_TEXT.connected };
    case 'connecting':
      return { kind: 'connecting', text: STATUS_TEXT.waitingForSignIn };
    case 'reconnect':
      return { kind: 'reconnect', text: STATUS_TEXT.reconnectNeeded };
    case 'failed':
    case 'unavailable':
      return { kind: 'failed', text: GITHUB_COPY.tag.failed };
    case 'needsapp':
      return { kind: 'notconnected', text: GITHUB_COPY.tag.needsApp };
    case 'notconnected':
      return { kind: 'notconnected', text: STATUS_TEXT.notConnected };
  }
}

function Alert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-1.5 text-caption text-danger">
      <Icon name="error" className="mt-px" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** The sync's own line: when it last worked and how the latest attempt went (the same words the "On this machine" rows use). */
function syncLine(sync: SourceStatus, when: (instant: string) => string): string | null {
  if (!sync.lastSuccessAt && !sync.lastAttemptAt) return null;
  const lastSuccess = sync.lastSuccessAt ? upperFirst(when(sync.lastSuccessAt)) : '—';
  const attempt = !sync.lastAttemptAt
    ? null
    : sync.lastAttemptResult === 'failed'
      ? REFRESH_COPY.failedAttempt(sync.consecutiveFailures ?? 1, when(sync.lastAttemptAt))
      : sync.lastAttemptResult === 'partial'
        ? REFRESH_COPY.attemptPartial
        : REFRESH_COPY.attemptSucceeded;
  return `${GITHUB_COPY.syncLabel}: ${REFRESH_COPY.lastSuccess(lastSuccess)}${attempt ? ` · ${REFRESH_COPY.latestAttempt(attempt)}` : ''}`;
}

export function GithubConnection() {
  const toast = useToast();
  const client = useQueryClient();
  const { sources, card, sync } = useGithub();
  const bootstrap = useBootstrap().data;
  const connect = useConnect();
  const disconnect = useDisconnect();
  const title = useRef<HTMLHeadingElement>(null);
  /** The device sign-in this page started. */
  const [flow, setFlow] = useState<DeviceFlow | null>(null);
  /** Why the last Connect did not start a sign-in. */
  const [problem, setProblem] = useState<string | null>(null);
  /** Set when a press is about to take the focused button away; the Connect button that replaces it takes the focus. */
  const wantConnectFocus = useRef(false);

  const poll = useSignInPoll(flow?.loginId ?? null);
  const pollState = flow === null ? null : poll.isError ? 'error' : (poll.data?.state ?? 'pending');
  const outcome = pollState === null || pollState === 'pending' ? null : pollState;
  const endedMessage =
    outcome === 'error'
      ? messageOf(poll.error, GITHUB_COPY.fallback)
      : outcome === 'failed' || outcome === 'expired' || outcome === 'cancelled'
        ? (poll.data?.message ?? GITHUB_COPY.fallback)
        : null;
  const connectedLogin = poll.data?.account?.login;

  // A sign-in that has ended (connected, refused, expired, cancelled elsewhere) is said once: read the card again, say "connected"
  // in a toast, and take the focus back to the heading if it was lost with the panel that held it.
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (flow === null || outcome === null || announced.current === flow.loginId) return;
    announced.current = flow.loginId;
    void invalidateServerState(client).catch(() => undefined);
    if (outcome === 'connected') toast({ body: GITHUB_COPY.toast.connected(connectedLogin) });
    if (document.activeElement === null || document.activeElement === document.body) {
      title.current?.focus();
    }
  }, [flow, outcome, connectedLogin, client, toast]);

  const when = (instant: string): string =>
    formatWhen(instant, bootstrap ? { timeZone: bootstrap.timezone, today: bootstrap.today } : {});

  function started(answer: Connected) {
    if (answer.mode === 'existing') {
      toast({ body: GITHUB_COPY.toast.existing });
    } else if (
      answer.mode === 'device' &&
      answer.loginId &&
      answer.userCode &&
      answer.verificationUri
    ) {
      setFlow({
        loginId: answer.loginId,
        userCode: answer.userCode,
        verificationUri: answer.verificationUri,
        expires: answer.expiresAt ? when(answer.expiresAt) : null,
      });
    } else {
      setProblem(GITHUB_COPY.fallback);
    }
  }

  function connectNow() {
    if (connect.isPending) return;
    setProblem(null);
    setFlow(null);
    connect.mutate(undefined, {
      onSuccess: started,
      onError: (error) => setProblem(messageOf(error, GITHUB_COPY.fallback)),
    });
  }

  /** Stops a running sign-in. It is the same route as Disconnect, and the server says "cancelled" to the next poll. */
  function cancelSignIn() {
    if (disconnect.isPending) return;
    wantConnectFocus.current = true;
    disconnect.mutate(undefined, {
      onSuccess: () => setFlow(null),
      onError: (error) => {
        wantConnectFocus.current = false;
        toast({
          body: GITHUB_COPY.toast.couldNotDisconnect(messageOf(error, GITHUB_COPY.fallback)),
          type: 'error',
          isAutoHide: true,
        });
      },
    });
  }

  function disconnectNow() {
    if (disconnect.isPending) return;
    wantConnectFocus.current = true;
    disconnect.mutate(undefined, {
      onSuccess: () => {
        setFlow(null);
        toast({ body: GITHUB_COPY.toast.disconnected });
      },
      onError: (error) => {
        wantConnectFocus.current = false;
        toast({
          body: GITHUB_COPY.toast.couldNotDisconnect(messageOf(error, GITHUB_COPY.fallback)),
          type: 'error',
          isAutoHide: true,
        });
      },
    });
  }

  const connectRef = (element: HTMLButtonElement | null) => {
    if (element && wantConnectFocus.current) {
      wantConnectFocus.current = false;
      element.focus();
    }
  };

  const signingIn = card?.status === 'connecting';
  const showPanel = flow !== null && pollState === 'pending';
  const usingIt = card?.status === 'existing' || card?.status === 'connected';
  // The App setup is for a sign-in that is not `gh`, and is out of the way while one is in use or a code is on screen.
  const showSetup = card !== undefined && !usingIt && !signingIn && !showPanel;

  // The card state names the region with its row's heading; the other states (loading, failed, not available) say so with one.
  let named = false;
  let body: ReactNode;
  if (sources.isError) {
    body = (
      <p role="alert" className="text-copy text-danger">
        {GITHUB_COPY.loadFailed}
      </p>
    );
  } else if (!sources.data) {
    body = (
      <p role="status" className="text-copy text-ink-muted">
        {GITHUB_COPY.loading}
      </p>
    );
  } else if (!card) {
    body = <p className="text-copy text-ink-muted">{GITHUB_COPY.unavailable}</p>;
  } else {
    named = true;
    const tag = tagFor(card);
    const sentence = card.statusText && card.statusText !== tag.text ? card.statusText : null;
    const syncText = sync ? syncLine(sync, when) : null;
    const connectLabel = card.status === 'reconnect' ? GITHUB_COPY.reconnect : GITHUB_COPY.connect;
    body = (
      <>
        <div className={ROW}>
          <div className="flex min-w-0 flex-col gap-1">
            <h3
              ref={title}
              id={GITHUB_TITLE_ID}
              tabIndex={-1}
              className="m-0 text-copy font-bold text-ink"
            >
              {card.name}
            </h3>
            {/* Polite: "Waiting for sign-in…" turning into "Connected" is announced where it happens. */}
            <span aria-live="polite">
              <StatusTag kind={tag.kind}>{tag.text}</StatusTag>
            </span>
          </div>
          <div className="flex min-w-0 flex-col gap-1 text-caption text-ink-muted">
            <span>{SOURCES_COPY.accounts.purpose.github}</span>
            {sentence && (
              <span className={card.status === 'failed' ? 'text-danger' : undefined}>
                {sentence}
              </span>
            )}
            {card.login && <span>{SOURCES_COPY.accounts.identity(card.login)}</span>}
            {syncText && <span>{syncText}</span>}
            {sync?.message && (
              <span className={sourceRefreshFailed(sync) ? 'text-danger' : undefined}>
                {sync.message}
              </span>
            )}
          </div>
          <div className="flex flex-wrap justify-end gap-2 max-[719px]:justify-start">
            {usingIt ? (
              <Button
                label={disconnect.isPending ? GITHUB_COPY.disconnecting : GITHUB_COPY.disconnect}
                size="sm"
                variant="secondary"
                aria-busy={disconnect.isPending || undefined}
                aria-disabled={disconnect.isPending || undefined}
                className={BUTTON}
                onClick={disconnectNow}
              />
            ) : (
              !signingIn &&
              !showPanel && (
                <Button
                  ref={connectRef}
                  label={connect.isPending ? GITHUB_COPY.connecting : connectLabel}
                  icon={connect.isPending ? <Icon name="spinner" /> : undefined}
                  size="sm"
                  variant="primary"
                  aria-busy={connect.isPending || undefined}
                  aria-disabled={connect.isPending || undefined}
                  className={BUTTON}
                  onClick={connectNow}
                />
              )
            )}
          </div>
        </div>
        {problem !== null && <Alert>{problem}</Alert>}
        {endedMessage !== null && <Alert>{endedMessage}</Alert>}
        {showPanel && flow && (
          <DeviceCodePanel flow={flow} cancelling={disconnect.isPending} onCancel={cancelSignIn} />
        )}
        {signingIn && !showPanel && (
          <div
            role="group"
            aria-label={STATUS_TEXT.waitingForSignIn}
            className="flex flex-col gap-3 rounded-md bg-sunken p-4"
          >
            <p className="text-caption text-ink">{GITHUB_COPY.device.lost}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                label={GITHUB_COPY.device.cancel}
                size="sm"
                variant="secondary"
                aria-busy={disconnect.isPending || undefined}
                aria-disabled={disconnect.isPending || undefined}
                className={BUTTON}
                onClick={cancelSignIn}
              />
              <Button
                label={connect.isPending ? GITHUB_COPY.connecting : GITHUB_COPY.device.startAgain}
                size="sm"
                variant="primary"
                aria-busy={connect.isPending || undefined}
                aria-disabled={connect.isPending || undefined}
                className={BUTTON}
                onClick={connectNow}
              />
            </div>
          </div>
        )}
        {showSetup && (
          <div className="flex flex-col gap-3 rounded-md bg-sunken p-4">
            {/* Open until a client ID is saved, then folded away; the owner can open it again to fix a wrong ID. */}
            <details open={!card.appClientIdSaved}>
              <summary className="cursor-pointer text-label font-semibold text-ink">
                {GITHUB_APP_GUIDE_LABEL}
              </summary>
              <div className="mt-3">
                <GithubAppGuide />
              </div>
            </details>
            <ClientIdField saved={card.appClientIdSaved === true} />
          </div>
        )}
      </>
    );
  }

  // A row of the Accounts card (D7 lists GitHub first, then ChatGPT and Claude), still its own region named GitHub.
  return (
    <li className="m-0 list-none border-b border-border pb-3 first:pt-0 last:border-b-0 last:pb-0">
      <section aria-labelledby={GITHUB_TITLE_ID} className="flex min-w-0 flex-col gap-3">
        {!named && (
          <h3
            ref={title}
            id={GITHUB_TITLE_ID}
            tabIndex={-1}
            className="m-0 text-copy font-bold text-ink"
          >
            {GITHUB_COPY.title}
          </h3>
        )}
        {body}
      </section>
    </li>
  );
}
