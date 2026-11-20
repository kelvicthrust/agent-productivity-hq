import { Button } from '@astryxdesign/core/Button';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { AccountStatus } from '../../../shared/contracts/sources';
import { GITHUB_APP_GUIDE_LABEL, GithubAppGuide } from '../../components/GithubAppGuide';
import { Icon } from '../../components/Icon';
import { StatusTag, type StatusKind } from '../../components/StatusTag';
import { useBootstrap } from '../../lib/bootstrap';
import { STATUS_TEXT } from '../../lib/copy';
import { formatWhen } from '../../lib/format';
import { invalidateServerState } from '../../lib/queryClient';
import { SETUP_COPY } from './copy';
import {
  messageOf,
  useGithubCancel,
  useGithubConnect,
  useGithubPoll,
  type Connected,
} from './data';
import { ClientIdField, DeviceCodePanel, type DeviceFlow } from './GithubParts';
import { ACTIONS, Alert, BUTTON, ROW } from './parts';

// The GitHub row of step 2: which sign-in the dashboard is using, Connect, and, when `gh` is NOT signed in, the one-time App setup (the
// guide, the client-ID field and the device-code panel). With `gh` signed in there is nothing to type: the row says so and the
// client-ID field is not in the page at all (P-41: it is the only extra field, and only for this case).
//
// Where the state lives (TECH › State ownership): the card is server state (`GET /api/sources` accounts; every write invalidates it);
// which device sign-in this page started, and the problem the last Connect had, are local to the row. A sign-in the server still has
// going after a reload has no code to show here, so the row says so with Cancel and "Start again", which asks GitHub for a new code.

const COPY = SETUP_COPY.accounts;

function tagFor(card: AccountStatus): { kind: StatusKind; text: string } {
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
      return { kind: 'failed', text: COPY.tag.failed };
    case 'needsapp':
      return { kind: 'notconnected', text: COPY.tag.needsApp };
    case 'notconnected':
      return { kind: 'notconnected', text: STATUS_TEXT.notConnected };
  }
}

