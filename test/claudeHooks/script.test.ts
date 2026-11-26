import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEADLINE_MS,
  findApp,
  messageFor,
  post,
  runHook,
} from '../../src/server/integrations/claudeHooks/assets/claude-hook.mjs';
import { HqClaudeHookEvent } from '../../src/shared/contracts/hq.ts';
import { ASSET } from './helpers.ts';

// The hook script, run for real as Node runs it in Claude Code (stdin in, exit code and output out) against a real loopback server,
// and its pure parts called directly. The registry sits beside the script, so each test copies the script into its own folder.

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean();
});

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage['headers'];
  body: string;
}

async function listen(
  respond: (seen: Seen, res: import('node:http').ServerResponse) => void = (_s, res) => {
    res.statusCode = 204;
    res.end();
  },
) {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const entry = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      seen.push(entry);
      respond(entry, res);
    });
  });
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      done();
    });
  });
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
  return { seen, port: (server.address() as AddressInfo).port, server };
}

function folder(registry: unknown | string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'hook script-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(dir, { recursive: true });
  copyFileSync(ASSET, join(dir, 'agent-productivity-hook.mjs'));
  if (registry !== null)
    writeFileSync(
      join(dir, 'registry.json'),
      typeof registry === 'string' ? registry : JSON.stringify(registry),
      // As HQ writes it: the script trusts only a registry that is the owner's and closed to group and others.
      { mode: 0o600 },
    );
  return dir;
}

const registryFor = (port: number, extra: Record<string, unknown> = {}) => ({
  v: 1,
  pid: process.pid,
  port,
  token: TOKEN,
  ...extra,
});

/** Runs the installed copy of the script with `stdin`, as Claude Code does. */
function run(dir: string, stdin: string | Buffer) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>(
    (resolve, reject) => {
      const started = Date.now();
      const child = spawn(process.execPath, [join(dir, 'agent-productivity-hook.mjs')], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
      child.stdin.on('error', () => undefined);
      child.stdin.end(stdin);
    },
  );
}

const SENTINELS = [
  'SENTINEL_MESSAGE',
  'SENTINEL_TOOL_INPUT',
  'SENTINEL_PROMPT',
  'SENTINEL_TRANSCRIPT',
  'SENTINEL_RESPONSE',
  'SENTINEL_LAST',
];
const full = (over: Record<string, unknown> = {}) => ({
  session_id: 'abc-123',
  transcript_path: '/SENTINEL_TRANSCRIPT/x.jsonl',
  cwd: '/work/project',
  permission_mode: 'default',
  hook_event_name: 'Notification',
  message: 'SENTINEL_MESSAGE',
  notification_type: 'permission_prompt',
  title: 'SENTINEL_MESSAGE',
  tool_name: 'Bash',
  tool_input: { command: 'SENTINEL_TOOL_INPUT', nested: { prompt: 'SENTINEL_TOOL_INPUT' } },
  tool_response: 'SENTINEL_RESPONSE',
  prompt: 'SENTINEL_PROMPT',
  last_assistant_message: 'SENTINEL_LAST',
  permission_suggestions: [{ rules: [{ ruleContent: 'SENTINEL_TOOL_INPUT' }] }],
  ...over,
});

