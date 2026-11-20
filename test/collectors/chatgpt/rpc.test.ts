import { describe, expect, it } from 'vitest';
import {
  CALL_TIMEOUT_MS,
  createSession,
  failureOf,
  openSession,
} from '../../../src/server/collectors/chatgpt/rpc.ts';
import { loadScenario, scriptedAppServer, withMethods } from './scripted.ts';

// The client's half of JSON-RPC over the app-server's stdio (G9_2, G9_3): `initialize` then `initialized`, 10 seconds per call, the
// child killed when the caller is done, and no sentence of the app-server's kept.

describe('opening a session', () => {
  it('sends initialize, waits for its answer, then sends the initialized notification, in that order', async () => {
    const app = scriptedAppServer(loadScenario('signed-in'));
    const opened = await openSession(app.launch, { clientVersion: '1.2.3' });
    expect(opened.kind).toBe('ready');
    const child = app.children[0]!;
    expect(child.methods()).toEqual(['initialize', 'initialized']);
    // initialize is a request (it has an id); initialized is a notification (it has none).
    expect(child.received[0]).toMatchObject({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'agent-productivity', version: '1.2.3' } },
    });
    expect(child.received[1]?.id).toBeUndefined();
    expect(child.killed).toBe(false);
    if (opened.kind === 'ready') opened.session.close();
    expect(child.killed).toBe(true);
  });

  it('is absent, not an error, when there is no codex to start', async () => {
    const app = scriptedAppServer(null);
    expect(await openSession(app.launch)).toEqual({ kind: 'absent' });
    expect(app.launches()).toBe(1);
  });

  it('is failed with the system error code, and no message, when the program cannot be started', async () => {
    const app = scriptedAppServer(loadScenario('signed-in'), { failWith: 'EACCES' });
    expect(await openSession(app.launch)).toEqual({ kind: 'failed', why: 'error', code: 'EACCES' });
  });

  it('kills the child when initialize is not answered, answered with an error, or the child ends', async () => {
    for (const [initialize, why] of [
      ['silent', 'timeout'],
      ['exit', 'closed'],
      [{ error: { code: -32600, message: 'SENTINEL_NOTE_x nope' } }, 'error'],
    ] as const) {
      const app = scriptedAppServer(withMethods(loadScenario('signed-in'), { initialize }));
      const opened = await openSession(app.launch);
      expect(opened, why).toEqual({ kind: 'failed', why });
      expect(app.children[0]?.killed, why).toBe(true);
      // `initialized` is only sent after a good answer.
      expect(app.children[0]?.methods(), why).toEqual(['initialize']);
    }
  });
});

