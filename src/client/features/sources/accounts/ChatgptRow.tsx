import { Button } from '@astryxdesign/core/Button';
import { useToast } from '@astryxdesign/core/Toast';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { accountTag } from '../../../components/AccountCard';
import { Icon } from '../../../components/Icon';
import { StatusTag } from '../../../components/StatusTag';
import {
  useChatgptConnect,
  useChatgptDisconnect,
  useChatgptPoll,
  type Account,
  type Connected,
} from '../../../lib/accounts';
import { useBootstrap } from '../../../lib/bootstrap';
import { SOURCES_COPY, STATUS_TEXT } from '../../../lib/copy';
import { formatWhen } from '../../../lib/format';
import { invalidateServerState } from '../../../lib/queryClient';
import { ACCOUNTS_COPY } from './copy';
import { messageOf } from './data';
import { ROW, BUTTON, Alert } from './parts';
import { WRAPPING_LABEL } from '../../../lib/wrapLabel';

// The ChatGPT row: how the dashboard reads the account (Codex's own sign-in), Connect and Disconnect, and the sign-in page.
//
// Connect starts Codex's own browser sign-in, and the caption beside it says what that means: "This signs Codex in on this
// computer too." The server answers with the sign-in page's address and a login id; the page opens it, shows a waiting panel with
// Cancel on the left and the page's own link (the primary action) on the right, and asks the server about the login id every
// two seconds until it is no longer pending. Nothing shows as connected before the server says so: the card changes when the
// sources are read again after the poll ends.
//
// Disconnect only stops the dashboard reading; it does not sign Codex out and deletes nothing that was imported. It is also what
// cancels a sign-in that is waiting (the same route the GitHub card uses).

/** The sign-in this page started: where its page is, and when it stops working. */
interface Flow {
  loginId: string;
  authUrl: string | null;
  /** Already worded ("today, 9:57 AM"); null when the server did not say. */
  expires: string | null;
}

/** Only an https page is ever opened: the address comes from Codex, but nothing else is a sign-in page. */
const httpsOnly = (url: string | null | undefined): string | null =>
  url != null && url.startsWith('https://') ? url : null;