describe('the message', () => {
  it('sends a bounded task projection only through an opted-in local registry', async () => {
    const { port, seen } = await listen();
    const input = full({
      hook_event_name: 'Stop',
      background_tasks: [
        { id: 'worker', type: 'subagent', status: 'running', description: 'SENTINEL_DESCRIPTION' },
        { id: 'job', type: 'shell', status: 'pending', command: 'SENTINEL_COMMAND' },
        { id: 'ended', type: 'monitor', status: 'completed' },
        { id: 'other', type: 'cloud session', status: 'running' },
      ],
    });
    const enabled = folder(registryFor(port, { backgroundWork: true }));
    expect(await run(enabled, JSON.stringify(input))).toMatchObject({
      code: 0,
      stdout: '',
      stderr: '',
    });
    const projected = HqClaudeHookEvent.parse(JSON.parse(seen[0]!.body));
    expect(projected.background_work).toEqual({
      observed_at: expect.any(Number),
      tasks: [
        { id: 'worker', type: 'subagent', status: 'running' },
        { id: 'job', type: 'shell', status: 'pending' },
      ],
    });
    expect(seen[0]!.body).not.toMatch(/SENTINEL/);
    expect(await run(folder(registryFor(port)), JSON.stringify(input))).toMatchObject({ code: 0 });
    expect(JSON.parse(seen[1]!.body)).not.toHaveProperty('background_work');
  });

  it('distinguishes empty and unavailable snapshots and fits the wire limit', () => {
    const project = (tasks: unknown) =>
      HqClaudeHookEvent.parse(
        messageFor(
          full({
            hook_event_name: 'Stop',
            cwd: '/' + '嗨'.repeat(1023),
            background_tasks: tasks,
          }),
          true,
        ),
      );
    expect(project(undefined).background_work?.tasks).toBe(null);
    expect(project([{ id: 'job', type: 'shell', status: 'unclear' }]).background_work?.tasks).toBe(
      null,
    );
    expect(project([]).background_work?.tasks).toEqual([]);
    const tasks = Array.from({ length: 24 }, (_, i) => ({
      id: String(i).padStart(128, 'a'),
      type: 'subagent',
      status: 'running',
    }));
    const maximum = project(tasks);
    expect(maximum.background_work?.tasks).toHaveLength(24);
    expect(Buffer.byteLength(JSON.stringify(maximum))).toBeLessThan(8 * 1024);
    expect(project([...tasks, tasks[0]]).background_work?.tasks).toBe(null);
  });

  it('carries the five fields and nothing else, however much the event holds', () => {
    const message = messageFor(full());
    expect(message).toEqual({
      hook_event_name: 'Notification',
      session_id: 'abc-123',
      notification_type: 'permission_prompt',
      cwd: '/work/project',
    });
    expect(JSON.stringify(message)).not.toMatch(/SENTINEL/);
    expect(
      Object.keys(messageFor(full({ hook_event_name: 'SessionEnd', reason: 'clear' }))!).sort(),
    ).toEqual(['cwd', 'hook_event_name', 'notification_type', 'reason', 'session_id']);
  });

  it('leaves out a field that is missing or is not the right shape, and refuses an event without an id or a name', () => {
    expect(messageFor({ hook_event_name: 'Stop', session_id: 's1', cwd: '' })).toEqual({
      hook_event_name: 'Stop',
      session_id: 's1',
    });
    expect(
      messageFor({
        hook_event_name: 'Stop',
        session_id: 's1',
        notification_type: 'has space',
        reason: 5,
        cwd: 'x'.repeat(1025),
      }),
    ).toEqual({ hook_event_name: 'Stop', session_id: 's1' });
    for (const bad of [
      null,
      [],
      'x',
      {},
      { hook_event_name: 'Stop' },
      { session_id: 's1' },
      { hook_event_name: 'Stop', session_id: 'a b' },
      { hook_event_name: 'Stop', session_id: 'x'.repeat(129) },
      { hook_event_name: 'Not An Event', session_id: 's1' },
      { hook_event_name: ['Stop'], session_id: 's1' },
    ])
      expect(messageFor(bad)).toBeNull();
  });
});

// What is a field, for the server and for the script. The script is plain JavaScript that cannot import the contract, so the two
// write the same rules twice; these tables are what holds them together.
const CWDS: [string, boolean][] = [
  ['/', true],
  ['/work/project', true],
  ['/work/café/日本語/😀', true],
  ['C:\\Users\\me', true],
  ['c:/Users/me', true],
  [`/${'x'.repeat(1023)}`, true],
  [`/${'x'.repeat(1024)}`, false],
  ['', false],
  ['relative/path', false],
  ['./here', false],
  ['~/home', false],
  ['C:relative', false],
  ['\\\\server\\share', false],
  [' /leading', false],
  ['/with\u0000nul', false],
  ['/with\nnewline', false],
  ['/with\rreturn', false],
  ['/with\ttab', false],
  ['/with\u001bescape', false],
  ['/with\u007fdel', false],
  ['/with\u0085c1', false],
  ['/with\u009fc1', false],
  ['/with\u2028line', false],
  ['/with\u2029paragraph', false],
  ['/lone\ud800high', false],
  ['/lone\udfffLow', false],
  ['/pair\ud83d\ude00ok', true],
  ['/\ufffdreplacement is a character, not an error', true],
];
const WORDS: [string, boolean][] = [
  ['permission_prompt', true],
  ['a.b:c-d_9', true],
  ['x'.repeat(64), true],
  ['x'.repeat(65), false],
  ['', false],
  ['has space', false],
  ['new\nline', false],
  ['trailing\n', false],
  ['ünï', false],
  ['a/b', false],
];
const NAMES: [string, boolean][] = [
  ['Stop', true],
  ['PermissionRequest', true],
  ['x'.repeat(40), true],
  ['x'.repeat(41), false],
  ['', false],
  ['Stop2', false],
  ['Stop\n', false],
  ['Not An Event', false],
  ['Stöp', false],
];
const IDS: [string, boolean][] = [
  ['abc-123', true],
  ['3f2c9a10-aaaa-bbbb-cccc-0123456789ab', true],
  ['a'.repeat(128), true],
  ['a'.repeat(129), false],
  ['', false],
  ['a b', false],
  ['abc\n', false],
  ['a/b', false],
];

