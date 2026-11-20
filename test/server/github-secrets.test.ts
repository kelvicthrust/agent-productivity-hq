import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE } from '../../src/server/collectors/github/ports.ts';
import { ConnectPollResponse, ConnectResponse } from '../../src/shared/contracts/accounts.ts';
import { NOW, tempConfig } from './helpers.ts';
import {
  CLIENT_ID,
  filesText,
  scriptedGithub,
  startWithGithub,
  type Started,
} from './github-boot.ts';

// G6_4 across the whole feature: connect through the device flow, add a repo, sync, refresh the App token, have the refresh
// refused, disconnect. Afterwards no token the scripted GitHub ever issued (and nothing token-shaped) is in any table, any file
// of the data folder (the database, its write-ahead log, the logs), the log lines or any API answer. The App token exists only in
// the in-memory Keychain, under its one fixed service and account.

const HOUR = 3_600_000;
const TOKEN_SHAPE = /\bgh[pousr]_[A-Za-z0-9]{8,}/;

function dump(db: DatabaseSync): string {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string;
  }[];
  return tables
    .map((t) => `${t.name} ${JSON.stringify(db.prepare(`SELECT * FROM "${t.name}"`).all())}`)
    .join('\n');
}

/** What a scan of `text` finds: tokens the scripted GitHub issued, and anything shaped like one. */
const leaks = (text: string, tokens: readonly string[]): string[] => [
  ...tokens.filter((token) => text.includes(token)).map(() => 'an issued token'),
  ...(TOKEN_SHAPE.test(text) ? ['a token-shaped value'] : []),
];

async function finishedFlow(s: Started, loginId: string) {
  for (let i = 0; i < 400; i += 1) {
    const poll = ConnectPollResponse.parse(
      (await s.send('GET', `/api/accounts/github/connect/${loginId}`)).json,
    );
    if (poll.state !== 'pending') return poll;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error('the sign-in did not finish');
}

describe('no GitHub token in SQLite, the data folder, the log or any response', () => {
  it('survives connect, add, sync, refresh, a refused refresh and disconnect', async () => {
    const clock = { now: NOW };
    const scripted = scriptedGithub(clock);
    scripted.github.installApp('kelvin');
    const s = await startWithGithub({
      config: tempConfig(),
      clock,
      scripted,
      ghSignedIn: false,
    });

    // 1. connect through the App's device flow (gh is signed out)
    expect((await s.send('PUT', '/api/accounts/github/app', { clientId: CLIENT_ID })).status).toBe(
      200,
    );
    const started = ConnectResponse.parse(
      (await s.send('POST', '/api/accounts/github/connect', {})).json,
    );
    expect(started.mode).toBe('device');
    expect((await finishedFlow(s, started.loginId as string)).state).toBe('connected');
    expect(s.keyring.snapshot()).toHaveLength(1);

    // 2. add a repo and let the first sync read it, as the App
    expect((await s.send('POST', '/api/repos', { input: 'kelvin/atlas-api' })).status).toBe(201);
    await s.untilBackfilled('kelvin/atlas-api');
    expect(s.db().prepare('SELECT COUNT(*) AS n FROM pull_request').get()).toEqual({ n: 3 });
    // the sync really used the App token, never gh's
    expect(scripted.github.requests.some((r) => r.token === 'app' && r.path === '/graphql')).toBe(
      true,
    );

    // 3. the access token is about to expire: the next sync refreshes it (refresh token, no client secret)
    const issuedBefore = scripted.github.issued.length;
    clock.now += 8 * HOUR - 60_000;
    expect((await s.refreshGithub()).state).toBe('succeeded');
    expect(scripted.github.issued.length).toBeGreaterThan(issuedBefore);
    expect(scripted.github.requests.some((r) => r.clientSecret)).toBe(false);

    // 4. GitHub refuses the next refresh: Reconnect needed, the Keychain entry is gone
    scripted.github.revokeRefreshTokens = true;
    clock.now += 9 * HOUR;
    const refused = await s.refreshGithub();
    expect(refused.state).toBe('failed');
    expect(s.keyring.snapshot()).toEqual([]);
    clock.now += 60_000;
    expect(
      ((await s.send('GET', '/api/sources')).json as { accounts: { status: string }[] }).accounts[0]
        ?.status,
    ).toBe('reconnect');

    // 5. connect again, then disconnect
    scripted.github.revokeRefreshTokens = false;
    const again = ConnectResponse.parse(
      (await s.send('POST', '/api/accounts/github/connect', {})).json,
    );
    expect((await finishedFlow(s, again.loginId as string)).state).toBe('connected');
    expect((await s.send('POST', '/api/accounts/github/disconnect', {})).status).toBe(200);
    expect(s.keyring.snapshot()).toEqual([]);

    // the double issued several tokens, the Keychain used the one fixed service and account
    const tokens = scripted.github.tokens;
    expect(tokens.length).toBeGreaterThanOrEqual(5);
    expect(
      s.keyring.calls.every(
        (c) => c.service === KEYCHAIN_SERVICE && c.account === KEYCHAIN_ACCOUNT,
      ),
    ).toBe(true);

    const tables = dump(s.db());
    await s.stop();
    expect(leaks(tables, tokens)).toEqual([]);
    expect(leaks(filesText(s.config.dataDir), tokens)).toEqual([]);
    expect(leaks(JSON.stringify(s.entries), tokens)).toEqual([]);
    expect(leaks(s.bodies.join('\n'), tokens)).toEqual([]);
  });

  it('is scanning something real: a token planted in a table, a file, a log line or a response is found (negative control)', async () => {
    const s = await startWithGithub();
    const planted = s.github.tokens[0] as string;
    // a database row
    s.db().prepare("INSERT INTO app_meta (key, value) VALUES ('leak', ?)").run(planted);
    expect(leaks(dump(s.db()), s.github.tokens)).toContain('an issued token');
    s.db().prepare("DELETE FROM app_meta WHERE key = 'leak'").run();
    // a file in the data folder
    const dir = mkdtempSync(join(tmpdir(), 'crew-scan-'));
    try {
      writeFileSync(join(dir, 'notes.txt'), `x ${planted} y`);
      expect(leaks(filesText(dir), s.github.tokens)).toContain('an issued token');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // a log line and a response body, and a token the double never issued is still caught by its shape
    expect(leaks(JSON.stringify({ msg: `failed with ${planted}` }), s.github.tokens)).toContain(
      'an issued token',
    );
    expect(leaks(`{"token":"ghu_${'a1B2c3D4'.repeat(4)}"}`, [])).toEqual(['a token-shaped value']);
    await s.stop();
  });
});
