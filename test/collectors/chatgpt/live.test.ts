import { chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createChatgptAdapter } from '../../../src/server/collectors/chatgpt/collector.ts';
import { createLiveLauncher } from '../../../src/server/collectors/chatgpt/live.ts';
import { openSession } from '../../../src/server/collectors/chatgpt/rpc.ts';
import { startChatgptLogin } from '../../../src/server/collectors/chatgpt/login.ts';
import {
  readAccountSnapshot,
  readDailyTokenSpan,
} from '../../../src/server/db/queries/accounts.ts';
import { tempDir } from '../../server/helpers.ts';
import { SENTINEL, codexSession, everything, nameOf, world } from './helpers.ts';

// G9_2 and G9_3 for real: the live launcher starts a child process, talks to it over a pipe and kills it. The stand-in is
// test/fixtures/appserver/fake-codex.ts (the E4 self-test's), started as `node <file> app-server` with no shell. Nothing here
// reaches Codex, a network or a browser.

const FIXTURES = resolve(import.meta.dirname, '../../fixtures/appserver');
const FAKE = join(FIXTURES, 'fake-codex.ts');

const standIn = (scenario: string, args: readonly string[] = [FAKE, 'app-server']) =>
  createLiveLauncher({
    program: process.execPath,
    args,
    env: { ...process.env, FAKE_CODEX_SCENARIO: join(FIXTURES, `${scenario}.json`) },
  });

/** The adapter over a real child, with the database and context the scripted world builds. */
function withLive(scenario: string, options: { callTimeoutMs?: number } = {}) {
  const w = world(null);
  const adapter = createChatgptAdapter({ launch: standIn(scenario), ...options });
  return { w, refresh: () => adapter.refresh(w.context) };
}

describe('the live launcher over a real child process', () => {
  it('reads a whole account through real pipes and stores what the scripted read stores', async () => {
    const { w, refresh } = withLive('chatgpt-with-threads');
    const id = codexSession(w.db, 'codex-thread-aaa');
    expect(await refresh()).toEqual({ result: 'succeeded' });
    expect(readAccountSnapshot(w.db, 'chatgpt').lifetimeTokens?.value).toBe(123456);
    expect(readAccountSnapshot(w.db, 'chatgpt').rateLimits).toHaveLength(2);
    expect(readDailyTokenSpan(w.db, 'chatgpt')).toMatchObject({
      first: '2026-11-01',
      last: '2026-11-07',
      days: 7,
    });
    expect(nameOf(w.db, id).name).toBe('Fix the login redirect');
    expect(everything(w.db)).not.toMatch(SENTINEL);
  });

  it('answers null, not an error, when there is no codex program', async () => {
    expect(await createLiveLauncher({ program: join(tempDir(), 'no-such-codex') })()).toBeNull();
    const w = world(null);
    const adapter = createChatgptAdapter({
      launch: createLiveLauncher({ program: join(tempDir(), 'no-such-codex') }),
    });
    expect(await adapter.refresh(w.context)).toMatchObject({ result: 'skipped' });
  });

  it('rejects with the system error code for a program that exists but cannot be run', async () => {
    const file = join(tempDir(), 'not-executable');
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, 0o644);
    await expect(createLiveLauncher({ program: file })()).rejects.toMatchObject({ code: 'EACCES' });
    const opened = await openSession(createLiveLauncher({ program: file }));
    expect(opened).toEqual({ kind: 'failed', why: 'error', code: 'EACCES' });
  });

  it('a call the child never answers ends at the call’s own limit, and the attempt is partial, with the child stopped', async () => {
    const { w, refresh } = withLive('usage-silent', { callTimeoutMs: 300 });
    const started = Date.now();
    const report = await refresh();
    expect(report).toMatchObject({ result: 'partial' });
    // initialize, account/read and the rate limits answer at once; only the usage call waits out its 300 ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(readAccountSnapshot(w.db, 'chatgpt').rateLimits).toHaveLength(2);
  });

  it('a child that ends in the middle of a read is a failed attempt that kept the last report', async () => {
    const { w, refresh } = withLive('crash');
    expect(await refresh()).toMatchObject({ result: 'failed', errorCode: 'appserver_closed' });
    expect(readAccountSnapshot(w.db, 'chatgpt').fetchedAt).toBeNull();
  });

  it('a program that stops at once (wrong arguments) is a failed attempt, not a hang', async () => {
    const w = world(null);
    const adapter = createChatgptAdapter({
      launch: standIn('signed-in', [FAKE, 'not-app-server']),
    });
    expect(await adapter.refresh(w.context)).toMatchObject({
      result: 'failed',
      errorCode: 'appserver_closed',
    });
  });

  it('kill() stops the child: its output ends and nothing more is read', async () => {
    const child = await standIn('signed-in')();
    expect(child).not.toBeNull();
    child!.send(JSON.stringify({ id: 1, method: 'initialize', params: {} }));
    const first = await child!.nextLine(5000);
    expect(first.kind).toBe('line');
    child!.kill();
    child!.kill();
    // Drain what the child had already written; then the pipe ends.
    let last = await child!.nextLine(5000);
    for (let i = 0; i < 10 && last.kind === 'line'; i++) last = await child!.nextLine(5000);
    expect(last.kind).toBe('closed');
    // Writes after the end are dropped without throwing.
    expect(() => child!.send('{"id":2}')).not.toThrow();
  });

  it('kills a child that ignores SIGTERM after a short grace', async () => {
    const launch = createLiveLauncher({
      program: process.execPath,
      // Says "ready" once its SIGTERM handler is in place, so the test cannot kill it before it ignores the signal.
      args: [
        '-e',
        "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
      ],
    });
    const child = await launch();
    expect(child).not.toBeNull();
    expect(await child!.nextLine(8000)).toEqual({ kind: 'line', line: 'ready' });
    const killedAt = Date.now();
    child!.kill();
    expect((await child!.nextLine(8000)).kind).toBe('closed');
    // SIGTERM did nothing, so it took the grace period (2 s) and a SIGKILL.
    expect(Date.now() - killedAt).toBeGreaterThanOrEqual(1500);
  });

  it('starts a sign-in on a real child and ends it when the sign-in completes', async () => {
    const started = await startChatgptLogin(standIn('login-ok'));
    if (started.kind !== 'started') throw new Error(started.kind);
    expect(started.flow.authUrl).toMatch(/^https:\/\//);
    expect(await started.flow.done).toBe('connected');
  });

  it('cancelling a sign-in on a real child ends it as cancelled', async () => {
    // Without the completion notification the child waits for the browser.
    const launch = createLiveLauncher({
      program: process.execPath,
      args: [
        '-e',
        `const rl = require('readline').createInterface({ input: process.stdin });
         rl.on('line', (l) => { const m = JSON.parse(l); if (m.id === undefined) return;
           const result = m.method === 'account/read' ? { account: null }
             : m.method === 'account/login/start' ? { type: 'chatgpt', loginId: 'x', authUrl: 'https://auth.example.test/' } : {};
           process.stdout.write(JSON.stringify({ id: m.id, result }) + '\\n'); });`,
      ],
    });
    const started = await startChatgptLogin(launch);
    if (started.kind !== 'started') throw new Error(started.kind);
    started.flow.cancel();
    expect(await started.flow.done).toBe('cancelled');
  });
});

