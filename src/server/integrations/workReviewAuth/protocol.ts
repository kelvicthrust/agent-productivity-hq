import { createHash, createPublicKey, verify } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { NetFetch } from '../../collectors/github/ports.ts';
import {
  WORK_REVIEW_JWKS_URL,
  WORK_REVIEW_REVOKE_URL,
  WORK_REVIEW_TOKEN_URL,
} from '../../lib/net.ts';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const INVOKE_SCOPE = 'resource.invoke';
const SCOPES = ['openid', 'profile', 'email', 'offline_access', INVOKE_SCOPE, PLAN_SCOPE];
const MAX_AUTH_RESPONSE_BYTES = 64 * 1024;

export const ClientId = z.string().regex(/^oaiapp_[A-Za-z0-9_-]{1,150}$/);
const OpaqueToken = z
  .string()
  .min(1)
  .max(16 * 1024)
  .regex(/^[\x21-\x7e]+$/);
const EpochMs = z.int().positive();
const VerifiedEmail = z.email().max(254);
export const Profile = z.strictObject({
  clientId: ClientId,
  subject: z.string().min(1).max(255),
  email: VerifiedEmail.nullable(),
});
export type Profile = z.infer<typeof Profile>;

export const Credentials = z.strictObject({
  access: OpaqueToken,
  refresh: OpaqueToken.nullable(),
  accessExpiresAt: EpochMs,
  refreshExpiresAt: EpochMs,
  scopes: z.array(z.string().max(100)).max(30),
});
export type Credentials = z.infer<typeof Credentials>;

const TokenResponse = z.object({
  access_token: OpaqueToken,
  refresh_token: OpaqueToken.optional(),
  id_token: OpaqueToken.optional(),
  token_type: z.string().refine((type) => type.toLowerCase() === 'bearer'),
  expires_in: z
    .int()
    .positive()
    .max(24 * 3600),
  scope: z.string().max(2048),
});

const TERMINAL_REFRESH = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
  'invalid_client',
]);

export class WorkReviewAuthError extends Error {
  readonly code = 'unavailable';
  readonly terminal: boolean;
  readonly invalidGrant: boolean;
  constructor(
    message = 'Sign in with ChatGPT to generate a Work Review.',
    terminal = false,
    invalidGrant = false,
  ) {
    super(message);
    this.name = 'WorkReviewAuthError';
    this.terminal = terminal;
    this.invalidGrant = invalidGrant;
  }
}

export function canUsePlan(credentials: Credentials): boolean {
  return credentials.scopes.includes(PLAN_SCOPE) && credentials.scopes.includes(INVOKE_SCOPE);
}

export function authorizationUrl(params: {
  profile: Profile | null;
  retryClientId: string | null;
  hostId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  verifier: string;
  consent: boolean;
}): string {
  const clientId = params.profile?.clientId ?? params.retryClientId;
  const query = new URLSearchParams({
    client_id: clientId ?? 'dynamic_agent_client',
    ext_agent_host_id: params.hostId,
    response_type: 'code',
    redirect_uri: params.redirectUri,
    scope: SCOPES.join(' '),
    resource: RESOURCE,
    state: params.state,
    nonce: params.nonce,
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(params.verifier).digest('base64url'),
  });
  if (clientId === null) query.set('agent_name_hint', 'Agent Productivity HQ');
  if (params.consent) query.set('prompt', 'consent');
  // The dashboard gives this URL to the owner for navigation. It contains no previous token or account hint.
  return `${ISSUER}/api/accounts/authorize?${query}`;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let bytes = 0;
  let finished = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        finished = true;
        break;
      }
      bytes += next.value.byteLength;
      if (bytes > MAX_AUTH_RESPONSE_BYTES) return null;
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return null;
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

const formHeaders = { 'Content-Type': 'application/x-www-form-urlencoded' };

async function grant(
  net: NetFetch,
  params: Record<string, string>,
  now: () => number,
  signal: AbortSignal,
): Promise<{ credentials: Credentials; idToken: string | undefined }> {
  const response = await net(WORK_REVIEW_TOKEN_URL, {
    method: 'POST',
    headers: formHeaders,
    body: new URLSearchParams({ resource: RESOURCE, ...params }).toString(),
    signal,
  });
  const raw = await boundedJson(response);
  if (response.status !== 200) {
    const result = z.object({ error: z.string().max(100) }).safeParse(raw);
    const code = result.success ? result.data.error : null;
    const terminal = code !== null && TERMINAL_REFRESH.has(code);
    throw new WorkReviewAuthError(
      terminal
        ? 'ChatGPT sign-in has expired. Sign in again.'
        : 'ChatGPT could not finish authorizing Work Review. Try again.',
      terminal,
      code === 'invalid_grant',
    );
  }
  const token = TokenResponse.safeParse(raw);
  if (!token.success || (params['grant_type'] === 'refresh_token' && !token.data.refresh_token))
    throw new WorkReviewAuthError('ChatGPT did not return a usable connection. Sign in again.');
  const savedAt = now();
  return {
    credentials: {
      access: token.data.access_token,
      refresh: token.data.refresh_token ?? null,
      accessExpiresAt: savedAt + token.data.expires_in * 1000,
      refreshExpiresAt: savedAt + 30 * 24 * 3600 * 1000,
      scopes: token.data.scope.split(/\s+/).filter(Boolean),
    },
    idToken: token.data.id_token,
  };
}

