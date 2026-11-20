import { execFile } from 'node:child_process';
import { Entry } from '@napi-rs/keyring';
import { createNet } from '../../lib/net.ts';
import type { GhRunner, GithubDeps, Keyring } from './ports.ts';

// The LIVE side of the three GitHub ports (collectors/github/ports.ts). `pnpm start` hands these to boot; the preview command and
// every test hand the scripted ones from test/fixtures/github instead, so nothing but the real app ever reaches GitHub, this Mac's
// GitHub's Keychain entry or the `gh` program. This file is the only one that starts `gh`.
//
//   net      lib/net.ts over the global fetch: https only, api.github.com and the two device-flow paths, no redirects
//   keyring  the macOS Keychain through @napi-rs/keyring (service `agent-productivity`, account `github-app-user-token`, chosen by
//            the callers); a refused or locked Keychain throws, and the account service says so in words
//   gh       `gh auth token` run with an argument array and no shell; the token is returned to the caller and goes nowhere else

/** What one Keychain item offers (the shape of @napi-rs/keyring's `Entry`), so a test can stand in for it. */
export interface KeychainItem {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

export type OpenKeychainItem = (service: string, account: string) => KeychainItem;

const nativeItem: OpenKeychainItem = (service, account) => new Entry(service, account);

/** The Keychain as the `Keyring` port: one item per (service, account). Errors from the store are thrown as they come. */
export function createKeychain(open: OpenKeychainItem = nativeItem): Keyring {
  return {
    get: (service, account) => open(service, account).getPassword(),
    set: (service, account, secret) => {
      open(service, account).setPassword(secret);
    },
    delete: (service, account) => open(service, account).deletePassword(),
  };
}

/** Runs a program with an argument array (no shell) and answers its standard output, or null when it did not succeed. */
export type RunProgram = (program: string, args: readonly string[]) => Promise<string | null>;

const GH_TIMEOUT_MS = 5000;
const GH_MAX_OUTPUT = 64 * 1024;

const runProgram: RunProgram = (program, args) =>
  new Promise((resolve) => {
    // execFile never starts a shell. Not installed, not signed in, a timeout or too much output: all of them are "no token".
    execFile(
      program,
      [...args],
      { timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_OUTPUT, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });

/** `gh auth token --hostname github.com`: the trimmed token, or null. The token is never logged or stored here. */
export function createGhRunner(run: RunProgram = runProgram): GhRunner {
  return async () => {
    const out = await run('gh', ['auth', 'token', '--hostname', 'github.com']);
    const token = out?.trim() ?? '';
    // One line of printable characters: anything else (a prompt, a warning, an empty answer) is not a token.
    return token !== '' && /^[\x21-\x7e]+$/.test(token) ? token : null;
  };
}

/** The three ports, for real. */
export function createLiveGithub(): GithubDeps {
  return { net: createNet(), keyring: createKeychain(), gh: createGhRunner() };
}