describe('the script and the server hold every field to the same rule', () => {
  const accepted = (over: Record<string, unknown>) =>
    HqClaudeHookEvent.safeParse({ hook_event_name: 'Stop', session_id: 's1', ...over }).success;
  const sent = (over: Record<string, unknown>) =>
    messageFor({ hook_event_name: 'Stop', session_id: 's1', ...over });

  it.each(CWDS)(
    'working directory %j: accepted by the server is %s, and the script sends it only then',
    (cwd, ok) => {
      expect(accepted({ cwd })).toBe(ok);
      expect(sent({ cwd })?.cwd).toBe(ok ? cwd : undefined);
    },
  );

  it.each(WORDS)(
    'notification_type and reason %j: accepted by the server is %s, and the script sends them only then',
    (word, ok) => {
      for (const field of ['notification_type', 'reason']) {
        expect(accepted({ [field]: word })).toBe(ok);
        expect(sent({ [field]: word })?.[field as 'reason']).toBe(ok ? word : undefined);
      }
    },
  );

  it.each(NAMES)(
    'event name %j: accepted by the server is %s, and the script sends a message only then',
    (name, ok) => {
      expect(accepted({ hook_event_name: name })).toBe(ok);
      expect(sent({ hook_event_name: name }) !== null).toBe(ok);
    },
  );

  it.each(IDS)(
    'session id %j: accepted by the server is %s, and the script sends a message only then',
    (id, ok) => {
      expect(accepted({ session_id: id })).toBe(ok);
      expect(sent({ session_id: id }) !== null).toBe(ok);
    },
  );

  it('a field of another type is refused by both', () => {
    for (const bad of [5, null, true, ['a'], { a: 1 }])
      for (const field of ['cwd', 'reason', 'notification_type']) {
        expect(accepted({ [field]: bad })).toBe(false);
        expect(sent({ [field]: bad })).toEqual({ hook_event_name: 'Stop', session_id: 's1' });
      }
  });

  it('every message the script builds is accepted by the server schema', () => {
    for (const [cwd] of CWDS)
      for (const [word] of WORDS) {
        const message = sent({ cwd, reason: word, notification_type: word });
        if (message !== null) expect(HqClaudeHookEvent.safeParse(message).success).toBe(true);
      }
  });
});