const JwtHeader = z.object({
  alg: z.literal('RS256'),
  kid: z.string().min(1).max(255),
  crit: z.never().optional(),
});
const JwtClaims = z.object({
  iss: z.literal(ISSUER),
  aud: z.union([z.string(), z.array(z.string()).min(1)]),
  azp: z.string().optional(),
  sub: Profile.shape.subject,
  nonce: z.string(),
  exp: z.int(),
  iat: z.int(),
  nbf: z.int().optional(),
  email: z.unknown().optional(),
  email_verified: z.unknown().optional(),
});
const Base64Url = /^[A-Za-z0-9_-]+$/;
const RsaSigningKey = z.object({
  kid: z.string(),
  alg: z.literal('RS256').optional(),
  kty: z.literal('RSA'),
  use: z.literal('sig').optional(),
  key_ops: z.array(z.string()).optional(),
  n: z.string().regex(Base64Url),
  e: z.string().regex(Base64Url),
});

function decode(tokenPart: string): unknown {
  try {
    if (!Base64Url.test(tokenPart)) return null;
    return JSON.parse(Buffer.from(tokenPart, 'base64url').toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

/** Verify the one ID-token algorithm advertised by OpenAI's OIDC discovery with Node's RSA verifier. */
async function verifyIdentity(
  net: NetFetch,
  token: string,
  clientId: string,
  nonce: string,
  now: () => number,
  signal: AbortSignal,
): Promise<Profile> {
  const invalid = () =>
    new WorkReviewAuthError('ChatGPT identity could not be verified. Sign in again.');
  const parts = token.split('.');
  if (parts.length !== 3) throw invalid();
  const [head, body, signature] = parts as [string, string, string];
  const header = JwtHeader.safeParse(decode(head));
  if (!header.success || !Base64Url.test(signature)) throw invalid();
  const response = await net(WORK_REVIEW_JWKS_URL, { signal });
  const raw = await boundedJson(response);
  const jwks = z.object({ keys: z.array(z.unknown()).max(100) }).safeParse(raw);
  if (response.status !== 200 || !jwks.success) throw invalid();
  const matches = jwks.data.keys.flatMap((rawKey) => {
    const key = RsaSigningKey.safeParse(rawKey);
    return key.success &&
      key.data.kid === header.data.kid &&
      (!key.data.key_ops || key.data.key_ops.includes('verify'))
      ? [key.data]
      : [];
  });
  if (matches.length !== 1) throw invalid();
  const { n, e } = matches[0]!;
  try {
    const key = createPublicKey({ format: 'jwk', key: { kty: 'RSA', n, e } });
    if (
      !verify(
        'RSA-SHA256',
        Buffer.from(`${head}.${body}`),
        key,
        Buffer.from(signature, 'base64url'),
      )
    )
      throw invalid();
  } catch {
    throw invalid();
  }
  const claims = JwtClaims.safeParse(decode(body));
  if (!claims.success) throw invalid();
  const { aud, azp, exp, iat, nbf, sub, email, email_verified } = claims.data;
  const audiences = typeof aud === 'string' ? [aud] : aud;
  const second = Math.floor(now() / 1000);
  if (
    claims.data.nonce !== nonce ||
    !audiences.includes(clientId) ||
    ((audiences.length > 1 || azp !== undefined) && azp !== clientId) ||
    exp <= second - 5 ||
    exp <= iat ||
    iat > second + 5 ||
    (nbf !== undefined && nbf > second + 5)
  )
    throw invalid();
  return {
    clientId,
    subject: sub,
    email: email_verified === true ? (VerifiedEmail.safeParse(email).data ?? null) : null,
  };
}

export async function exchangeCode(
  net: NetFetch,
  params: {
    clientId: string;
    code: string;
    verifier: string;
    redirectUri: string;
    nonce: string;
    profile: Profile | null;
    now: () => number;
    signal: AbortSignal;
  },
): Promise<{ credentials: Credentials; profile: Profile }> {
  const { credentials, idToken } = await grant(
    net,
    {
      grant_type: 'authorization_code',
      code: params.code,
      client_id: params.clientId,
      code_verifier: params.verifier,
      redirect_uri: params.redirectUri,
    },
    params.now,
    params.signal,
  );
  try {
    if (!idToken)
      throw new WorkReviewAuthError('ChatGPT identity could not be verified. Sign in again.');
    const profile = await verifyIdentity(
      net,
      idToken,
      params.clientId,
      params.nonce,
      params.now,
      params.signal,
    );
    if (params.profile && profile.subject !== params.profile.subject)
      throw new WorkReviewAuthError(
        'Open the original ChatGPT account, or choose to connect a different account.',
      );
    return { credentials, profile };
  } catch (error) {
    if (credentials.refresh) await revokeGrant(net, params.clientId, credentials.refresh);
    throw error;
  }
}

export async function refreshGrant(
  net: NetFetch,
  clientId: string,
  refresh: string,
  now: () => number,
  signal: AbortSignal,
): Promise<Credentials> {
  const result = await grant(
    net,
    {
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refresh,
    },
    now,
    signal,
  );
  return result.credentials;
}

export async function revokeGrant(
  net: NetFetch,
  clientId: string,
  token: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await net(WORK_REVIEW_REVOKE_URL, {
        method: 'POST',
        headers: formHeaders,
        body: new URLSearchParams({
          client_id: clientId,
          token,
          token_type_hint: 'refresh_token',
        }).toString(),
        signal: AbortSignal.timeout(2500),
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 200) return true;
      if (response.status < 500) return false;
    } catch {
      // Retry a transient failure once while the refresh token is still available in memory.
    }
    if (attempt === 0) await delay(200);
  }
  return false;
}
