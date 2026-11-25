import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type {
  WorkReviewAccount,
  WorkReviewConnect,
} from '../../../shared/contracts/work-review.ts';
import type { Keyring, NetFetch } from '../../collectors/github/ports.ts';
import {
  listenForWorkReviewCallback,
  type CallbackListener,
  type CallbackResult,
} from './callback.ts';
import {
  authorizationUrl,
  canUsePlan,
  ClientId,
  Credentials,
  exchangeCode,
  Profile,
  refreshGrant,
  revokeGrant,
  WorkReviewAuthError,
} from './protocol.ts';

export { WorkReviewAuthError };

const SERVICE = 'agent-productivity-work-review';
const AUTHORIZATION_MS = 5 * 60_000;
const REFRESH_AHEAD_MS = 60_000;
const REFRESH_TIMEOUT_MS = 5_000;
const STORE_UNAVAILABLE = 'The system credential store for Work Review is unavailable.';
const CONSENT_NEEDED = 'Enable ChatGPT plan usage to generate a Work Review.';
const CONNECTION_EXPIRED = 'Your ChatGPT connection has expired. Sign in again.';
const EXPIRED_SIGN_IN = 'The ChatGPT sign-in attempt expired. Return to Work Review and try again.';
const CALLBACK_FAILED =
  'ChatGPT sign-in could not be completed. Return to Work Review and try again.';
const CALLBACK_INVALID = 'This sign-in response does not match the pending Work Review request.';
const CALLBACK_DONE =
  'ChatGPT sign-in is complete. You can close this tab and return to Work Review.';

const Store = z
  .strictObject({
    hostId: z.string().regex(/^urn:uuid:[0-9a-f-]{36}$/),
    profile: Profile.nullable(),
    credentials: Credentials.nullable(),
  })
  .refine((record) => record.profile !== null || record.credentials === null);
type Store = z.infer<typeof Store>;

interface Options {
  keyring: Keyring;
  storageId: string;
  net: NetFetch;
  now?: () => number;
  listen?: typeof listenForWorkReviewCallback;
}

interface LoginAttempt {
  controller: AbortController;
  callback: Promise<CallbackListener>;
  state: string;
  timer: ReturnType<typeof setTimeout>;
  claimed: boolean;
  exchange: Promise<CallbackResult> | null;
}

const random = () => randomBytes(32).toString('base64url');
const same = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export const workReviewAccountUnavailable: WorkReviewAccount = {
  status: 'unavailable',
  account: null,
  message: 'ChatGPT sign-in is unavailable on this installation.',
};

export interface WorkReviewAuth {
  status(): WorkReviewAccount;
  connect(
    newProfile?: boolean,
    clearReviewConsent?: () => Promise<void>,
  ): Promise<WorkReviewConnect>;
  disconnect(cancelReview?: () => Promise<void>): Promise<WorkReviewAccount>;
  reset(): Promise<void>;
  close(): Promise<void>;
  accessToken(signal: AbortSignal): Promise<string>;
  invalidateAccessToken(rejected: string): Promise<void>;
}

