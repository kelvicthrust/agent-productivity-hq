import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ErrorEnvelope } from '../../src/shared/contracts/errors.ts';
import { ClaudeHooksStatus, HqResponse } from '../../src/shared/contracts/hq.ts';
import { TAILSCALE_LOGIN_HEADER } from '../../src/server/http/guards.ts';
import { createHookStore } from '../../src/server/services/hq/hookStore.ts';
import { rig } from '../claudeHooks/helpers.ts';
import { HOST, NOW, WRITE, call, testApp } from './helpers.ts';

const TOKEN = 'k'.repeat(43);
const AUTH = { ...WRITE, authorization: `Bearer ${TOKEN}` };
const event = (over: Record<string, unknown> = {}) => ({
  hook_event_name: 'PermissionRequest',
  session_id: 'sess-1',
  cwd: '/work/a',
  ...over,
});

function setup(options: { settings?: string | null; remote?: boolean } = {}) {
  const r = rig({ settings: options.settings === undefined ? '{"a":1}' : options.settings });
  const store = createHookStore({ now: () => NOW });
  const harness = testApp({
    claudeHooks: r.hooks,
    hookIngest: { store, token: TOKEN },
    ...(options.remote
      ? { remote: { host: 'box.example.ts.net', ownerLogin: 'me@example.com' } }
      : {}),
  });
  return { r, store, ...harness };
}
const post = (
  app: ReturnType<typeof setup>['app'],
  body: unknown,
  headers: Record<string, string> = AUTH,
) =>
  call(app, '/api/hq/hooks/claude', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('POST /api/hq/hooks/claude', () => {
  it('keeps the latest event of a session and answers 204 with no body', async () => {
    const { app, store } = setup();
    const res = await post(app, event());
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(store.read().get('sess-1')).toEqual({ kind: 'permission', at: NOW, cwd: '/work/a' });
    await post(app, event({ hook_event_name: 'Stop' }));
    expect(store.read().get('sess-1')?.kind).toBe('stop');
    expect(store.read().size).toBe(1);
  });

  it.each([
    ['no Authorization header', { ...WRITE }],
    ['a wrong token', { ...WRITE, authorization: `Bearer ${'x'.repeat(43)}` }],
    ['a token of another length', { ...WRITE, authorization: 'Bearer short' }],
    ['the right token without the scheme', { ...WRITE, authorization: TOKEN }],
    ['an empty bearer', { ...WRITE, authorization: 'Bearer ' }],
  ])('answers 401 with nothing in the body for %s, and keeps nothing', async (_name, headers) => {
    const { app, store, entries } = setup();
    const res = await post(app, event(), headers);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('');
    expect(store.read().size).toBe(0);
    expect(entries).toEqual([]); // a wrong token is not a log line either
  });

  it('checks the token before it reads the body', async () => {
    const { app } = setup();
    const res = await post(app, 'x'.repeat(100_000), { ...WRITE, authorization: 'Bearer nope' });
    expect(res.status).toBe(401);
  });

  it('is behind the same Host and header guards as every write', async () => {
    const { app, store } = setup();
    const noHeader = await post(app, event(), {
      host: HOST.host,
      authorization: `Bearer ${TOKEN}`,
    });
    expect(noHeader.status).toBe(403);
    const wrongHost = await post(app, event(), { ...AUTH, host: 'evil.example:4317' });
    expect(wrongHost.status).toBe(421);
    expect(store.read().size).toBe(0);
  });

  it('refuses fields beyond the five, wrong types, long values and bad JSON with 400 and a fixed answer', async () => {
    const { app, store } = setup();
    const bodies: unknown[] = [
      event({ message: 'SENTINEL_MESSAGE' }),
      event({ tool_input: { command: 'SENTINEL_TOOL' } }),
      event({ prompt: 'SENTINEL_PROMPT' }),
      event({ transcript_path: '/SENTINEL' }),
      event({ session_id: 5 }),
      event({ session_id: 'has space' }),
      event({ session_id: 'x'.repeat(129) }),
      event({ hook_event_name: '' }),
      event({ hook_event_name: 'x'.repeat(41) }),
      event({ notification_type: 'x'.repeat(65) }),
      event({ cwd: 'x'.repeat(1025) }),
      event({ reason: ['clear'] }),
      [],
      null,
      'not json',
      '',
      '{"hook_event_name":',
    ];
    for (const body of bodies) {
      const res = await post(app, typeof body === 'string' ? body : JSON.stringify(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      const text = await res.text();
      expect(ErrorEnvelope.parse(JSON.parse(text)).error.code).toBe('invalid_input');
      expect(text).not.toContain('SENTINEL');
    }
    expect(store.read().size).toBe(0);
  });

  it('answers 413 for a body over its bound, without reading the rest', async () => {
    const { app, store } = setup();
    const res = await post(app, JSON.stringify(event({ cwd: 'x'.repeat(20_000) })));
    expect(res.status).toBe(413);
    expect(await res.text()).toBe('');
    expect(store.read().size).toBe(0);
  });

  it('ignores an event it does not use with 204 and keeps nothing (and keeps the session’s earlier one)', async () => {
    const { app, store } = setup();
    await post(app, event({ hook_event_name: 'Stop' }));
    for (const ignored of [
      event({ hook_event_name: 'PostToolUse' }),
      event({ hook_event_name: 'Notification', notification_type: 'auth_success' }),
      event({ hook_event_name: 'Notification' }),
      event({ hook_event_name: 'SomethingNew' }),
    ]) {
      const res = await post(app, ignored);
      expect(res.status).toBe(204);
    }
    expect(store.read().get('sess-1')?.kind).toBe('stop');
  });

  it('is not served on the Tailscale listener, with or without a token', async () => {
    const remote = setup({ remote: true });
    const owner = { host: 'box.example.ts.net', [TAILSCALE_LOGIN_HEADER]: 'me@example.com' };
    const viaOwner = await post(remote.app, event(), { ...AUTH, ...owner });
    expect(viaOwner.status).toBe(404);
    expect(remote.store.read().size).toBe(0);
    const bare = await post(remote.app, event());
    expect([403, 404, 421]).toContain(bare.status);
    expect(remote.store.read().size).toBe(0);
  });
});

describe('POST /api/hq/hooks/claude: the token', () => {
  const sendWith = async (build: (headers: Headers) => void) => {
    const { app, store, entries } = setup();
    const headers = new Headers({ ...WRITE });
    build(headers);
    const res = await app.request(`http://127.0.0.1:4317/api/hq/hooks/claude`, {
      method: 'POST',
      headers,
      body: JSON.stringify(event()),
    });
    return { res, store, entries };
  };

  it.each([
    [
      'the right token, sent twice',
      (h: Headers) => (
        h.append('authorization', `Bearer ${TOKEN}`),
        h.append('authorization', `Bearer ${TOKEN}`)
      ),
    ],
    [
      'the right token after a wrong one',
      (h: Headers) => (
        h.append('authorization', 'Bearer wrong'),
        h.append('authorization', `Bearer ${TOKEN}`)
      ),
    ],
    [
      'the right token before a wrong one',
      (h: Headers) => (
        h.append('authorization', `Bearer ${TOKEN}`),
        h.append('authorization', 'Bearer wrong')
      ),
    ],
    [
      'a comma-joined list',
      (h: Headers) => h.set('authorization', `Bearer wrong, Bearer ${TOKEN}`),
    ],
    ['a lowercase scheme', (h: Headers) => h.set('authorization', `bearer ${TOKEN}`)],
    ['an upper-case scheme', (h: Headers) => h.set('authorization', `BEARER ${TOKEN}`)],
    ['two spaces after the scheme', (h: Headers) => h.set('authorization', `Bearer  ${TOKEN}`)],
    ['a tab after the scheme', (h: Headers) => h.set('authorization', `Bearer\t${TOKEN}`)],
    ['another scheme', (h: Headers) => h.set('authorization', `Basic ${TOKEN}`)],
    ['a token of the wrong length', (h: Headers) => h.set('authorization', `Bearer ${TOKEN}k`)],
    [
      'a token that is a prefix of the right one',
      (h: Headers) => h.set('authorization', `Bearer ${TOKEN.slice(0, -1)}`),
    ],
    ['a very long token', (h: Headers) => h.set('authorization', `Bearer ${'k'.repeat(5_000)}`)],
    ['a token with other characters', (h: Headers) => h.set('authorization', `Bearer ${TOKEN}=`)],
  ])('answers 401 with an empty body and nothing logged for %s', async (_name, build) => {
    const { res, store, entries } = await sendWith(build);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('');
    expect(store.read().size).toBe(0);
    expect(entries).toEqual([]);
  });

  it('accepts exactly one Bearer and the token, and never returns or logs the token', async () => {
    const { res, entries } = await sendWith((h) => h.set('authorization', `Bearer ${TOKEN}`));
    expect(res.status).toBe(204);
    expect(JSON.stringify([...res.headers])).not.toContain(TOKEN);
    expect(JSON.stringify(entries)).not.toContain(TOKEN);
  });

  it('a refused request’s answer never holds the token or the header it sent', async () => {
    const { app, entries } = setup();
    const res = await post(app, event({ cwd: 'relative' }), AUTH);
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(text).not.toContain(TOKEN);
    expect(JSON.stringify(entries)).not.toContain(TOKEN);
  });
});

describe('POST /api/hq/hooks/claude: strict ingestion', () => {
  const raw = (
    app: ReturnType<typeof setup>['app'],
    body: Uint8Array | string,
    headers: Record<string, string> = AUTH,
  ) =>
    app.request('http://127.0.0.1:4317/api/hq/hooks/claude', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : Buffer.from(body),
    });
  const refused = async (res: Response) => {
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(ErrorEnvelope.parse(JSON.parse(text)).error).toMatchObject({ code: 'invalid_input' });
    return text;
  };
  const json = (text: string) => Buffer.from(text, 'utf8');

  it('refuses bytes that are not UTF-8 (nothing is turned into a replacement character) and stores nothing', async () => {
    const { app, store } = setup();
    const valid = JSON.stringify(event({ cwd: '/work/SENTINEL_X' }));
    const bodies: Uint8Array[] = [
      Buffer.from([0x7b, 0xff, 0x7d]),
      // Valid JSON whose cwd holds a byte that is not UTF-8: the old reader stored a U+FFFD there.
      Buffer.concat([
        json('{"hook_event_name":"Stop","session_id":"s","cwd":"/a'),
        Buffer.from([0xc3, 0x28]),
        json('b"}'),
      ]),
      Buffer.concat([
        json('{"hook_event_name":"Stop","session_id":"s","cwd":"/a'),
        Buffer.from([0xff]),
        json('"}'),
      ]),
      // A truncated multi-byte sequence at the end of a string, a lone continuation byte, an overlong encoding, a surrogate in UTF-8.
      Buffer.concat([
        json('{"hook_event_name":"Stop","session_id":"s","cwd":"/a'),
        Buffer.from([0xe2, 0x82]),
        json('"}'),
      ]),
      Buffer.concat([
        json('{"hook_event_name":"Stop","session_id":"s","cwd":"/a'),
        Buffer.from([0x80]),
        json('"}'),
      ]),
      Buffer.concat([
        json('{"hook_event_name":"Stop","session_id":"s","cwd":"/a'),
        Buffer.from([0xc0, 0xaf]),
        json('"}'),
      ]),
      Buffer.concat([
        json('{"hook_event_name":"Stop","session_id":"s","cwd":"/a'),
        Buffer.from([0xed, 0xa0, 0x80]),
        json('"}'),
      ]),
      // A byte-order mark in front of otherwise good JSON.
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), json(valid)]),
    ];
    for (const body of bodies) await refused(await raw(app, body));
    expect(store.read().size).toBe(0);
  });

  it('accepts valid UTF-8 outside ASCII in a working directory, as it was sent', async () => {
    const { app, store } = setup();
    expect(
      (await raw(app, json(JSON.stringify(event({ cwd: '/work/café/日本語/😀' }))))).status,
    ).toBe(204);
    expect(store.read().get('sess-1')?.cwd).toBe('/work/café/日本語/😀');
  });

  it.each([
    ['application/json; charset=utf-8'],
    ['Application/JSON'],
    ['application/json;charset=UTF-8'],
    ['application/json; charset="utf-8"'],
  ])('accepts the content type %s', async (contentType) => {
    const { app } = setup();
    expect(
      (await raw(app, JSON.stringify(event()), { ...AUTH, 'content-type': contentType })).status,
    ).toBe(204);
  });

  it.each([
    ['application/json; charset=latin1'],
    ['application/json; charset=utf-16'],
    ['application/json; charset=utf-8; boundary=x'],
    ['application/json; version=2'],
  ])(
    'refuses the content type %s with the fixed answer, and stores nothing',
    async (contentType) => {
      const { app, store } = setup();
      const text = await refused(
        await raw(app, JSON.stringify(event()), { ...AUTH, 'content-type': contentType }),
      );
      expect(text).not.toContain('latin1');
      expect(store.read().size).toBe(0);
    },
  );

  it('refuses a request with no content type or another one (the write guard answers first, 403, and nothing is stored)', async () => {
    const { app, store } = setup();
    for (const contentType of [
      undefined,
      'text/plain',
      'application/x-www-form-urlencoded',
      'application/json, text/plain',
      'application/jsonp',
    ]) {
      const headers: Record<string, string> = { ...AUTH };
      if (contentType === undefined) delete headers['content-type'];
      else headers['content-type'] = contentType;
      expect((await raw(app, JSON.stringify(event()), headers)).status).toBe(403);
    }
    expect(store.read().size).toBe(0);
  });

  it('refuses a working directory that is not an absolute path without a control character, and says nothing of it', async () => {
    const { app, store } = setup();
    const cwds = [
      'relative/path',
      './here',
      '../up',
      '~/home',
      'work',
      ' /leading-space',
      'C:relative',
      '\\\\server\\share',
      'file:///work',
      '/with\u0000nul',
      '/with\nnewline',
      '/with\rreturn',
      '/with\ttab',
      '/with\u001bescape',
      '/with\u007fdel',
      '/with\u0085nextline',
      '/with\u2028separator',
      '/with\u2029separator',
      '/lone\ud800surrogate',
      '/lone\udfffsurrogate',
      '',
      `/${'x'.repeat(1024)}`, // 1025 long
    ];
    for (const cwd of cwds) {
      const text = await refused(await post(app, event({ cwd })));
      expect(text).not.toContain('relative');
      expect(text).not.toContain('SENTINEL');
    }
    expect(store.read().size).toBe(0);
  });

  it('accepts a POSIX or a Windows drive-letter absolute path of up to 1024 characters', async () => {
    const { app, store } = setup();
    for (const cwd of [
      '/',
      '/work/a b',
      '/work/it’s',
      'C:\\Users\\me',
      'c:/Users/me',
      `/${'x'.repeat(1023)}`,
    ])
      expect((await post(app, event({ cwd }))).status, cwd).toBe(204);
    expect(store.read().get('sess-1')?.cwd).toBe(`/${'x'.repeat(1023)}`);
  });

  it('holds the short words to their alphabet and the event name to letters', async () => {
    const { app, store } = setup();
    const bodies = [
      event({ hook_event_name: 'Permission Request' }),
      event({ hook_event_name: 'Stop\n' }),
      event({ hook_event_name: 'Stop2' }),
      event({ hook_event_name: 'Stöp' }),
      event({ notification_type: 'idle prompt' }),
      event({ notification_type: 'idle_prompt\n' }),
      event({ notification_type: '\u0000' }),
      event({ reason: 'cl ear' }),
      event({ reason: 'clear\u2028' }),
      event({ session_id: 'abc\n' }),
      event({ session_id: 'abc\u0000' }),
      event({ session_id: 'ab/c' }),
      event({ cwd: null }),
      event({ cwd: 5 }),
    ];
    for (const body of bodies) await refused(await post(app, body));
    expect(store.read().size).toBe(0);
    for (const ok of [
      event({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }),
      event({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }),
      event({ session_id: '3f2c9a10-aaaa-bbbb-cccc-0123456789ab' }),
    ])
      expect((await post(app, ok)).status).toBe(204);
  });

  it('refuses text that decodes but is not one JSON object of the five fields, each time with the same fixed answer', async () => {
    const { app, store } = setup();
    const texts = [
      '{"hook_event_name":"Stop","session_id":"s"}garbage',
      '{"hook_event_name":"Stop","session_id":"s",}',
      "{'hook_event_name':'Stop','session_id':'s'}",
      '{"hook_event_name":"Stop","session_id":"s","session_id":"t","x":1}',
      '[{"hook_event_name":"Stop","session_id":"s"}]',
      '"Stop"',
      '1',
      'true',
    ];
    const answers = new Set<string>();
    for (const text of texts) answers.add(await refused(await post(app, text)));
    answers.add(await refused(await post(app, event({ cwd: 'relative' }))));
    answers.add(await refused(await raw(app, Buffer.from([0xff]))));
    answers.add(
      await refused(
        await raw(app, JSON.stringify(event()), {
          ...AUTH,
          'content-type': 'application/json; charset=latin1',
        }),
      ),
    );
    expect(answers.size).toBe(1); // one fixed answer for every kind of refusal, echoing nothing
    expect(store.read().size).toBe(0);
  });

  it('keeps the 8 KiB bound: 413 with an empty body, by declared length or by what is streamed', async () => {
    const { app, store } = setup();
    const big = JSON.stringify(event({ cwd: `/${'x'.repeat(9_000)}` }));
    const declared = await raw(app, big);
    expect(declared.status).toBe(413);
    expect(await declared.text()).toBe('');
    // Not declared (a chunked body): the bytes are counted as they arrive.
    const chunks = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 20; i += 1) controller.enqueue(new Uint8Array(1_000).fill(0x61));
        controller.close();
      },
    });
    const streamed = await app.request('http://127.0.0.1:4317/api/hq/hooks/claude', {
      method: 'POST',
      headers: AUTH,
      body: chunks,
      duplex: 'half',
    } as RequestInit);
    expect(streamed.status).toBe(413);
    expect(store.read().size).toBe(0);
  });

  it('a flood of valid events from many sessions keeps the store bounded and is quick', async () => {
    const { app, store } = setup();
    const started = performance.now();
    for (let i = 0; i < 3_000; i += 1) {
      const res = await post(app, event({ session_id: `flood-${i}` }));
      expect(res.status).toBe(204);
    }
    expect(store.read().size).toBeLessThanOrEqual(200);
    expect(store.read().has('flood-2999')).toBe(true);
    expect(store.read().has('flood-0')).toBe(false);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe('GET and PUT /api/hq/claude-hooks', () => {
  const put = (app: ReturnType<typeof setup>['app'], body: unknown) =>
    call(app, '/api/hq/claude-hooks', {
      method: 'PUT',
      headers: WRITE,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  /** The fingerprint the page would send: the `preview` of a GET made now. */
  const previewOf = async (app: ReturnType<typeof setup>['app']) =>
    ClaudeHooksStatus.parse(
      await (await call(app, '/api/hq/claude-hooks', { headers: HOST })).json(),
    ).preview;

  it('previews with a GET that changes nothing, turns on and off with a PUT, and returns the status', async () => {
    const { app, r } = setup();
    const before = readFileSync(r.settings, 'utf8');
    const preview = await call(app, '/api/hq/claude-hooks', { headers: HOST });
    expect(preview.status).toBe(200);
    const status = ClaudeHooksStatus.parse(await preview.json());
    expect(status).toMatchObject({ state: 'off', files: [{ path: '~/.claude/settings.json' }] });
    expect(status.command).toContain('agent-productivity-hook.mjs');
    expect(readFileSync(r.settings, 'utf8')).toBe(before);

    const on = await put(app, { enabled: true, preview: status.preview });
    expect(on.status).toBe(200);
    expect(ClaudeHooksStatus.parse(await on.json()).state).toBe('on');
    expect(readFileSync(r.settings, 'utf8')).not.toBe(before);

    const hq = HqResponse.parse(await (await call(app, '/api/hq', { headers: HOST })).json());
    expect(hq.exactPrompts).toBe('on');

    const off = await put(app, { enabled: false, preview: await previewOf(app) });
    expect(ClaudeHooksStatus.parse(await off.json()).state).toBe('off');
    expect(JSON.parse(readFileSync(r.settings, 'utf8'))).toEqual({ a: 1 });
  });

  it('refuses a change with no preview, a malformed one or a stale one (409), and writes nothing', async () => {
    const { app, r } = setup();
    const shown = await previewOf(app);
    const refused = async (body: unknown) => {
      const res = await put(app, body);
      const text = await res.text();
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect(ErrorEnvelope.parse(JSON.parse(text)).error.code).toBe('claude_hooks_stale');
      expect(text).not.toContain(shown);
    };
    await refused({ enabled: true });
    await refused({ enabled: true, preview: '' });
    await refused({ enabled: true, preview: 'not a fingerprint' });
    await refused({ enabled: true, preview: '0'.repeat(64) });
    // The file changed after the owner was shown the plan: the fingerprint no longer matches, so the write is refused.
    writeFileSync(r.settings, '{"a":1,"theirs":true}');
    await refused({ enabled: true, preview: shown });
    expect(readFileSync(r.settings, 'utf8')).toBe('{"a":1,"theirs":true}');
    expect(existsSync(r.hooks.paths.script)).toBe(false);
    // Reading again gives a fingerprint that works, once.
    const again = await previewOf(app);
    expect(again).not.toBe(shown);
    expect((await put(app, { enabled: true, preview: again })).status).toBe(200);
    await refused({ enabled: true, preview: again });
  });

  it('gives the same fingerprint for the same state, and another for any change to the plan', async () => {
    const { app, r } = setup();
    const first = await previewOf(app);
    expect(await previewOf(app)).toBe(first);
    writeFileSync(r.settings, '{"a":2}');
    const second = await previewOf(app);
    expect(second).not.toBe(first);
    expect(await previewOf(app)).toBe(second);
  });

  it('refuses a body that is not exactly { enabled: boolean, preview?: string }', async () => {
    const { app, r } = setup();
    for (const body of [
      {},
      { enabled: 'yes' },
      { enabled: true, extra: 1 },
      { enabled: true, preview: 5 },
      [],
      'nope',
      '',
    ]) {
      const res = await put(app, body);
      expect(res.status).toBe(400);
      expect(ErrorEnvelope.parse(await res.json()).error.code).toBe('invalid_input');
    }
    expect(readFileSync(r.settings, 'utf8')).toBe('{"a":1}');
  });

  it('needs the app header like every write', async () => {
    const { app } = setup();
    const res = await call(app, '/api/hq/claude-hooks', {
      method: 'PUT',
      headers: HOST,
      body: '{"enabled":true}',
    });
    expect(res.status).toBe(403);
  });

  it('answers a settings file it cannot change with 422 and a fixed code, never the file’s text or path', async () => {
    const { app, r } = setup({ settings: '{ SENTINEL_NOT_JSON' });
    const res = await put(app, { enabled: true, preview: await previewOf(app) });
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(ErrorEnvelope.parse(JSON.parse(text)).error).toMatchObject({
      code: 'claude_hooks_blocked',
      retryable: false,
      details: { reason: 'not_json' },
    });
    expect(text).not.toContain('SENTINEL');
    expect(text).not.toContain(r.root);
    const status = await (await call(app, '/api/hq/claude-hooks', { headers: HOST })).json();
    expect(status).toMatchObject({ state: 'unavailable', reason: 'settings_blocked' });
    expect(JSON.stringify(status)).not.toContain('SENTINEL');
  });

  it('answers 422 claude_hooks_unavailable without a Claude Code folder, and without the integration', async () => {
    const none = setup();
    rmSync(none.r.config, { recursive: true, force: true });
    const res = await put(none.app, { enabled: true, preview: await previewOf(none.app) });
    expect(res.status).toBe(422);
    expect(ErrorEnvelope.parse(await res.json()).error.code).toBe('claude_hooks_unavailable');

    const bare = testApp();
    const status = ClaudeHooksStatus.parse(
      await (await call(bare.app, '/api/hq/claude-hooks', { headers: HOST })).json(),
    );
    expect(status).toMatchObject({ state: 'unavailable', files: [] });
    const refused = await put(bare.app, { enabled: true, preview: status.preview });
    expect(refused.status).toBe(422);
    expect(ErrorEnvelope.parse(await refused.json()).error.code).toBe('claude_hooks_unavailable');
  });

  it('answers a fingerprint of another action with 409 claude_hooks_stale, and each action’s own with 200', async () => {
    const { app, r } = setup();
    const first = ClaudeHooksStatus.parse(
      await (await call(app, '/api/hq/claude-hooks', { headers: HOST })).json(),
    );
    expect(Object.keys(first.plans)).toEqual(['on']);
    expect((await put(app, { enabled: false, preview: first.plans.on!.preview })).status).toBe(409);
    expect((await put(app, { enabled: true, preview: first.plans.on!.preview })).status).toBe(200);
    // Out of date script: repair and off have different fingerprints, and only each one's own is accepted for its action.
    writeFileSync(r.hooks.paths.script, '// Agent Productivity: the Claude Code hook (older)\n');
    const broken = ClaudeHooksStatus.parse(
      await (await call(app, '/api/hq/claude-hooks', { headers: HOST })).json(),
    );
    expect(Object.keys(broken.plans).sort()).toEqual(['off', 'repair']);
    const wrong = await put(app, { enabled: false, preview: broken.plans.repair!.preview });
    expect(wrong.status).toBe(409);
    expect(ErrorEnvelope.parse(await wrong.json()).error.code).toBe('claude_hooks_stale');
    expect((await put(app, { enabled: false, preview: broken.plans.off!.preview })).status).toBe(
      200,
    );
  });

  it('answers a layout HQ cannot edit safely with 422 and the fixed code unsupported_layout, writing nothing', async () => {
    const text = `{"a":${'['.repeat(100)}${']'.repeat(100)}}`;
    const { app, r } = setup({ settings: text });
    const res = await put(app, { enabled: true, preview: await previewOf(app) });
    expect(res.status).toBe(422);
    const body = await res.text();
    expect(ErrorEnvelope.parse(JSON.parse(body)).error).toMatchObject({
      code: 'claude_hooks_blocked',
      details: { reason: 'unsupported_layout' },
    });
    expect(body).not.toContain(r.root);
    expect(readFileSync(r.settings, 'utf8')).toBe(text);
  });

  it('answers an unquotable data folder with 422 unsupported_path that says which characters work', async () => {
    const r = rig({ settings: '{"a":1}' });
    const folder = join(r.root, 'data\nfolder');
    mkdirSync(folder);
    const { app } = testApp({ claudeHooks: r.another({ dataDir: folder }) });
    const res = await put(app, { enabled: true, preview: await previewOf(app) });
    expect(res.status).toBe(422);
    const error = ErrorEnvelope.parse(await res.json()).error;
    expect(error).toMatchObject({
      code: 'claude_hooks_blocked',
      details: { reason: 'unsupported_path' },
    });
    expect(error.message).toContain('Spaces, quotes, $, backticks, backslashes');
    expect(readFileSync(r.settings, 'utf8')).toBe('{"a":1}');
  });

  it('answers a switch that throws with a fixed 500 claude_hooks_failed, never the error’s own text', async () => {
    const r = rig({ settings: '{"a":1}' });
    const broken = {
      ...r.hooks,
      paths: r.hooks.paths,
      status: () => Promise.reject(new Error(`SENTINEL ${r.root}`)),
      set: () => Promise.reject(new Error(`SENTINEL ${r.root}`)),
      state: () => Promise.resolve('unavailable' as const),
    };
    const { app } = testApp({ claudeHooks: broken });
    for (const res of [
      await call(app, '/api/hq/claude-hooks', { headers: HOST }),
      await put(app, { enabled: true, preview: 'a'.repeat(64) }),
    ]) {
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(ErrorEnvelope.parse(JSON.parse(text)).error.code).toBe('claude_hooks_failed');
      expect(text).not.toContain('SENTINEL');
      expect(text).not.toContain(r.root);
    }
  });

  it('is served on the Tailscale listener too, behind the owner guard', async () => {
    const remote = setup({ remote: true });
    const owner = { host: 'box.example.ts.net', [TAILSCALE_LOGIN_HEADER]: 'me@example.com' };
    const res = await call(remote.app, '/api/hq/claude-hooks', { headers: owner });
    expect(res.status).toBe(200);
    const stranger = await call(remote.app, '/api/hq/claude-hooks', {
      headers: { host: owner.host },
    });
    expect(stranger.status).toBe(403);
  });
});
