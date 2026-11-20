import { Button } from '@astryxdesign/core/Button';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { accountTag } from '../../components/AccountCard';
import { Icon } from '../../components/Icon';
import { StatusTag } from '../../components/StatusTag';
import {
  useChatgptConnect,
  useChatgptDisconnect,
  useChatgptPoll,
  type Account,
  type Connected,
} from '../../lib/accounts';
import { useBootstrap } from '../../lib/bootstrap';
import { STATUS_TEXT } from '../../lib/copy';
import { formatWhen } from '../../lib/format';
import { invalidateServerState } from '../../lib/queryClient';
import { SETUP_COPY } from './copy';
import { messageOf } from './data';
import { ACTIONS, Alert, BUTTON, ROW } from './parts';
import { WRAPPING_LABEL } from '../../lib/wrapLabel';

// The ChatGPT row of step 2: Connect starts Codex's own browser sign-in (the caption beside the button says it signs Codex in on this
// computer too), the page opens the sign-in address in its own tab and asks the server about the login id every two seconds until it is
// no longer pending. Nothing shows as connected before the server says so. When discovery found no `codex` on the PATH the card is
// Unavailable and offers no Connect, only "Check again", which looks again.

const COPY = SETUP_COPY.accounts;

/** The sign-in this page started: where its page is, and when it stops working. */
interface Flow {
  loginId: string;
  authUrl: string | null;
  expires: string | null;
}

/** Only an https page is ever opened: the address comes from Codex, but nothing else is a sign-in page. */
const httpsOnly = (url: string | null | undefined): string | null =>
  url != null && url.startsWith('https://') ? url : null;