// The only file that starts a program for this integration is collectors/chatgpt/live.ts: argument array, no shell. Everything else
// takes the port. (The GitHub integration has its own live.ts, with `gh`; it is not part of this one.)
describe('where a program is started', () => {
  const SRC = resolve(import.meta.dirname, '../../../src/server');
  const mine = [
    ...readdirSync(join(SRC, 'collectors/chatgpt')).map((f) => join(SRC, 'collectors/chatgpt', f)),
    join(SRC, 'collectors/codex/names.ts'),
    join(SRC, 'services/accounts.ts'),
    join(SRC, 'http/routes/accounts.ts'),
  ];
  const read = (file: string) => readFileSync(file, 'utf8');
  const code = (file: string) =>
    read(file)
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');

  it('only live.ts imports child_process, and only to spawn', () => {
    const importers = mine.filter((file) => /child_process/.test(code(file)));
    expect(importers.map((file) => relative(SRC, file))).toEqual(['collectors/chatgpt/live.ts']);
    const live = code(join(SRC, 'collectors/chatgpt/live.ts'));
    expect(live).toMatch(/import \{ spawn, type ChildProcess \} from 'node:child_process'/);
    for (const forbidden of [/\bexec\(/, /\bexecSync\(/, /\bexecFile/, /\bfork\(/, /spawnSync/]) {
      expect(live).not.toMatch(forbidden);
    }
  });

  it('starts the program with an argument array and no shell option', () => {
    const live = code(join(SRC, 'collectors/chatgpt/live.ts'));
    expect(live).toMatch(/spawn\(program, \[\.\.\.args\], \{/);
    expect(live).not.toMatch(/\bshell\b/);
  });

  it('nothing else here calls fetch or any process or network API', () => {
    for (const file of mine) {
      const text = code(file);
      expect(text, relative(SRC, file)).not.toMatch(
        /\bfetch\(|node:http|node:https|node:net'|undici|axios/,
      );
      if (!file.endsWith('chatgpt/live.ts'))
        expect(text, relative(SRC, file)).not.toMatch(/\bspawn\b|process\.env/);
    }
  });
});