/** The separate OAuth grant Work Review uses. Only the injected credential store ever sees a serialized token set. */
export function createWorkReviewAuth({
  keyring,
  storageId,
  net,
  now = Date.now,
  listen = listenForWorkReviewCallback,
}: Options): WorkReviewAuth {
  const account = createHash('sha256').update(storageId).digest('hex');
  let pending: LoginAttempt | null = null;
  let refresh: Promise<string> | null = null;
  let discarding = false;
  let closed = false;
  let message: string | null = null;
  let retryClientId: string | null = null;

  function read(): Store | null {
    try {
      const raw = keyring.get(SERVICE, account);
      return raw === null ? null : Store.parse(JSON.parse(raw));
    } catch {
      throw new WorkReviewAuthError(STORE_UNAVAILABLE);
    }
  }

  function write(value: Store | null): void {
    try {
      if (value === null) keyring.delete(SERVICE, account);
      else keyring.set(SERVICE, account, JSON.stringify(Store.parse(value)));
    } catch {
      throw new WorkReviewAuthError(STORE_UNAVAILABLE);
    }
  }

  function isUnexpired(credential: Credentials): boolean {
    const at = now();
    return (
      credential.accessExpiresAt > at ||
      (credential.refresh !== null && credential.refreshExpiresAt > at)
    );
  }

  function status(): WorkReviewAccount {
    if (closed) return workReviewAccountUnavailable;
    if (discarding) return { status: 'disconnected', account: null, message: null };
    let saved: Store | null;
    try {
      saved = read();
    } catch {
      return { ...workReviewAccountUnavailable, message: STORE_UNAVAILABLE };
    }
    const label = saved?.profile ? (saved.profile.email ?? 'ChatGPT account') : null;
    if (pending && !pending.controller.signal.aborted)
      return { status: 'pending', account: label, message };
    const credential = saved?.credentials;
    if (!credential) return { status: 'disconnected', account: label, message };
    if (isUnexpired(credential)) {
      if (!canUsePlan(credential))
        return { status: 'needs_consent', account: label, message: message ?? CONSENT_NEEDED };
      return { status: 'connected', account: label, message };
    }
    return {
      status: 'disconnected',
      account: label,
      message: CONNECTION_EXPIRED,
    };
  }

  function endAttempt(attempt: LoginAttempt, force: boolean): Promise<void> {
    if (pending === attempt) pending = null;
    clearTimeout(attempt.timer);
    if (force) attempt.controller.abort();
    return attempt.callback.then(
      (listener) => listener.close(force),
      () => undefined,
    );
  }

  async function connect(
    newProfile = false,
    clearReviewConsent?: () => Promise<void>,
  ): Promise<WorkReviewConnect> {
    if (closed || discarding)
      throw new WorkReviewAuthError('Work Review sign-in is unavailable right now.');
    if (pending)
      throw new WorkReviewAuthError(
        'A ChatGPT sign-in is already open. Complete it on the installation computer.',
      );
    let saved = read();
    if (newProfile && saved?.credentials && isUnexpired(saved.credentials))
      throw new WorkReviewAuthError(
        'Disconnect the current ChatGPT account before connecting another.',
      );
    if (!saved) {
      saved = { hostId: `urn:uuid:${randomUUID()}`, profile: null, credentials: null };
      write(saved);
    }
    const original = saved;
    const selected = newProfile ? null : original.profile;
    const client = newProfile ? null : (selected?.clientId ?? retryClientId);
    const state = random();
    const nonce = random();
    const verifier = random();
    const deadline = now() + AUTHORIZATION_MS;
    const controller = new AbortController();
    const consent =
      selected !== null && original.credentials !== null && !canUsePlan(original.credentials);
    message = null;

    const callbackFailed = (detail: string): CallbackResult => {
      if (!controller.signal.aborted) message = detail;
      return { status: 400, message: `${detail} Return to Work Review.` };
    };
    const finish = async (query: URLSearchParams): Promise<CallbackResult> => {
      if (query.has('error')) {
        return callbackFailed('ChatGPT did not grant access.');
      }
      const code = query.get('code');
      const returned = query.get('client_id');
      const issued = ClientId.safeParse(returned ?? client);
      if (
        query.getAll('code').length !== 1 ||
        !code ||
        code.length > 4096 ||
        query.getAll('client_id').length > 1 ||
        !issued.success ||
        (client !== null && issued.data !== client) ||
        (query.has('iss') &&
          (query.getAll('iss').length !== 1 || query.get('iss') !== 'https://auth.openai.com'))
      )
        return callbackFailed('ChatGPT returned an incomplete sign-in response.');
      try {
        const listener = await attempt.callback;
        const result = await exchangeCode(net, {
          clientId: issued.data,
          code,
          verifier,
          redirectUri: listener.uri,
          nonce,
          profile: selected,
          now,
          signal: controller.signal,
        });
        if (controller.signal.aborted || pending !== attempt || now() >= deadline) {
          if (result.credentials.refresh)
            await revokeGrant(net, issued.data, result.credentials.refresh);
          return { status: 400, message: EXPIRED_SIGN_IN };
        }
        try {
          write({ hostId: original.hostId, ...result });
        } catch (error) {
          if (result.credentials.refresh)
            await revokeGrant(net, issued.data, result.credentials.refresh);
          throw error;
        }
        retryClientId = null;
        message = canUsePlan(result.credentials) ? null : CONSENT_NEEDED;
        return {
          status: 200,
          message: message ? `${message} Return to Work Review.` : CALLBACK_DONE,
        };
      } catch (error) {
        if (controller.signal.aborted) return { status: 400, message: EXPIRED_SIGN_IN };
        if (error instanceof WorkReviewAuthError && error.invalidGrant && selected === null)
          retryClientId = issued.data;
        return callbackFailed(
          error instanceof WorkReviewAuthError ? error.message : CALLBACK_FAILED,
        );
      }
    };

    const onCallback = async (query: URLSearchParams): Promise<CallbackResult> => {
      const returned = query.get('state');
      if (
        pending !== attempt ||
        attempt.claimed ||
        query.getAll('state').length !== 1 ||
        returned === null ||
        !same(returned, state)
      ) {
        return { status: 400, message: CALLBACK_INVALID };
      }
      if (now() >= deadline) {
        message = EXPIRED_SIGN_IN;
        void endAttempt(attempt, false);
        return { status: 400, message: EXPIRED_SIGN_IN };
      }
      attempt.claimed = true;
      attempt.exchange = finish(query);
      try {
        return await attempt.exchange;
      } finally {
        // The active HTTP reply completes before the open socket retires.
        void endAttempt(attempt, false);
      }
    };
    const attempt: LoginAttempt = {
      controller,
      callback: listen(onCallback),
      state,
      timer: setTimeout(() => {
        if (pending === attempt) {
          message = EXPIRED_SIGN_IN;
          if (attempt.exchange) {
            attempt.controller.abort();
            void attempt.callback.then(
              (listener) => listener.close(true),
              () => undefined,
            );
          } else {
            void endAttempt(attempt, true);
          }
        }
      }, AUTHORIZATION_MS).unref(),
      claimed: false,
      exchange: null,
    };
    pending = attempt;
    try {
      const listener = await attempt.callback;
      // A new registration may authorize a different account, including after losing the Keychain entry.
      if (!selected) await clearReviewConsent?.();
      if (controller.signal.aborted) throw new WorkReviewAuthError(EXPIRED_SIGN_IN);
      return {
        url: authorizationUrl({
          profile: selected,
          retryClientId: client,
          hostId: original.hostId,
          redirectUri: listener.uri,
          state: attempt.state,
          nonce,
          verifier,
          consent,
        }),
      };
    } catch {
      await endAttempt(attempt, true);
      throw new WorkReviewAuthError('The computer could not open a ChatGPT callback. Try again.');
    }
  }

  async function stopPending(): Promise<void> {
    const attempt = pending;
    if (!attempt) return;
    await Promise.all([endAttempt(attempt, true), attempt.exchange?.catch(() => undefined)]);
  }

  async function discard(forget: boolean, cancelReview?: () => Promise<void>): Promise<void> {
    if (discarding)
      throw new WorkReviewAuthError('The ChatGPT connection is already being cleared.');
    discarding = true;
    try {
      await Promise.all([stopPending(), cancelReview?.()]);
      await refresh?.catch(() => undefined);
      let saved: Store | null = null;
      try {
        saved = read();
      } catch (error) {
        if (!forget) throw error;
        write(null);
      }
      if (saved) write(forget ? null : { ...saved, credentials: null });
      retryClientId = null;
      message = null;
      const token = saved?.credentials?.refresh ?? null;
      if (saved?.profile && token && !(await revokeGrant(net, saved.profile.clientId, token))) {
        message =
          'Work Review signed out locally. ChatGPT did not confirm revocation. You can disconnect the app in ChatGPT settings.';
      }
    } finally {
      discarding = false;
    }
  }

  async function renew(
    saved: Store,
    profile: Profile,
    previous: Credentials,
    token: string,
  ): Promise<string> {
    let replacement: Credentials;
    try {
      replacement = await refreshGrant(
        net,
        profile.clientId,
        token,
        now,
        AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      );
    } catch (error) {
      if (error instanceof WorkReviewAuthError && error.terminal) {
        write({ ...saved, credentials: null });
        message = error.message;
        throw error;
      }
      if (previous.accessExpiresAt > now()) return previous.access;
      throw new WorkReviewAuthError(
        'ChatGPT could not renew the Work Review connection. Try again.',
      );
    }
    try {
      write({ ...saved, credentials: replacement });
    } catch (error) {
      if (replacement.refresh) await revokeGrant(net, profile.clientId, replacement.refresh);
      throw error;
    }
    if (!canUsePlan(replacement)) throw new WorkReviewAuthError(CONSENT_NEEDED);
    return replacement.access;
  }

  return {
    status,
    connect,
    async disconnect(cancelReview) {
      await discard(false, cancelReview);
      return status();
    },
    reset: () => discard(true),
    async close() {
      closed = true;
      await stopPending();
      await refresh?.catch(() => undefined);
    },
    async accessToken(signal) {
      signal.throwIfAborted();
      if (closed || discarding || pending) throw new WorkReviewAuthError();
      const saved = read();
      const current = saved?.credentials;
      const profile = saved?.profile;
      if (!current || !profile) throw new WorkReviewAuthError();
      if (!canUsePlan(current)) throw new WorkReviewAuthError(CONSENT_NEEDED);
      const accessLeft = current.accessExpiresAt - now();
      const canRefresh = current.refresh !== null && current.refreshExpiresAt > now();
      if (accessLeft > REFRESH_AHEAD_MS || (accessLeft > 0 && !canRefresh)) return current.access;
      if (!canRefresh) throw new WorkReviewAuthError(CONNECTION_EXPIRED);
      refresh ??= renew(saved, profile, current, current.refresh!).finally(() => {
        refresh = null;
      });
      const token = await refresh;
      signal.throwIfAborted();
      if (closed || discarding) throw new WorkReviewAuthError();
      return token;
    },
    async invalidateAccessToken(rejected) {
      // A delayed response may refer to a grant that has already rotated or been replaced.
      while (refresh) await refresh.catch(() => undefined);
      if (closed || discarding) return;
      const saved = read();
      if (!saved?.credentials || !same(saved.credentials.access, rejected)) return;
      write({ ...saved, credentials: null });
      message = CONNECTION_EXPIRED;
    },
  };
}