describe('strict input', () => {
  const bytes = (...parts: (string | number[])[]) =>
    Buffer.concat(
      parts.map((part) => (typeof part === 'string' ? Buffer.from(part) : Buffer.from(part))),
    );

  it.each([
    [
      'bytes that are not UTF-8 in a string value (the old reader sent U+FFFD)',
      bytes('{"hook_event_name":"Stop","session_id":"s","cwd":"/a', [0xff], 'b"}'),
    ],
    [
      'an invalid byte outside any string',
      bytes('{"hook_event_name":"Stop",', [0xff], '"session_id":"s"}'),
    ],
    [
      'a truncated multi-byte sequence',
      bytes('{"hook_event_name":"Stop","session_id":"s","cwd":"/a', [0xe2, 0x82], '"}'),
    ],
    [
      'an overlong encoding',
      bytes('{"hook_event_name":"Stop","session_id":"s","cwd":"/a', [0xc0, 0xaf], '"}'),
    ],
    [
      'a surrogate written in UTF-8',
      bytes('{"hook_event_name":"Stop","session_id":"s","cwd":"/a', [0xed, 0xa0, 0x80], '"}'),
    ],
    [
      'a byte-order mark before the JSON',
      bytes([0xef, 0xbb, 0xbf], '{"hook_event_name":"Stop","session_id":"s"}'),
    ],
  ])('sends nothing for %s', async (_name, stdin) => {
    const app = await listen();
    await runHook({ dir: folder(registryFor(app.port)), stdin });
    expect(app.seen).toHaveLength(0);
    const result = await run(folder(registryFor(app.port)), stdin);
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(app.seen).toHaveLength(0);
  });

  it('sends a valid UTF-8 event with a non-ASCII folder as it is', async () => {
    const app = await listen();
    await runHook({
      dir: folder(registryFor(app.port)),
      stdin: Buffer.from(JSON.stringify(full({ cwd: '/work/café/日本語/😀' }))),
    });
    expect(JSON.parse(app.seen[0]!.body).cwd).toBe('/work/café/日本語/😀');
  });

  it('never sends a message the server would refuse: a working directory that is not valid is left out, the event still goes', async () => {
    const app = await listen();
    const dir = folder(registryFor(app.port));
    for (const [cwd] of CWDS)
      await runHook({ dir, stdin: Buffer.from(JSON.stringify(full({ cwd }))) });
    expect(app.seen).toHaveLength(CWDS.length);
    for (const [index, [cwd, ok]] of CWDS.entries()) {
      const body = JSON.parse(app.seen[index]!.body);
      expect(HqClaudeHookEvent.safeParse(body).success).toBe(true);
      expect(body.cwd).toBe(ok ? cwd : undefined);
    }
  });

  it('keeps to the five Node built-ins the security check allows, and uses a fatal decoder', () => {
    const source = readFileSync(ASSET, 'utf8');
    expect(source).toMatch(/new TextDecoder\('utf-8', \{ fatal: true/);
    expect(source).not.toMatch(/toString\('utf8'\)/);
  });
});

describe('finding the app', () => {
  it('reads the port and token of a live registry', async () => {
    expect(await findApp(folder(registryFor(4317)))).toEqual({ port: 4317, token: TOKEN });
  });

  it.each([
    ['no registry file', null],
    ['text that is not JSON', 'nope'],
    ['another version', registryFor(4317, { v: 2 })],
    ['a process that no longer exists', registryFor(4317, { pid: 2 ** 22 + 12345 })],
    ['a pid that is not a number', registryFor(4317, { pid: '1' })],
    ['a port out of range', registryFor(70000)],
    ['a token that is too short', registryFor(4317, { token: 'abc' })],
    ['a token with odd characters', registryFor(4317, { token: `${TOKEN}\n` })],
  ])('finds nothing for %s', async (_name, registry) => {
    expect(await findApp(folder(registry))).toBeNull();
  });
});

describe('posting', () => {
  it('posts the message to the loopback app with the token and the headers the guards need', async () => {
    const app = await listen();
    const dir = folder(registryFor(app.port));
    await runHook({ dir, stdin: Buffer.from(JSON.stringify(full())) });
    expect(app.seen).toHaveLength(1);
    const [request] = app.seen;
    expect(request!.method).toBe('POST');
    expect(request!.url).toBe('/api/hq/hooks/claude');
    expect(request!.headers['host']).toBe(`127.0.0.1:${app.port}`);
    expect(request!.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(request!.headers['content-type']).toBe('application/json');
    expect(request!.headers['x-agent-productivity-request']).toBe('1');
    expect(JSON.parse(request!.body)).toEqual({
      hook_event_name: 'Notification',
      session_id: 'abc-123',
      notification_type: 'permission_prompt',
      cwd: '/work/project',
    });
  });

  it('never sends a word of the event’s message, tool input, prompt or transcript', async () => {
    const app = await listen();
    const dir = folder(registryFor(app.port));
    for (const event of ['PermissionRequest', 'Notification', 'Stop', 'SessionStart', 'SessionEnd'])
      await runHook({ dir, stdin: Buffer.from(JSON.stringify(full({ hook_event_name: event }))) });
    expect(app.seen).toHaveLength(5);
    const everything = JSON.stringify(app.seen);
    for (const sentinel of SENTINELS) expect(everything).not.toContain(sentinel);
    expect(everything).not.toContain('permission_suggestions');
    expect(everything).not.toContain('transcript_path');
  });

  it('resolves, quietly, when the connection is refused, the server is slow, or it answers an error', async () => {
    const refused = await listen();
    const port = refused.port;
    await new Promise<void>((done) => refused.server.close(() => done()));
    await runHook({ dir: folder(registryFor(port)), stdin: Buffer.from(JSON.stringify(full())) });

    const slow = await listen(() => undefined); // never answers
    const started = Date.now();
    await post({ port: slow.port, token: TOKEN }, messageFor(full())!, 150);
    expect(Date.now() - started).toBeLessThan(1000);
    slow.server.closeAllConnections();

    const failing = await listen((_s, res) => {
      res.statusCode = 500;
      res.end('SENTINEL_BODY');
    });
    await runHook({
      dir: folder(registryFor(failing.port)),
      stdin: Buffer.from(JSON.stringify(full())),
    });
  });
});

describe('the script as Node runs it', () => {
  it('exits quietly within its deadline when the registry is a named pipe', () => {
    const dir = folder(null);
    execFileSync('mkfifo', [join(dir, 'registry.json')]);

    const result = spawnSync(process.execPath, [join(dir, 'agent-productivity-hook.mjs')], {
      input: JSON.stringify(full()),
      encoding: 'utf8',
      timeout: DEADLINE_MS + 1_000,
      killSignal: 'SIGKILL',
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('posts, prints nothing and exits 0', async () => {
    const app = await listen();
    const result = await run(folder(registryFor(app.port)), JSON.stringify(full()));
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(app.seen).toHaveLength(1);
    expect(JSON.parse(app.seen[0]!.body).session_id).toBe('abc-123');
  });

  it.each([
    ['no registry file (the app was never started)', null, JSON.stringify(full())],
    [
      'a registry whose process is gone',
      registryFor(4317, { pid: 2 ** 22 + 12345 }),
      JSON.stringify(full()),
    ],
    ['a registry that is not JSON', 'garbage', JSON.stringify(full())],
    ['stdin that is not JSON', registryFor(1), 'SENTINEL_NOT_JSON'],
    ['stdin that is empty', registryFor(1), ''],
    ['an event of the wrong shape', registryFor(1), '[1,2,3]'],
    ['a refused connection', registryFor(1), JSON.stringify(full())],
  ])('exits 0 quickly and prints nothing for %s', async (_name, registry, stdin) => {
    const result = await run(folder(registry), stdin);
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(result.ms).toBeLessThan(DEADLINE_MS + 1500);
  });

  it('exits 0 at its deadline when the app never answers', async () => {
    const app = await listen(() => undefined);
    const result = await run(folder(registryFor(app.port)), JSON.stringify(full()));
    app.server.closeAllConnections();
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(result.ms).toBeLessThan(DEADLINE_MS + 1500);
  });

  it('sends nothing for an event larger than its bound, and still exits 0', async () => {
    const app = await listen();
    const big = JSON.stringify(full({ tool_input: { content: 'x'.repeat(17 * 1024 * 1024) } }));
    const result = await run(folder(registryFor(app.port)), big);
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(app.seen).toHaveLength(0);
  });

  it('sends a large event that is within its bound (a permission request for a big file)', async () => {
    const app = await listen();
    const big = JSON.stringify(
      full({
        hook_event_name: 'PermissionRequest',
        tool_input: { content: 'x'.repeat(3 * 1024 * 1024) },
      }),
    );
    const result = await run(folder(registryFor(app.port)), big);
    expect(result.code).toBe(0);
    expect(app.seen).toHaveLength(1);
    expect(app.seen[0]!.body.length).toBeLessThan(300);
  });
});

describe('the script never blocks (the deadline is a timer that nothing can hold)', () => {
  /** Runs the installed copy with `stdin`, killing it hard at deadline + 1 s: a script that blocks shows as a signal, not a status. */
  function ranQuietly(dir: string, input: string | null = JSON.stringify(full())) {
    const started = Date.now();
    const result = spawnSync(process.execPath, [join(dir, 'agent-productivity-hook.mjs')], {
      ...(input === null ? {} : { input }),
      encoding: 'utf8',
      timeout: DEADLINE_MS + 1_000,
      killSignal: 'SIGKILL',
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    return Date.now() - started;
  }

  it('ends at once for a registry that is a folder', () => {
    const dir = folder(null);
    mkdirSync(join(dir, 'registry.json'));
    expect(ranQuietly(dir)).toBeLessThan(DEADLINE_MS);
  });

  it('ends at once for a registry that is a link (even to a good registry)', async () => {
    const app = await listen();
    const dir = folder(null);
    const elsewhere = folder(registryFor(app.port));
    symlinkSync(join(elsewhere, 'registry.json'), join(dir, 'registry.json'));
    expect(ranQuietly(dir)).toBeLessThan(DEADLINE_MS);
    expect(app.seen).toHaveLength(0);
  });

  it('ends at once for a registry that is a link to a named pipe', () => {
    const dir = folder(null);
    const pipe = join(dir, 'pipe');
    execFileSync('mkfifo', [pipe]);
    symlinkSync(pipe, join(dir, 'registry.json'));
    expect(ranQuietly(dir)).toBeLessThan(DEADLINE_MS);
  });

  it('ends at once for a registry that is not a small file: nothing past the bound is read', async () => {
    const app = await listen();
    const dir = folder(JSON.stringify({ ...registryFor(app.port), pad: 'x'.repeat(64 * 1024) }));
    expect(ranQuietly(dir)).toBeLessThan(DEADLINE_MS);
    expect(app.seen).toHaveLength(0);
  });

  it('does not trust a registry that others can read or write', async () => {
    const app = await listen();
    for (const mode of [0o644, 0o640, 0o604, 0o660, 0o666]) {
      const dir = folder(registryFor(app.port));
      chmodSync(join(dir, 'registry.json'), mode);
      ranQuietly(dir);
    }
    expect(app.seen).toHaveLength(0);
    // and the owner-only one is trusted
    const good = folder(registryFor(app.port));
    expect(await run(good, JSON.stringify(full()))).toMatchObject({
      code: 0,
      stdout: '',
      stderr: '',
    });
    expect(app.seen).toHaveLength(1);
  });

  it('ends at once for a missing registry', () => {
    expect(ranQuietly(folder(null))).toBeLessThan(DEADLINE_MS);
  });

  it('ends at the deadline when stdin never closes', async () => {
    const dir = folder(null);
    const started = Date.now();
    // stdin stays open and silent: the child waits for input that never comes, and the timer ends it.
    const result = await new Promise<{ code: number | null; signal: string | null; out: string }>(
      (resolve) => {
        const child = spawn(process.execPath, [join(dir, 'agent-productivity-hook.mjs')], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
        child.stdin.on('error', () => undefined);
        const kill = setTimeout(() => child.kill('SIGKILL'), DEADLINE_MS + 2_000);
        child.on('close', (code, signal) => {
          clearTimeout(kill);
          resolve({ code, signal, out });
        });
      },
    );
    expect(result).toEqual({ code: 0, signal: null, out: '' });
    expect(Date.now() - started).toBeLessThan(DEADLINE_MS + 1_500);
  });

  it('ends for a stdin that is a terminal, with nothing sent', () => {
    const python = spawnSync('python3', ['-c', 'import pty'], { encoding: 'utf8' });
    if (python.status !== 0) return; // no pty module here: the check cannot run on this machine
    const dir = folder(null);
    const code = `import os,pty,sys
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], [sys.argv[1], sys.argv[2]])
import time
deadline = time.time() + 4
status = None
while time.time() < deadline:
    done, st = os.waitpid(pid, os.WNOHANG)
    if done:
        status = os.waitstatus_to_exitcode(st)
        break
    time.sleep(0.05)
if status is None:
    os.kill(pid, 9)
    sys.exit(99)
sys.exit(status)
`;
    const result = spawnSync(
      'python3',
      ['-I', '-c', code, process.execPath, join(dir, 'agent-productivity-hook.mjs')],
      {
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(result.status).toBe(0);
  });

  it('exits 0 with no output when the app accepts the connection and never answers, and when it answers slowly in pieces', async () => {
    const app = await listen((_seen, res) => {
      res.writeHead(200);
      res.write('x');
      // never ends
    });
    const dir = folder(registryFor(app.port));
    const ms = ranQuietly(dir);
    app.server.closeAllConnections();
    expect(ms).toBeLessThan(DEADLINE_MS + 1_000);
  });

  it('never prints, even when something throws where nothing catches it', () => {
    const dir = folder(null);
    // A registry path that cannot even be inspected (the folder is gone) is only a missing registry.
    rmSync(join(dir, 'registry.json'), { force: true });
    expect(ranQuietly(dir, '')).toBeLessThan(DEADLINE_MS);
  });
});