describe('a call', () => {
  async function ready(scenario = loadScenario('signed-in')) {
    const app = scriptedAppServer(scenario);
    const opened = await openSession(app.launch);
    if (opened.kind !== 'ready') throw new Error('not ready');
    return { app, child: app.children[0]!, session: opened.session };
  }

  it('gets its own answer and skips the notification the app-server sends before every answer', async () => {
    const { session } = await ready();
    const reply = await session.call('account/read', { refreshToken: false });
    expect(reply.kind).toBe('result');
    expect(JSON.stringify(reply)).not.toContain('SENTINEL_NOTE');
  });

  it('waits at most 10 seconds for an answer', async () => {
    expect(CALL_TIMEOUT_MS).toBe(10_000);
    const { child, session } = await ready(loadScenario('usage-silent'));
    const reply = await session.call('account/usage/read', {});
    expect(reply).toEqual({ kind: 'timeout' });
    // Every wait the client asked for on that call is within the limit.
    expect(Math.max(...child.waits)).toBeLessThanOrEqual(10_000);
    expect(child.waits.at(-1)).toBeGreaterThan(0);
  });

  it('keeps an error as its numeric code and one yes/no, and drops the sentence', async () => {
    const { session } = await ready(loadScenario('auth-error'));
    const reply = await session.call('account/usage/read', {});
    expect(reply).toEqual({ kind: 'error', code: -32603, auth: true });
    expect(JSON.stringify(reply)).not.toMatch(/SENTINEL|Unauthorized/);

    const plain = await (
      await ready(
        withMethods(loadScenario('signed-in'), {
          'account/usage/read': {
            error: { code: -32600, message: 'SENTINEL_NOTE_a91c02: usage needs a ChatGPT sign-in' },
          },
        }),
      )
    ).session.call('account/usage/read', {});
    expect(plain).toEqual({ kind: 'error', code: -32600, auth: false });
  });

  it('is a closed reply when the child ends, and a method the app-server does not know is an error reply', async () => {
    const crashed = await ready(loadScenario('crash'));
    expect(await crashed.session.call('account/usage/read', {})).toEqual({ kind: 'closed' });
    const { session } = await ready();
    expect(await session.call('no/such/method', {})).toMatchObject({ kind: 'error', code: -32601 });
  });

  it('answers a request the app-server makes of the client with "method not found" so it never waits on us', async () => {
    const { child, session } = await ready();
    child.emit({ id: 'srv-1', method: 'item/commandExecution/requestApproval', params: {} });
    const reply = await session.call('account/read', {});
    expect(reply.kind).toBe('result');
    expect(child.received.some((m) => m.id === 'srv-1' && !m.method)).toBe(true);
  });

  it('ignores lines that are not JSON-RPC and answers for other ids', async () => {
    const { child, session } = await ready();
    child.emit('not json at all');
    child.emit({ id: 999, result: { stray: true } });
    child.emit([1, 2]);
    const reply = await session.call('account/read', {});
    expect(reply.kind).toBe('result');
    expect(JSON.stringify(reply)).not.toContain('stray');
  });

  it('stops listening after 500 lines that are not the answer', async () => {
    const { child, session } = await ready(
      withMethods(loadScenario('signed-in'), { 'account/read': 'silent' }),
    );
    for (let i = 0; i < 600; i++) child.emit({ method: 'noise', params: { i } });
    expect(await session.call('account/read', {})).toEqual({ kind: 'timeout' });
  });
});

describe('waiting for a notification', () => {
  it('returns the notification whose params are accepted and skips the others', async () => {
    const app = scriptedAppServer(loadScenario('login-ok'), { hold: true });
    const opened = await openSession(app.launch);
    if (opened.kind !== 'ready') throw new Error('not ready');
    const child = app.children[0]!;
    child.emit({ method: 'account/login/completed', params: { loginId: 'other', success: true } });
    child.emit({ method: 'account/updated', params: {} });
    child.emit({ method: 'account/login/completed', params: { loginId: 'mine', success: false } });
    const waited = await opened.session.waitForNotification(
      'account/login/completed',
      (params) => params['loginId'] === 'mine',
      60_000,
    );
    expect(waited).toEqual({ kind: 'notification', params: { loginId: 'mine', success: false } });
  });

  it('ends with timeout or closed, and close kills the child once', async () => {
    const app = scriptedAppServer(loadScenario('login-ok'));
    const opened = await openSession(app.launch);
    if (opened.kind !== 'ready') throw new Error('not ready');
    expect(await opened.session.waitForNotification('x', () => true, 5)).toEqual({
      kind: 'timeout',
    });
    opened.session.close();
    opened.session.close();
    expect(app.children[0]?.killed).toBe(true);
  });
});

describe('failureOf', () => {
  it('names why a reply is not a result', () => {
    expect(failureOf({ kind: 'result', result: 1 })).toBeNull();
    expect(failureOf({ kind: 'timeout' })).toBe('timeout');
    expect(failureOf({ kind: 'closed' })).toBe('closed');
    expect(failureOf({ kind: 'error', code: 1, auth: false })).toBe('error');
    expect(failureOf({ kind: 'error', code: 1, auth: true })).toBe('auth');
  });

  it('createSession keeps the per-call limit it is given', async () => {
    const app = scriptedAppServer(loadScenario('usage-silent'));
    const child = await app.launch();
    if (!child) throw new Error('no child');
    const session = createSession(child, 250);
    await session.call('account/usage/read', {});
    expect(Math.max(...app.children[0]!.waits)).toBeLessThanOrEqual(250);
  });
});
