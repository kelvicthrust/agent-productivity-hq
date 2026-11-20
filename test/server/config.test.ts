import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_PORT,
  LOOPBACK_HOST,
  baseUrl,
  defaultDataDir,
  loadConfig,
} from '../../src/server/lib/config.ts';

describe('config', () => {
  it('defaults to 127.0.0.1:4317 and the platform data folder', () => {
    const config = loadConfig({}, { platform: 'darwin', home: '/Users/k' });
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 4317,
      dataDir: '/Users/k/Library/Application Support/agent-productivity',
      dbPath: '/Users/k/Library/Application Support/agent-productivity/agent-productivity.db',
      logDir: '/Users/k/Library/Application Support/agent-productivity/logs',
      lockPath: '/Users/k/Library/Application Support/agent-productivity/agent-productivity.lock',
    });
    expect(DEFAULT_PORT).toBe(4317);
    expect(LOOPBACK_HOST).toBe('127.0.0.1');
    expect(baseUrl(4317)).toBe('http://127.0.0.1:4317');
  });

  it('follows XDG on Linux', () => {
    expect(defaultDataDir('linux', {}, '/home/k')).toBe(
      join('/home/k', '.local', 'share', 'agent-productivity'),
    );
    expect(defaultDataDir('linux', { XDG_DATA_HOME: '/data' }, '/home/k')).toBe(
      '/data/agent-productivity',
    );
  });

  it('takes AGENT_PRODUCTIVITY_PORT and AGENT_PRODUCTIVITY_DATA_DIR, and nothing else is a setting', () => {
    const config = loadConfig({
      AGENT_PRODUCTIVITY_PORT: '5001',
      AGENT_PRODUCTIVITY_DATA_DIR: '/tmp/crew-x',
    });
    expect(config.port).toBe(5001);
    expect(config.dataDir).toBe('/tmp/crew-x');
    expect(
      loadConfig({ AGENT_PRODUCTIVITY_PORT: '', AGENT_PRODUCTIVITY_DATA_DIR: '' }, { home: '/h' })
        .port,
    ).toBe(4317);
  });

  it.each(['0', '65536', '-1', 'abc', '80.5', '4317 ', '1e3', '0x10'])(
    'rejects AGENT_PRODUCTIVITY_PORT=%s',
    (port) => {
      expect(() =>
        loadConfig({ AGENT_PRODUCTIVITY_PORT: port, AGENT_PRODUCTIVITY_DATA_DIR: '/tmp/x' }),
      ).toThrow(ConfigError);
    },
  );

  it.each([
    '0.0.0.0',
    '::',
    '::1',
    'localhost',
    '192.168.1.5',
    '127.0.0.2',
    '10.0.0.1',
    'example.com',
  ])('refuses AGENT_PRODUCTIVITY_HOST=%s: only 127.0.0.1 is allowed', (host) => {
    expect(() =>
      loadConfig({ AGENT_PRODUCTIVITY_HOST: host, AGENT_PRODUCTIVITY_DATA_DIR: '/tmp/x' }),
    ).toThrow(/only listens on 127\.0\.0\.1/);
  });

  it('accepts AGENT_PRODUCTIVITY_HOST=127.0.0.1 (a no-op) and an empty value', () => {
    expect(
      loadConfig({ AGENT_PRODUCTIVITY_HOST: '127.0.0.1', AGENT_PRODUCTIVITY_DATA_DIR: '/tmp/x' })
        .host,
    ).toBe('127.0.0.1');
    expect(
      loadConfig({ AGENT_PRODUCTIVITY_HOST: '', AGENT_PRODUCTIVITY_DATA_DIR: '/tmp/x' }).host,
    ).toBe('127.0.0.1');
  });
});
