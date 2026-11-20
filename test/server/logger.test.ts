import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REDACTED, createLogger, fileSink, redact } from '../../src/server/lib/logger.ts';
import { modeOf } from '../../src/server/lib/fsModes.ts';
import { mintToken } from '../fixtures/github/scripted-github.ts';
import { tempDir } from './helpers.ts';

const capture = () => {
  const lines: string[] = [];
  const logger = createLogger({
    sink: (line) => lines.push(line),
    now: () => Date.parse('2026-11-04T20:00:00Z'),
  });
  return { logger, lines, last: () => JSON.parse(lines.at(-1)!) as Record<string, unknown> };
};

describe('structured logs', () => {
  it('writes one JSON object per line with level, ts and the schema fields', () => {
    const { logger, last } = capture();
    logger.info('refresh finished', {
      source: 'codex',
      runId: 7,
      correlationId: 'c-1',
      code: 'ok',
    });
    expect(last()).toEqual({
      ts: '2026-11-04T20:00:00.000Z',
      level: 'info',
      msg: 'refresh finished',
      source: 'codex',
      runId: 7,
      correlationId: 'c-1',
      code: 'ok',
    });
  });

  it('honours the level', () => {
    const { logger, lines } = capture();
    logger.debug('quiet');
    expect(lines).toEqual([]);
    logger.warn('loud');
    expect(lines).toHaveLength(1);
  });
});

describe('redaction: no line text, prompts or tokens in a log', () => {
  it('replaces fields that can carry secrets or source text', () => {
    const out = redact({
      source: 'codex',
      token: 'abc',
      accessToken: 'abc',
      Authorization: 'Bearer abc',
      password: 'p',
      prompt: 'write me a poem',
      line: '{"role":"user","content":"hi"}',
      text: 'hello',
      content: 'hello',
      body: { a: 1 },
      transcript: 'x',
      apiKey: 'k',
      count: 3,
    }) as Record<string, unknown>;
    expect(out).toEqual({
      source: 'codex',
      token: REDACTED,
      accessToken: REDACTED,
      Authorization: REDACTED,
      password: REDACTED,
      prompt: REDACTED,
      line: REDACTED,
      text: REDACTED,
      content: REDACTED,
      body: REDACTED,
      transcript: REDACTED,
      apiKey: REDACTED,
      count: 3,
    });
  });

  it('keeps plain counts that happen to contain "line"', () => {
    expect(redact({ unreadableLines: 2, unreadable_lines: 3 })).toEqual({
      unreadableLines: 2,
      unreadable_lines: 3,
    });
  });

  it('masks token-shaped values inside otherwise ordinary text, at any depth', () => {
    const secrets = [
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz',
      'sk-abcdefghijklmnopqrstuvwxyz',
      'Bearer eyJhbGciOiJIUzI1NiJ9.abcdefgh.ijklmnopqrst',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV',
    ];
    const { logger, lines } = capture();
    logger.error(`request failed with ${secrets[0]}`, {
      detail: { nested: [`x ${secrets[1]} y`, secrets[2]], deeper: { s: secrets[3] } },
      error: new Error(`bad ${secrets[4]}`),
    });
    for (const secret of secrets)
      expect(lines.join('\n')).not.toContain(secret.replace('Bearer ', ''));
    expect(lines[0]).toContain(REDACTED);
  });

  it('masks GitHub user, refresh and CLI tokens and a Bearer header, as message, field, nested value or error', () => {
    // minted at run time, so no token-shaped literal sits in the repository
    const tokens = [mintToken('ghu'), mintToken('ghr'), mintToken('gho')];
    const { logger, lines } = capture();
    logger.error(`GitHub answered 401 for ${tokens[0]}`, {
      source: 'github',
      detail: {
        header: `Authorization: Bearer ${tokens[1]}`,
        nested: [{ note: `retry with ${tokens[2]}` }],
      },
      headers: { Authorization: `Bearer ${tokens[0]}` },
      grant: { access_token: tokens[0], refresh_token: tokens[1] },
      error: new Error(`refresh failed for ${tokens[1]}`),
    });
    const written = lines.join('\n');
    for (const token of tokens) expect(written).not.toContain(token);
    expect(written).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{8,}/);
    expect(written).toContain(REDACTED);
    // the ordinary fields beside them survive
    expect(JSON.parse(lines[0]!)).toMatchObject({ source: 'github', level: 'error' });
  });

  it('logs an error as name, message and code only: no stack, no path', () => {
    const { logger, last } = capture();
    const error = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    logger.warn('could not read', { source: 'codex', error });
    expect(last()['error']).toEqual({
      name: 'Error',
      message: 'EACCES: permission denied',
      code: 'EACCES',
    });
    expect(JSON.stringify(last())).not.toContain('logger.test');
  });

  it('bounds long strings, deep objects and long arrays', () => {
    const out = redact({
      s: 'x'.repeat(5000),
      a: Array.from({ length: 500 }, (_, i) => i),
      d: { a: { b: { c: { d: { e: 1 } } } } },
    }) as {
      s: string;
      a: number[];
      d: unknown;
    };
    expect(out.s.length).toBeLessThan(400);
    expect(out.a).toHaveLength(50);
    expect(JSON.stringify(out.d)).toContain('[truncated]');
  });
});