export function ChatgptRow({
  card,
  noLocalCodex,
  onCheckAgain,
  checking,
}: {
  card: Account | undefined;
  /** Discovery found no Codex history here: a connected account then gives account-reported totals only. */
  noLocalCodex: boolean;
  /** Looks at this machine again (a `codex` installed since is found). */
  onCheckAgain: () => void;
  checking: boolean;
}) {
  const client = useQueryClient();
  const bootstrap = useBootstrap().data;
  const connect = useChatgptConnect();
  const disconnect = useChatgptDisconnect();
  const captionId = useId();
  const [flow, setFlow] = useState<Flow | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const poll = useChatgptPoll(flow?.loginId ?? null);
  const pollState = flow === null ? null : poll.isError ? 'error' : (poll.data?.state ?? 'pending');
  const outcome = pollState === null || pollState === 'pending' ? null : pollState;
  const endedMessage =
    outcome === 'error'
      ? messageOf(poll.error, SETUP_COPY.fallback)
      : outcome === 'failed' || outcome === 'expired' || outcome === 'cancelled'
        ? (poll.data?.message ?? SETUP_COPY.fallback)
        : null;

  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (flow === null || outcome === null || announced.current === flow.loginId) return;
    announced.current = flow.loginId;
    void invalidateServerState(client).catch(() => undefined);
  }, [flow, outcome, client]);

  const when = (instant: string): string =>
    formatWhen(instant, bootstrap ? { timeZone: bootstrap.timezone, today: bootstrap.today } : {});

  function started(answer: Connected) {
    if (answer.mode === 'existing') return;
    if (answer.mode === 'browser' && answer.loginId) {
      const authUrl = httpsOnly(answer.authUrl);
      setFlow({
        loginId: answer.loginId,
        authUrl,
        expires: answer.expiresAt ? when(answer.expiresAt) : null,
      });
      // The page the owner asked for opens in its own tab. A browser may refuse a tab opened after a request, so the panel keeps its link.
      if (authUrl) window.open(authUrl, '_blank', 'noopener,noreferrer');
    } else {
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

  function cancelSignIn() {
    if (disconnect.isPending) return;
    disconnect.mutate(undefined, {
      onSuccess: () => setFlow(null),
      onError: (error) => setProblem(messageOf(error, SETUP_COPY.fallback)),
    });
  }

  if (card === undefined) {
    return (
      <li className={ROW}>
        <b className="text-copy font-bold text-ink">ChatGPT</b>
        <p className="text-caption text-ink-muted">{COPY.chatgptUnavailable}</p>
      </li>
    );
  }

  const tag = accountTag(card.status);
  const sentence =
    card.status !== 'existing' && card.statusText && card.statusText !== tag.text
      ? card.statusText
      : null;
  const signingIn = card.status === 'connecting';
  const showPanel = signingIn || (flow !== null && pollState === 'pending');
  const connected = card.status === 'existing' || card.status === 'connected';
  const canConnect = card.status === 'notconnected' || card.status === 'reconnect';
  const lost = flow === null || pollState !== 'pending';
  const href = httpsOnly(flow?.authUrl);

  return (
    <li className={ROW}>
      <div className="flex min-w-0 flex-col gap-1">
        <b className="text-copy font-bold text-ink">{card.name}</b>
        <span aria-live="polite">
          <StatusTag kind={tag.kind}>{tag.text}</StatusTag>
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-1 text-caption text-ink-muted">
        <span>{COPY.chatgptPurpose}</span>
        {sentence && <span>{sentence}</span>}
        {connected && noLocalCodex && <span>{COPY.noLocalCodex}</span>}
      </div>
      <div className="flex flex-col items-end gap-1.5 max-[719px]:items-start">
        {canConnect && !showPanel && (
          <>
            <Button
              label={
                connect.isPending
                  ? COPY.connecting
                  : card.status === 'reconnect'
                    ? COPY.reconnect
                    : COPY.connect('ChatGPT')
              }
              icon={connect.isPending ? <Icon name="spinner" /> : undefined}
              size="sm"
              variant="primary"
              aria-describedby={captionId}
              aria-busy={connect.isPending || undefined}
              aria-disabled={connect.isPending || undefined}
              className={BUTTON}
              onClick={connectNow}
            />
            {/* The disclosure, beside the button that causes it and read with it. */}
            <p
              id={captionId}
              className="max-w-[26ch] text-right text-caption text-ink-muted max-[719px]:text-left"
            >
              {COPY.chatgpt.signInCaption}
            </p>
          </>
        )}
        {card.status === 'unavailable' && (
          <div className={ACTIONS}>
            <Button
              label={SETUP_COPY.sources.checkAgain}
              icon={<Icon name="refresh" />}
              size="sm"
              variant="secondary"
              aria-busy={checking || undefined}
              aria-disabled={checking || undefined}
              className={BUTTON}
              onClick={() => {
                if (!checking) onCheckAgain();
              }}
            />
          </div>
        )}
      </div>
      {problem !== null && <Alert className="col-span-full">{problem}</Alert>}
      {endedMessage !== null && <Alert className="col-span-full">{endedMessage}</Alert>}
      {showPanel && (
        <div
          role="group"
          aria-labelledby={`${captionId}-waiting`}
          className="col-span-full flex flex-col gap-3 rounded-md bg-sunken p-4"
        >
          <div className="flex flex-col gap-1">
            <h3 id={`${captionId}-waiting`} className="text-label font-semibold text-ink">
              {COPY.chatgpt.waiting.heading}
            </h3>
            <p className="text-caption text-ink-muted">
              {lost ? COPY.chatgpt.waiting.lost : COPY.chatgpt.waiting.body}
            </p>
          </div>
          <p role="status" className="flex items-start gap-1.5 text-caption text-ink-muted">
            <Icon name="spinner" className="mt-px" />
            <span className="min-w-0">
              {STATUS_TEXT.waitingForSignIn}
              {flow?.expires && !lost && ` ${COPY.chatgpt.waiting.expires(flow.expires)}`}
            </span>
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              label={disconnect.isPending ? COPY.cancelling : COPY.cancel}
              size="sm"
              variant="secondary"
              aria-busy={disconnect.isPending || undefined}
              aria-disabled={disconnect.isPending || undefined}
              className={BUTTON}
              onClick={cancelSignIn}
            />
            {lost ? (
              <Button
                label={connect.isPending ? COPY.connecting : COPY.startAgain}
                size="sm"
                variant="primary"
                aria-busy={connect.isPending || undefined}
                aria-disabled={connect.isPending || undefined}
                className={BUTTON}
                onClick={connectNow}
              />
            ) : (
              href && (
                <Button
                  label={COPY.chatgpt.waiting.open}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  icon={<Icon name="external" />}
                  size="sm"
                  variant="primary"
                  className={WRAPPING_LABEL}
                />
              )
            )}
          </div>
        </div>
      )}
    </li>
  );
}
