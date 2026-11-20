import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createGhRunner,
  createKeychain,
  type KeychainItem,
} from '../../../src/server/collectors/github/live.ts';
import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE } from '../../../src/server/collectors/github/ports.ts';
import { abortableSleep } from '../../../src/server/lib/sleep.ts';
import { mintToken } from '../../fixtures/github/scripted-github.ts';

// The live ports (collectors/github/live.ts) on stand-ins: the real Keychain, the real `gh` and the real network are E6, on the
// owner's Mac. What can be proved here is what the wrappers ask for and what they refuse to pass on.

describe('the gh runner', () => {
  it('asks for `gh auth token --hostname github.com` as an argument array, and trims the answer', async () => {
    const token = mintToken('gho');
    const run = vi.fn(async () => `${token}\n`);
    expect(await createGhRunner(run)()).toBe(token);
    expect(run).toHaveBeenCalledExactlyOnceWith('gh', [
      'auth',
      'token',
      '--hostname',
      'github.com',
    ]);
  });

  it('answers null when gh is missing, signed out or prints something that is not a token', async () => {
    for (const out of [
      null,
      '',
      '   \n',
      'You are not logged in\nRun gh auth login',
      'two words',
      'tab\tseparated',
    ]) {
      expect(await createGhRunner(async () => out)(), JSON.stringify(out)).toBeNull();
    }
  });

  it('starts gh without a shell: execFile only, never exec, spawn or a shell option', () => {
    const text = readFileSync(
      join(import.meta.dirname, '../../../src/server/collectors/github/live.ts'),
      'utf8',
    );
    expect(text).toMatch(/\bexecFile\(/);
    expect(text).not.toMatch(/\bexec\(|\bspawn\(|\bexecSync\(|shell\s*:/);
  });
});

describe('the Keychain', () => {
  function fake() {
    const opened: [string, string][] = [];
    const store = new Map<string, string>();
    const open = (service: string, account: string): KeychainItem => {
      opened.push([service, account]);
      const key = `${service}/${account}`;
      return {
        getPassword: () => store.get(key) ?? null,
        setPassword: (password) => {
          store.set(key, password);
        },
        deletePassword: () => store.delete(key),
      };
    };
    return { open, opened, store };
  }

  it('reads, writes and deletes the one item it is asked about', () => {
    const { open, opened, store } = fake();
    const keychain = createKeychain(open);
    expect(keychain.get(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)).toBeNull();
    keychain.set(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, 'the secret');
    expect(store.get(`${KEYCHAIN_SERVICE}/${KEYCHAIN_ACCOUNT}`)).toBe('the secret');
    expect(keychain.get(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)).toBe('the secret');
    expect(keychain.delete(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)).toBe(true);
    expect(keychain.delete(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)).toBe(false);
    expect(new Set(opened.map((pair) => pair.join('/')))).toEqual(
      new Set([`${KEYCHAIN_SERVICE}/${KEYCHAIN_ACCOUNT}`]),
    );
    expect(KEYCHAIN_SERVICE).toBe('agent-productivity');
    expect(KEYCHAIN_ACCOUNT).toBe('github-app-user-token');
  });

  it('lets a refusing or locked Keychain throw, so the account service can say so', () => {
    const refusing = createKeychain(() => ({
      getPassword: () => {
        throw new Error('the keychain is locked');
      },
      setPassword: () => {
        throw new Error('denied');
      },
      deletePassword: () => {
        throw new Error('denied');
      },
    }));
    expect(() => refusing.get('s', 'a')).toThrowError(/locked/);
    expect(() => refusing.set('s', 'a', 'x')).toThrowError(/denied/);
    expect(() => refusing.delete('s', 'a')).toThrowError(/denied/);
  });
});

describe('the device-flow wait', () => {
  it('ends early when its signal aborts, and at once when it was aborted already', async () => {
    const stop = new AbortController();
    const started = Date.now();
    const waiting = abortableSleep(60_000, stop.signal);
    stop.abort();
    await waiting;
    await abortableSleep(60_000, AbortSignal.abort());
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('waits the time it was given', async () => {
    const started = Date.now();
    await abortableSleep(30);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });
});