function SignInPanel({
  flow,
  lost,
  cancelling,
  starting,
  onCancel,
  onStartAgain,
}: {
  /** The sign-in this page started, or null for one the server has going that this page did not start. */
  flow: Flow | null;
  lost: boolean;
  cancelling: boolean;
  starting: boolean;
  onCancel: () => void;
  onStartAgain: () => void;
}) {
  const copy = ACCOUNTS_COPY.chatgpt;
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  // The Connect button this replaced took the focus with it: land on the heading, so what to do next is read first.
  useEffect(() => heading.current?.focus(), []);
  const href = httpsOnly(flow?.authUrl);
  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className="col-span-full flex flex-col gap-3 rounded-md bg-sunken p-4"
    >
      <div className="flex flex-col gap-1">
        <h3
          ref={heading}
          id={headingId}
          tabIndex={-1}
          className="text-label font-semibold text-ink"
        >
          {copy.waiting.heading}
        </h3>
        <p className="text-caption text-ink-muted">
          {lost ? copy.waiting.lost : copy.waiting.body}
        </p>
      </div>
      <p role="status" className="flex items-start gap-1.5 text-caption text-ink-muted">
        <Icon name="spinner" className="mt-px" />
        <span className="min-w-0">
          {STATUS_TEXT.waitingForSignIn}
          {flow?.expires && ` ${copy.waiting.expires(flow.expires)}`}
        </span>
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          label={cancelling ? copy.cancelling : copy.cancel}
          size="sm"
          variant="secondary"
          aria-busy={cancelling || undefined}
          aria-disabled={cancelling || undefined}
          className={BUTTON}
          onClick={() => {
            if (!cancelling) onCancel();
          }}
        />
        {lost ? (
          <Button
            label={starting ? copy.connecting : copy.startAgain}
            size="sm"
            variant="primary"
            aria-busy={starting || undefined}
            aria-disabled={starting || undefined}
            className={BUTTON}
            onClick={() => {
              if (!starting) onStartAgain();
            }}
          />
        ) : (
          href && (
            <Button
              label={copy.waiting.open}
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
  );
}

export function ChatgptRow({ card }: { card: Account }) {
  const copy = ACCOUNTS_COPY.chatgpt;
  const toast = useToast();
  const client = useQueryClient();
  const bootstrap = useBootstrap().data;
  const connect = useChatgptConnect();
  const disconnect = useChatgptDisconnect();
  const captionId = useId();
  /** The sign-in this page started. */
  const [flow, setFlow] = useState<Flow | null>(null);
  /** Why the last Connect did not start a sign-in. */
  const [problem, setProblem] = useState<string | null>(null);
  /** Set when a press is about to take the focused button away: which button replaces it, so that one takes the focus. */
  const wantFocus = useRef<'connect' | 'disconnect' | null>(null);

  const poll = useChatgptPoll(flow?.loginId ?? null);
  const pollState = flow === null ? null : poll.isError ? 'error' : (poll.data?.state ?? 'pending');
  const outcome = pollState === null || pollState === 'pending' ? null : pollState;
  const endedMessage =
    outcome === 'error'
      ? messageOf(poll.error, ACCOUNTS_COPY.fallback)
      : outcome === 'failed' || outcome === 'expired' || outcome === 'cancelled'
        ? (poll.data?.message ?? ACCOUNTS_COPY.fallback)
        : null;

  // A sign-in that has ended (connected, refused, expired, cancelled) is said once: the sources are read again and "connected" is
  // said in a toast. If the focus was lost with the panel that held it, the button that replaces it (Disconnect, or Connect again)
  // takes it.
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (flow === null || outcome === null || announced.current === flow.loginId) return;
    announced.current = flow.loginId;
    void invalidateServerState(client).catch(() => undefined);
    if (outcome === 'connected') toast({ body: copy.toast.connected });
    if (document.activeElement === null || document.activeElement === document.body) {
      wantFocus.current = outcome === 'connected' ? 'disconnect' : 'connect';
    }
  }, [flow, outcome, client, toast, copy.toast.connected]);

  const when = (instant: string): string =>
    formatWhen(instant, bootstrap ? { timeZone: bootstrap.timezone, today: bootstrap.today } : {});

  function started(answer: Connected) {
    if (answer.mode === 'existing') {
      toast({ body: copy.toast.existing });
      return;
    }
    if (answer.mode === 'browser' && answer.loginId) {
      const authUrl = httpsOnly(answer.authUrl);
      setFlow({
        loginId: answer.loginId,
        authUrl,
        expires: answer.expiresAt ? when(answer.expiresAt) : null,
      });
      // The page the owner asked for opens in its own tab. A browser may refuse a tab opened after a request, so the panel keeps
      // the page's link too.
      if (authUrl) window.open(authUrl, '_blank', 'noopener,noreferrer');
    } else {
      setProblem(ACCOUNTS_COPY.fallback);
    }
  }

  function connectNow() {
    if (connect.isPending) return;
    setProblem(null);
    setFlow(null);
    connect.mutate(undefined, {
      onSuccess: started,
      onError: (error) => setProblem(messageOf(error, ACCOUNTS_COPY.fallback)),
    });
  }

  function disconnectNow(announce: boolean) {
    if (disconnect.isPending) return;
    wantFocus.current = 'connect';
    disconnect.mutate(undefined, {
      onSuccess: () => {
        setFlow(null);
        if (announce) toast({ body: copy.toast.disconnected });
      },
      onError: (error) => {
        wantFocus.current = null;
        toast({
          body: copy.toast.couldNotDisconnect(messageOf(error, ACCOUNTS_COPY.fallback)),
          type: 'error',
          isAutoHide: true,
        });
      },
    });
  }

  const focusIfWanted =
    (which: 'connect' | 'disconnect') =>
    (element: HTMLButtonElement | null): void => {
      if (element && wantFocus.current === which) {
        wantFocus.current = null;
        element.focus();
      }
    };

  const tag = accountTag(card.status);
  // The tag is short words; the server's sentence goes under it when it says more (why it is unavailable, which sign-in).
  const sentence =
    card.status !== 'existing' && card.statusText && card.statusText !== tag.text
      ? card.statusText
      : null;
  const signingIn = card.status === 'connecting';
  const showPanel = signingIn || (flow !== null && pollState === 'pending');
  const usingIt =
    card.status === 'existing' || card.status === 'connected' || card.status === 'failed';
  const canConnect = card.status === 'notconnected' || card.status === 'reconnect';
  const connectLabel =
    card.status === 'reconnect'
      ? SOURCES_COPY.accounts.reconnect
      : SOURCES_COPY.accounts.connect(copy.name);

  return (
    <li className={ROW}>
      <div className="flex flex-col gap-1">
        <b className="text-copy font-bold text-ink">{card.name}</b>
        {/* Polite: "Waiting for sign-in…" turning into "Connected" is announced where it happens. */}
        <span aria-live="polite">
          <StatusTag kind={tag.kind}>{tag.text}</StatusTag>
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-1 text-caption text-ink-muted">
        <span>{SOURCES_COPY.accounts.purpose.chatgpt}</span>
        {sentence && <span>{sentence}</span>}
        {card.status === 'notconnected' && <span>{SOURCES_COPY.accounts.noReport}</span>}
      </div>
      <div className="flex flex-col items-end gap-1.5 max-[719px]:items-start">
        {usingIt && (
          <Button
            ref={focusIfWanted('disconnect')}
            label={disconnect.isPending ? copy.disconnecting : SOURCES_COPY.accounts.disconnect}
            size="sm"
            variant="secondary"
            aria-busy={disconnect.isPending || undefined}
            aria-disabled={disconnect.isPending || undefined}
            className={BUTTON}
            onClick={() => disconnectNow(true)}
          />
        )}
        {canConnect && !showPanel && (
          <>
            <Button
              ref={focusIfWanted('connect')}
              label={connect.isPending ? copy.connecting : connectLabel}
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
              {copy.signInCaption}
            </p>
          </>
        )}
      </div>
      {problem !== null && <Alert>{problem}</Alert>}
      {endedMessage !== null && <Alert>{endedMessage}</Alert>}
      {showPanel && (
        <SignInPanel
          flow={pollState === 'pending' ? flow : null}
          lost={flow === null || pollState !== 'pending'}
          cancelling={disconnect.isPending}
          starting={connect.isPending}
          onCancel={() => disconnectNow(false)}
          onStartAgain={connectNow}
        />
      )}
    </li>
  );
}
