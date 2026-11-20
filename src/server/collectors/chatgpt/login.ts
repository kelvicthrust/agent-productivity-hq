import { parseAccount, parseLoginOffer } from './parse.ts';
import type { LaunchAppServer } from './ports.ts';
import { failureOf, openSession, type Failure, type SessionOptions } from './rpc.ts';

// ChatGPT sign-in through Codex's own flow (owner choice P4; local-api › POST /api/accounts/{account}/connect). The dashboard asks the
// app-server to start the browser sign-in (`account/login/start`, type `chatgpt`), hands the owner's browser the address it returns,
// and waits for the app-server's `account/login/completed`. Codex saves and refreshes the tokens itself: nothing of the sign-in is
// ever read, stored or logged here, and the only thing kept of it is whether it succeeded.
//
// This is the one place a child lives longer than a read. The app-server listens for the browser's return while the owner signs in,
// so the child stays until the sign-in ends (success, refusal, timeout or Cancel) and is killed then, whichever way it ends.
// The disclosure in the UI ("This signs Codex in on this computer too.") is the owner's notice that the sign-in is Codex's.

/** How long the owner has to finish in the browser. */
export const LOGIN_WAIT_MS = 10 * 60_000;

export type LoginOutcome = 'connected' | 'failed' | 'expired' | 'cancelled';

export interface LoginFlow {
  readonly loginId: string;
  /** The ChatGPT sign-in page. Always an https address. */
  readonly authUrl: string;
  /** Resolves once, when the sign-in has ended. The child has been killed by then. */
  readonly done: Promise<LoginOutcome>;
  /** Ends a sign-in that is still waiting. `done` then resolves `cancelled`. */
  cancel(): void;
}

export type LoginStart =
  | { kind: 'started'; flow: LoginFlow }
  /** Codex is already signed in with ChatGPT: there is nothing to sign in to, and nobody is asked for anything (P-42). */
  | { kind: 'existing' }
  /** There is no `codex` on this machine. */
  | { kind: 'absent' }
  | { kind: 'failed'; why: Failure };

export interface LoginOptions extends SessionOptions {
  /** How long to wait for the browser sign-in to finish; LOGIN_WAIT_MS unless a test shortens it. */
  waitMs?: number;
}

export async function startChatgptLogin(
  launch: LaunchAppServer,
  options: LoginOptions = {},
): Promise<LoginStart> {
  const opened = await openSession(launch, options);
  if (opened.kind === 'absent') return { kind: 'absent' };
  if (opened.kind === 'failed') return { kind: 'failed', why: opened.why };
  const { session } = opened;

  try {
    // Already signed in with ChatGPT: say so rather than start a second sign-in. A read that fails here is not decisive; starting
    // the sign-in below fails the same way if the app-server is not answering.
    const account = await session.call('account/read', { refreshToken: false });
    if (account.kind === 'result' && parseAccount(account.result) === 'chatgpt') {
      session.close();
      return { kind: 'existing' };
    }

    const started = await session.call('account/login/start', { type: 'chatgpt' });
    if (started.kind !== 'result') {
      session.close();
      return { kind: 'failed', why: failureOf(started) ?? 'error' };
    }
    const offer = parseLoginOffer(started.result);
    if (offer === null) {
      session.close();
      return { kind: 'failed', why: 'error' };
    }

    let cancelled = false;
    const done = (async (): Promise<LoginOutcome> => {
      try {
        const ended = await session.waitForNotification(
          'account/login/completed',
          // One sign-in runs on this child, so a completion with no id is ours too.
          (params) =>
            params['loginId'] === undefined ||
            params['loginId'] === null ||
            params['loginId'] === offer.loginId,
          options.waitMs ?? LOGIN_WAIT_MS,
        );
        if (cancelled) return 'cancelled';
        if (ended.kind === 'notification')
          return ended.params['success'] === true ? 'connected' : 'failed';
        return ended.kind === 'timeout' ? 'expired' : 'failed';
      } finally {
        session.close();
      }
    })();

    return {
      kind: 'started',
      flow: {
        loginId: offer.loginId,
        authUrl: offer.authUrl,
        done,
        cancel: () => {
          cancelled = true;
          // Killing the child closes the app-server's listener for the browser's return, which is all cancelling a sign-in is.
          session.close();
        },
      },
    };
  } catch (error) {
    session.close();
    throw error;
  }
}
