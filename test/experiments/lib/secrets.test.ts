import { describe, expect, it } from 'vitest';
import {
  assertNoSecrets,
  findSecrets,
  LeakError,
  withholdSecrets,
} from '../../../scripts/experiments/lib/secrets.ts';

const A = 'A'.repeat(36);

describe('secret patterns', () => {
  it.each([
    ['github-token', `ghp_${A}`],
    ['github-token', `gho_${A}`],
    ['github-token', `ghr_${A}`],
    ['github-fine-grained-token', `github_pat_${A}_${A}`],
    ['api-key', `sk-ant-${A}`],
    ['bearer-token', 'Bearer abcdefghijklmnop'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV'],
    ['private-key', '-----BEGIN RSA PRIVATE KEY-----'],
    ['authorization-header', 'Authorization: token something'],
    ['oauth-token-value', '"refresh_token":"abcdefghijklmnop1234"'],
  ])('finds a %s', (name, text) => {
    expect(findSecrets(`before ${text} after`).map((m) => m.name)).toContain(name);
  });

  it('leaves field names, versions, hashes and fixture sentinels alone', () => {
    for (const text of [
      'fields: access_token, refresh_token, authorization',
      'access_token: string',
      'Claude Code 2.1.0 on darwin arm64',
      'commit 3f786850e387550fdab836ed7e6dc881de23001b',
      'SENTINEL_TOKEN_0a1b2c3d',
      'sk-short',
      'PASS  reconcile-three-sessions: 3 of 3 sessions match',
    ]) {
      expect(findSecrets(text), text).toEqual([]);
    }
  });

  it('refuses a leak without repeating it', () => {
    let error: unknown;
    try {
      assertNoSecrets(`token ghp_${A}`, 'print this line');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(LeakError);
    expect((error as LeakError).kinds).toEqual(['github-token']);
    expect((error as LeakError).message).not.toContain(A);
    expect((error as LeakError).message).toContain('print this line');
  });

  it('can mask a message for an error line', () => {
    const masked = withholdSecrets(`failed with ghp_${A} and Bearer abcdefghijkl`);
    expect(masked).not.toContain(A);
    expect(masked).not.toContain('abcdefghijkl');
    expect(masked).toContain('[withheld]');
  });
});