describe('log file', () => {
  it('is <dir>/agent-productivity.log, private (0600) in a private folder (0700)', () => {
    const dir = join(tempDir(), 'logs');
    const sink = fileSink(dir);
    createLogger({ sink }).info('hello', { source: 'test' });
    expect(sink.path).toBe(join(dir, 'agent-productivity.log'));
    expect(JSON.parse(readFileSync(sink.path, 'utf8').trim())).toMatchObject({
      msg: 'hello',
      source: 'test',
    });
    expect(modeOf(dir)).toBe(0o700);
    expect(modeOf(sink.path)).toBe(0o600);
  });

  it('rotates by size, keeps 5 files in all, drops the oldest, and keeps every file private', () => {
    const dir = join(tempDir(), 'logs');
    const sink = fileSink(dir, { maxBytes: 400, maxFiles: 5 });
    const logger = createLogger({ sink });
    for (let i = 0; i < 60; i++)
      logger.info(`entry ${i}`, { source: 'test', n: i, pad: 'p'.repeat(40) });
    const files = readdirSync(dir).sort();
    expect(files).toEqual([
      'agent-productivity.log',
      'agent-productivity.log.1',
      'agent-productivity.log.2',
      'agent-productivity.log.3',
      'agent-productivity.log.4',
    ]);
    expect(existsSync(join(dir, 'agent-productivity.log.5'))).toBe(false);
    for (const name of files) {
      expect(modeOf(join(dir, name)), name).toBe(0o600);
      expect(readFileSync(join(dir, name), 'utf8').length).toBeLessThanOrEqual(400 + 200);
    }
    // Newest entries are in agent-productivity.log, older ones in higher numbers; the very oldest are gone.
    const first = (name: string) =>
      JSON.parse(readFileSync(join(dir, name), 'utf8').split('\n')[0]!) as { n: number };
    expect(first('agent-productivity.log').n).toBeGreaterThan(first('agent-productivity.log.1').n);
    expect(first('agent-productivity.log.1').n).toBeGreaterThan(
      first('agent-productivity.log.4').n,
    );
    expect(first('agent-productivity.log.4').n).toBeGreaterThan(0);
  });

  it('defaults to five files of 5 MB', async () => {
    const { MAX_LOG_BYTES, MAX_LOG_FILES } = await import('../../src/server/lib/logger.ts');
    expect(MAX_LOG_BYTES).toBe(5 * 1024 * 1024);
    expect(MAX_LOG_FILES).toBe(5);
  });
});