export function GithubRow({ card }: { card: AccountStatus | undefined }) {
  const client = useQueryClient();
  const bootstrap = useBootstrap().data;
  const connect = useGithubConnect();
  const cancel = useGithubCancel();
  /** The device sign-in this page started. */
  const [flow, setFlow] = useState<DeviceFlow | null>(null);
  const [appSetupOpen, setAppSetupOpen] = useState(false);
  /** Why the last Connect did not start a sign-in. */
  const [problem, setProblem] = useState<string | null>(null);

  const poll = useGithubPoll(flow?.loginId ?? null);
  const pollState = flow === null ? null : poll.isError ? 'error' : (poll.data?.state ?? 'pending');
  const outcome = pollState === null || pollState === 'pending' ? null : pollState;
  const endedMessage =
    outcome === 'error'
      ? messageOf(poll.error, SETUP_COPY.fallback)
      : outcome === 'failed' || outcome === 'expired' || outcome === 'cancelled'
        ? (poll.data?.message ?? SETUP_COPY.fallback)
        : null;

  // A sign-in that has ended (connected, refused, expired, cancelled elsewhere) is said once: the card is read again, which is what turns
  // its tag to "Connected".
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (flow === null || outcome === null || announced.current === flow.loginId) return;
    announced.current = flow.loginId;
    void invalidateServerState(client).catch(() => undefined);
  }, [flow, outcome, client]);

  const when = (instant: string): string =>
    formatWhen(instant, bootstrap ? { timeZone: bootstrap.timezone, today: bootstrap.today } : {});

  function started(answer: Connected) {
    if (answer.mode === 'device' && answer.loginId && answer.userCode && answer.verificationUri) {
      setFlow({
        loginId: answer.loginId,
        userCode: answer.userCode,
        verificationUri: answer.verificationUri,
        expires: answer.expiresAt ? when(answer.expiresAt) : null,
      });
    } else if (answer.mode !== 'existing') {
      setProblem(SETUP_COPY.fallback);
    }
  }

  function connectNow() {
    if (connect.isPending) return;
    setProblem(null);
    setFlow(null);
    connect.mutate(undefined, {
      onSuccess: started,
      onError: (error) => setProblem(messageOf(error, SETUP_COPY.fallback)),
    });
  }

  /** Stops a running sign-in. It is the Disconnect route, and the server says "cancelled" to the next poll. */
  function cancelSignIn() {
    if (cancel.isPending) return;
    cancel.mutate(undefined, {
      onSuccess: () => setFlow(null),
      onError: (error) => setProblem(messageOf(error, SETUP_COPY.fallback)),
    });
  }

  if (card === undefined) {
    return (
      <li className={ROW}>
        <b className="text-copy font-bold text-ink">GitHub</b>
        <p className="text-caption text-ink-muted">{COPY.githubUnavailable}</p>
      </li>
    );
  }

  const tag = tagFor(card);
  const sentence = card.statusText && card.statusText !== tag.text ? card.statusText : null;
  const signingIn = card.status === 'connecting';
  const showPanel = flow !== null && pollState === 'pending';
  const usingIt = card.status === 'existing' || card.status === 'connected';
  // The App setup is for a sign-in that is not `gh`: out of the way while one is in use or a code is on screen.
  const showConnect = !usingIt && !signingIn && !showPanel;
  const hasClientId = card.appClientIdSaved === true;
  const canConnect = hasClientId || card.reason === 'gh_disconnected';
  const connectLabel = connect.isPending
    ? COPY.connecting
    : !canConnect && appSetupOpen
      ? COPY.github.closeSetup
      : card.status === 'reconnect'
        ? COPY.reconnect
        : COPY.connect('GitHub');

  return (
    <li className={ROW}>
      <div className="flex min-w-0 flex-col gap-1">
        <b className="text-copy font-bold text-ink">{card.name}</b>
        {/* Polite: "Waiting for sign-in…" turning into "Connected" is announced where it happens. */}
        <span aria-live="polite">
          <StatusTag kind={tag.kind}>{tag.text}</StatusTag>
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-1 text-caption text-ink-muted">
        <span>{COPY.githubPurpose}</span>
        {sentence && (
          <span className={card.status === 'failed' ? 'text-danger' : undefined}>{sentence}</span>
        )}
        {card.login && <span>{COPY.github.identity(card.login)}</span>}
      </div>
      <div className={ACTIONS}>
        {showConnect && (
          <>
            {hasClientId && (
              <Button
                label={appSetupOpen ? COPY.github.closeSetup : COPY.github.changeClientId}
                size="sm"
                variant="secondary"
                aria-expanded={appSetupOpen}
                className={BUTTON}
                onClick={() => setAppSetupOpen(!appSetupOpen)}
              />
            )}
            <Button
              label={connectLabel}
              icon={connect.isPending ? <Icon name="spinner" /> : undefined}
              size="sm"
              variant="primary"
              aria-busy={connect.isPending || undefined}
              aria-disabled={connect.isPending || undefined}
              aria-expanded={canConnect ? undefined : appSetupOpen}
              className={BUTTON}
              onClick={canConnect ? connectNow : () => setAppSetupOpen(!appSetupOpen)}
            />
          </>
        )}
      </div>
      {problem !== null && <Alert className="col-span-full">{problem}</Alert>}
      {endedMessage !== null && <Alert className="col-span-full">{endedMessage}</Alert>}
      {showPanel && flow && (
        <DeviceCodePanel flow={flow} cancelling={cancel.isPending} onCancel={cancelSignIn} />
      )}
      {signingIn && !showPanel && (
        <div
          role="group"
          aria-label={STATUS_TEXT.waitingForSignIn}
          className="col-span-full flex flex-col gap-3 rounded-md bg-sunken p-4"
        >
          <p className="text-caption text-ink">{COPY.github.device.lost}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              label={COPY.cancel}
              size="sm"
              variant="secondary"
              aria-busy={cancel.isPending || undefined}
              aria-disabled={cancel.isPending || undefined}
              className={BUTTON}
              onClick={cancelSignIn}
            />
            <Button
              label={connect.isPending ? COPY.connecting : COPY.startAgain}
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
      {showConnect && appSetupOpen && (
        <div className="col-span-full flex flex-col gap-3 rounded-md bg-sunken p-4">
          <details>
            <summary className="cursor-pointer text-label font-semibold text-ink max-[719px]:py-3">
              {GITHUB_APP_GUIDE_LABEL}
            </summary>
            <div className="mt-3">
              <GithubAppGuide />
            </div>
          </details>
          <ClientIdField saved={hasClientId} />
        </div>
      )}
    </li>
  );
}
