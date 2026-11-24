import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Keyring, NetInit } from '../../../src/server/collectors/github/ports.ts';
import {
  createWorkReviewAuth,
  type WorkReviewAuth,
} from '../../../src/server/integrations/workReviewAuth/index.ts';
import { listenForWorkReviewCallback } from '../../../src/server/integrations/workReviewAuth/callback.ts';
import {
  WORK_REVIEW_JWKS_URL,
  WORK_REVIEW_MODELS_URL,
  WORK_REVIEW_RESPONSES_URL,
  WORK_REVIEW_REVOKE_URL,
  WORK_REVIEW_TOKEN_URL,
} from '../../../src/server/lib/net.ts';
import { createWorkReviewWorker } from '../../../src/server/services/work-review/worker.ts';
import { NOW } from '../helpers.ts';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...keys.publicKey.export({ format: 'jwk' }),
  alg: 'RS256',
  use: 'sig',
  kid: 'fixture',
};
const signal = () => new AbortController().signal;
const accessToken = 'fixture-access';
const refreshToken = 'fixture-refresh';
const clientId = 'oaiapp_synthetic';
const plan = 'openid resource.invoke chatgpt.tokens.use.direct offline_access';
const services: WorkReviewAuth[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

function fixture(realListener = false) {
  let storage: string | null = null;
  let clock = NOW;
  let nonce = '';
  let receive: Parameters<typeof listenForWorkReviewCallback>[0] | null = null;
  const keyring: Keyring = {
    get: () => storage,
    set: (_service, _account, value) => {
      storage = value;
    },
    delete: () => {
      const hadStorage = storage !== null;
      storage = null;
      return hadStorage;
    },
  };
  const calls: { url: string; params: URLSearchParams; init: NetInit | undefined }[] = [];
  const signed = (extra?: Record<string, unknown>) => {
    const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString(
      'base64url',
    );
    const claims = Buffer.from(
      JSON.stringify({
        iss: 'https://auth.openai.com',
        aud: clientId,
        sub: 'fixture-owner',
        nonce,
        iat: Math.floor(clock / 1000),
        exp: Math.floor(clock / 1000) + 3600,
        email: 'owner@example.test',
        email_verified: true,
        ...extra,
      }),
    ).toString('base64url');
    const data = `${head}.${claims}`;
    return `${data}.${sign('RSA-SHA256', Buffer.from(data), keys.privateKey).toString('base64url')}`;
  };
  const token = (overrides: object = {}) => ({
    access_token: accessToken,
    refresh_token: refreshToken,
    id_token: signed(),
    scope: plan,
    token_type: 'Bearer',
    expires_in: 3600,
    ...overrides,
  });
  const script = {
    code: async () => Response.json(token()),
    refresh: async () =>
      Response.json(token({ access_token: 'rotated-access', refresh_token: 'rotated-refresh' })),
    revoke: async () => new Response(null, { status: 200 }),
  };
  const open = () => {
    const auth = createWorkReviewAuth({
      keyring,
      storageId: '/example/agent-productivity-data',
      now: () => clock,
      ...(realListener
        ? {}
        : {
            listen: async (handler) => {
              receive = handler;
              return {
                uri: 'http://127.0.0.1:1455/auth/callback',
                close: async () => {
                  if (receive === handler) receive = null;
                },
              };
            },
          }),
      net: async (url, init) => {
        const params = new URLSearchParams(init?.body);
        calls.push({ url, params, init });
        if (url === WORK_REVIEW_TOKEN_URL) {
          if (params.get('grant_type') === 'authorization_code') return script.code();
          if (params.get('grant_type') === 'refresh_token') return script.refresh();
        }
        if (url === WORK_REVIEW_JWKS_URL) return Response.json({ keys: [jwk] });
        if (url === WORK_REVIEW_REVOKE_URL) return script.revoke();
        throw new Error('Unexpected endpoint');
      },
    });
    services.push(auth);
    return auth;
  };
  return {
    open,
    signed,
    token,
    calls,
    script,
    get storage() {
      return storage;
    },
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    async begin(auth: WorkReviewAuth, newProfile?: boolean) {
      const result = await auth.connect(newProfile);
      const url = new URL(result.url);
      nonce = url.searchParams.get('nonce')!;
      return url;
    },
    async callback(authorize: URL, params: Record<string, string> = {}) {
      const query = new URLSearchParams({
        state: authorize.searchParams.get('state')!,
        code: 'synthetic-code',
        client_id: clientId,
        ...params,
      });
      if (realListener) return fetch(`${authorize.searchParams.get('redirect_uri')}?${query}`);
      const result = await receive!(query);
      return new Response(result.message, { status: result.status });
    },
  };
}

describe('Work Review ChatGPT authorization', () => {
  it.each(['catalog', 'inference', 'stream'])(
    'allows sign-in again after the %s confirms a rejected grant',
    async (stage) => {
      const world = fixture();
      const auth = world.open();
      await world.callback(await world.begin(auth));
      const worker = createWorkReviewWorker({
        accessToken: auth.accessToken,
        invalidateAccessToken: (token: string) => auth.invalidateAccessToken(token),
        net: async (url) => {
          if (stage === 'catalog' || (stage === 'inference' && url === WORK_REVIEW_RESPONSES_URL)) {
            return Response.json({ detail: 'rejected' }, { status: 401 });
          }
          if (url === WORK_REVIEW_MODELS_URL) {
            return Response.json({ models: [{ slug: 'gpt-6-luna', visibility: 'list' }] });
          }
          const event = {
            type: 'response.failed',
            response: { error: { code: 'subscription_sharing_invalid_user' } },
          };
          return new Response(`data: ${JSON.stringify(event)}\n\n`, {
            headers: { 'content-type': 'text/event-stream' },
          });
        },
      });
      await expect(
        worker.extract(
          {
            date: '2026-11-24',
            title: 'Prototype report',
            turns: [],
          },
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'sign_in_required' });
      expect(auth.status()).toMatchObject({
        status: 'disconnected',
        account: 'owner@example.test',
      });
      expect(world.storage).not.toContain(accessToken);
      expect(world.storage).not.toContain(refreshToken);
      expect(world.calls.some(({ url }) => url === WORK_REVIEW_REVOKE_URL)).toBe(false);
      const retry = await world.begin(auth);
      expect(retry.searchParams.get('client_id')).toBe(clientId);
      expect((await world.callback(retry)).status).toBe(200);
      expect(auth.status().status).toBe('connected');
    },
  );

  it('offers a new registration after the old account grant and refresh have both expired', async () => {
    const world = fixture();
    const auth = world.open();
    await world.callback(await world.begin(auth));
    await expect(world.begin(auth, true)).rejects.toThrow(/Disconnect/);
    world.advance(31 * 24 * 3600 * 1000);
    expect(auth.status().status).toBe('disconnected');
    const switchAccount = await world.begin(auth, true);
    expect(switchAccount.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect((await world.callback(switchAccount)).status).toBe(200);
    expect(auth.status().status).toBe('connected');
  });

  it('ignores a rejection for an older token while a fresh grant is being saved', async () => {
    const world = fixture();
    const auth = world.open();
    await world.callback(await world.begin(auth));
    world.advance(3600 * 1000 + 1);
    let finishRefresh!: (value: Response) => void;
    const response = new Promise<Response>((resolve) => {
      finishRefresh = resolve;
    });
    world.script.refresh = () => response;
    const renewal = auth.accessToken(signal());
    const rejection = auth.invalidateAccessToken(accessToken);
    finishRefresh(
      Response.json(
        world.token({ access_token: 'rotated-access', refresh_token: 'rotated-refresh' }),
      ),
    );
    expect(await renewal).toBe('rotated-access');
    await rejection;
    expect(auth.status().status).toBe('connected');
    expect(await auth.accessToken(signal())).toBe('rotated-access');
  });

  it('completes synthetic OAuth through the real loopback listener when the environment allows sockets', async (context) => {
    const probe = await listenForWorkReviewCallback(async () => ({
      status: 200,
      message: '',
    })).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
      context.skip('The sandbox refuses loopback sockets.');
      return null;
    });
    if (!probe) return;
    await probe.close();

    const world = fixture(true);
    const auth = world.open();
    const authorize = await world.begin(auth);
    const response = await world.callback(authorize);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await response.text()).toContain('sign-in is complete');
    expect(auth.status().status).toBe('connected');
  });

  it('registers from the exact loopback callback and reuses the verified owner after restart', async () => {
    const world = fixture();
    const auth = world.open();
    expect(auth.status()).toMatchObject({ status: 'disconnected' });
    expect(world.storage).toBeNull();
    const authorize = await world.begin(auth);
    expect(auth.status()).toMatchObject({ status: 'pending' });
    expect(authorize.origin + authorize.pathname).toBe(
      'https://auth.openai.com/api/accounts/authorize',
    );
    expect(authorize.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(authorize.searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/,
    );
    expect(authorize.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('scope')?.split(' ')).toContain('chatgpt.tokens.use.direct');
    expect((await world.callback(authorize, { state: 'unrelated' })).status).toBe(400);
    expect(world.calls).toHaveLength(0);
    expect(auth.status()).toMatchObject({ status: 'pending' });
    const result = await world.callback(authorize);
    expect(result.status).toBe(200);
    expect(await result.text()).not.toContain(accessToken);
    expect(auth.status()).toEqual({
      status: 'connected',
      account: 'owner@example.test',
      message: null,
    });
    const grant = world.calls[0]!.params;
    expect(grant.get('resource')).toBe('https://api.openai.com/v1');
    expect(grant.get('client_id')).toBe(clientId);
    expect(grant.get('redirect_uri')).toBe(authorize.searchParams.get('redirect_uri'));
    expect(grant.get('client_secret')).toBe(null);
    expect(createHash('sha256').update(grant.get('code_verifier')!).digest('base64url')).toBe(
      authorize.searchParams.get('code_challenge'),
    );
    await auth.close();
    const restart = world.open();
    expect(await restart.accessToken(signal())).toBe(accessToken);
    const next = await world.begin(restart);
    expect(next.searchParams.get('client_id')).toBe(clientId);
    expect(next.searchParams.get('ext_agent_host_id')).toBe(
      authorize.searchParams.get('ext_agent_host_id'),
    );
    expect(next.searchParams.has('id_token_hint')).toBe(false);
    expect(next.searchParams.has('agent_name_hint')).toBe(false);
    expect(next.searchParams.get('state')).not.toBe(authorize.searchParams.get('state'));
  });

  it('keeps identity after plan consent is missing and consumes denial or expiration without an exchange', async () => {
    const world = fixture();
    world.script.code = async () => Response.json(world.token({ scope: 'openid offline_access' }));
    const auth = world.open();
    const attempt = await world.begin(auth);
    expect((await world.callback(attempt)).status).toBe(200);
    expect(auth.status().status).toBe('needs_consent');
    await expect(auth.accessToken(signal())).rejects.toThrow('Enable ChatGPT plan usage');

    const consent = await world.begin(auth);
    expect(consent.searchParams.get('prompt')).toBe('consent');
    const denial = await world.callback(consent, {
      error: 'access_denied',
      error_description: 'sensitive-message',
    });
    expect(denial.status).toBe(400);
    expect(await denial.text()).not.toContain('sensitive-message');
    expect(auth.status()).toMatchObject({
      status: 'needs_consent',
      message: 'ChatGPT did not grant access.',
    });
    const expired = await world.begin(auth);
    world.advance(5 * 60 * 1000);
    const result = await world.callback(expired);
    expect(result.status).toBe(400);
    expect(await result.text()).toContain('expired');
    expect(world.calls.map(({ url }) => url)).toEqual([
      WORK_REVIEW_TOKEN_URL,
      WORK_REVIEW_JWKS_URL,
    ]);
  });

  it.each(['nonce', 'aud', 'signature'])(
    'rejects an untrusted ID token (%s) without persisting the grant',
    async (failure) => {
      const world = fixture();
      world.script.code = async () => {
        const claims =
          failure === 'nonce'
            ? { nonce: 'unrelated' }
            : failure === 'aud'
              ? { aud: 'different-client' }
              : {};
        const signedToken = world.signed(claims);
        return Response.json(
          world.token({
            id_token:
              failure === 'signature'
                ? signedToken.replace(/[^.]+$/, 'bad-signature')
                : signedToken,
          }),
        );
      };
      const auth = world.open();
      const result = await world.callback(await world.begin(auth));
      expect(result.status).toBe(400);
      expect(auth.status().status).toBe('disconnected');
      expect(world.storage).not.toContain(refreshToken);
      expect(world.calls.at(-1)?.params.get('token')).toBe(refreshToken);
    },
  );

  it('serializes refreshing and revokes the replacement after denying access during disconnect', async () => {
    const world = fixture();
    const auth = world.open();
    await world.callback(await world.begin(auth));
    world.advance(3600 * 1000 + 1);
    let resume!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resume = resolve;
    });
    world.script.refresh = () => gate;
    const first = auth.accessToken(signal()).catch((err: unknown) => err);
    const second = auth.accessToken(signal()).catch((err: unknown) => err);
    expect(
      world.calls.filter(({ params }) => params.get('grant_type') === 'refresh_token'),
    ).toHaveLength(1);

    let cancelled = false;
    const disconnect = auth.disconnect(async () => {
      expect(auth.status().status).toBe('disconnected');
      await expect(auth.accessToken(signal())).rejects.toThrow('Sign in with ChatGPT');
      cancelled = true;
    });
    resume(
      Response.json(
        world.token({ access_token: 'rotated-access', refresh_token: 'rotated-refresh' }),
      ),
    );
    expect(await first).toBeInstanceOf(Error);
    expect(await second).toBeInstanceOf(Error);
    expect(await disconnect).toMatchObject({ status: 'disconnected' });
    expect(cancelled).toBe(true);
    expect(world.calls.at(-1)?.url).toBe(WORK_REVIEW_REVOKE_URL);
    expect(world.calls.at(-1)?.params.get('token')).toBe('rotated-refresh');
    expect(world.storage).not.toContain('rotated-refresh');
    expect(world.storage).toContain(clientId);
    await auth.reset();
    expect(world.storage).toBeNull();
  });

  it('clears rejected refresh credentials but keeps the registration for sign-in', async () => {
    const world = fixture();
    const auth = world.open();
    await world.callback(await world.begin(auth));
    world.advance(3600 * 1000 + 1);
    world.script.refresh = async () =>
      Response.json({ error: 'invalid_grant', details: refreshToken }, { status: 400 });
    await expect(auth.accessToken(signal())).rejects.toThrow('expired');
    expect(auth.status()).toMatchObject({ status: 'disconnected' });
    expect(world.storage).not.toContain(refreshToken);
    const next = await world.begin(auth);
    expect(next.searchParams.get('client_id')).toBe(clientId);
  });
});
