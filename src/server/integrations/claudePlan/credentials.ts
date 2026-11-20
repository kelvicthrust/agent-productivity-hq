import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { AsyncEntry } from '@napi-rs/keyring';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const MAX_CREDENTIAL_BYTES = 64 * 1024;

export type CredentialResult =
  | { state: 'ok'; accessToken: string }
  | { state: 'signed_out' | 'credential_denied' | 'unsupported' | 'reconnect' | 'failed' };

export interface ClaudePlanProfile {
  key: string;
  directory: string;
  keychainService: string;
  keychainAccount: string | null;
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

export function claudePlanProfile(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform = process.platform,
): ClaudePlanProfile | null {
  const secureOverride = env['CLAUDE_SECURESTORAGE_CONFIG_DIR'];
  const override = secureOverride ?? env['CLAUDE_CONFIG_DIR'];
  // Transcript discovery also accepts lists of directories. A credential lookup needs exactly one profile.
  if (secureOverride === undefined && override?.includes(',')) return null;
  // An empty secure-storage override selects the default home. An empty config dir is cwd-relative.
  const selected =
    secureOverride === '' || override === undefined ? join(home, '.claude') : override;
  const normalized = selected.normalize('NFC');
  const directory = resolve(normalized);
  const keychainService = override
    ? `${KEYCHAIN_SERVICE}-${digest(normalized).slice(0, 8)}`
    : KEYCHAIN_SERVICE;
  const account = platform === 'darwin' ? keychainAccount(env['USER']) : null;
  return {
    key: digest(account === null ? directory : `${keychainService}\0${directory}\0${account}`),
    directory,
    keychainService,
    keychainAccount: account,
  };
}

type ReadKeychain = (service: string, account: string) => Promise<string | null>;
type ReadCredentialFile = (directory: string) => Promise<string | null>;

const readKeychain: ReadKeychain = (service, account) =>
  new AsyncEntry(service, account).getPassword();

function keychainAccount(configured?: string): string {
  let username = configured;
  if (!username) {
    try {
      username = userInfo().username;
    } catch {
      return 'claude-code-user';
    }
  }
  return /^[A-Za-z0-9._-]+$/.test(username) ? username : 'claude-code-user';
}

/** Open only the active profile's private native file. A symlink or an unsafe file is refused. */
const readCredentialFile: ReadCredentialFile = async (directory) => {
  let file;
  try {
    file = await open(
      join(directory, '.credentials.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > MAX_CREDENTIAL_BYTES ||
      (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))
    ) {
      throw new Error('Claude Code credential file is not private.');
    }
    const bytes = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, null);
      if (bytesRead === 0) return bytes.toString('utf8', 0, offset);
      offset += bytesRead;
    }
    throw new Error('Claude Code credential file is too large.');
  } finally {
    await file.close();
  }
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function subscriptionCredential(raw: string, now: number): CredentialResult {
  try {
    if (Buffer.byteLength(raw) > MAX_CREDENTIAL_BYTES) return { state: 'failed' };
    const saved = record(JSON.parse(raw));
    if (saved === null) return { state: 'failed' };
    if (!Object.hasOwn(saved, 'claudeAiOauth')) {
      return { state: Object.keys(saved).length === 0 ? 'signed_out' : 'unsupported' };
    }
    const oauth = record(saved['claudeAiOauth']);
    if (oauth === null) return { state: 'signed_out' };
    const token = oauth['accessToken'];
    if (typeof token !== 'string' || !/^sk-ant-oat[0-9]+-[A-Za-z0-9_-]+$/.test(token)) {
      return { state: 'unsupported' };
    }
    const expiresAt = oauth['expiresAt'];
    if (typeof expiresAt === 'number' && expiresAt <= now) return { state: 'reconnect' };
    return { state: 'ok', accessToken: token };
  } catch {
    return { state: 'failed' };
  }
}

export type ReadClaudePlanCredential = (
  profile: ClaudePlanProfile,
  now: number,
) => Promise<CredentialResult>;

export function createClaudePlanCredentialReader(
  options: {
    platform?: NodeJS.Platform;
    keychain?: ReadKeychain;
    file?: ReadCredentialFile;
  } = {},
): ReadClaudePlanCredential {
  const platform = options.platform ?? process.platform;
  const keychain = options.keychain ?? readKeychain;
  const file = options.file ?? readCredentialFile;

  return async (profile, now) => {
    if (platform === 'darwin') {
      try {
        const password = await keychain(
          profile.keychainService,
          profile.keychainAccount ?? keychainAccount(),
        );
        if (password !== null) return subscriptionCredential(password, now);
      } catch {
        return { state: 'credential_denied' };
      }
    }
    try {
      const password = await file(profile.directory);
      return password === null ? { state: 'signed_out' } : subscriptionCredential(password, now);
    } catch {
      return { state: 'credential_denied' };
    }
  };
}
