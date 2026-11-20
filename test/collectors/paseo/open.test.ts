import { afterEach, describe, expect, it, vi } from 'vitest';

// The default opener is the one place the real SDK is used. Here the SDK module is replaced, so no client is made and no socket is
// opened: what is checked is how the opener configures it.

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('@getpaseo/client');
  vi.doUnmock('@getpaseo/client/internal/daemon-client');
});

describe('openPaseoClient', () => {
  it('gives the SDK an address and no password, no auth header and no reconnecting', async () => {
    const createPaseoClient = vi.fn(() => ({ fake: true }));
    vi.doMock('@getpaseo/client', () => ({ createPaseoClient }));
    const { openPaseoClient } = await import('../../../src/server/collectors/paseo/open.ts');

    await openPaseoClient('ws://127.0.0.1:6767/ws');

    // Exactly these keys: a password, an auth header or a credential would show up as an extra one.
    expect(createPaseoClient).toHaveBeenCalledExactlyOnceWith({
      url: 'ws://127.0.0.1:6767/ws',
      reconnect: { enabled: false },
      connectTimeoutMs: 8_000,
    });
  });

  it('does not read a password from the environment', async () => {
    const createPaseoClient = vi.fn(() => ({ fake: true }));
    vi.doMock('@getpaseo/client', () => ({ createPaseoClient }));
    vi.stubEnv('PASEO_PASSWORD', 'SENTINEL_PASSWORD_1');
    const { openPaseoClient } = await import('../../../src/server/collectors/paseo/open.ts');

    try {
      await openPaseoClient('ws://127.0.0.1:6767/ws');
    } finally {
      vi.unstubAllEnvs();
    }

    expect(JSON.stringify(createPaseoClient.mock.calls)).not.toContain('SENTINEL_PASSWORD_1');
  });

  it('a missing SDK rejects with the code sdk_unavailable, so the attempt fails instead of the process', async () => {
    vi.doMock('@getpaseo/client', () => {
      throw new Error('Cannot find package');
    });
    const { openPaseoClient } = await import('../../../src/server/collectors/paseo/open.ts');

    await expect(openPaseoClient('ws://127.0.0.1:6767/ws')).rejects.toMatchObject({
      code: 'SDK_UNAVAILABLE',
    });
  });
});

describe('openPaseoLiveClient', () => {
  const INTERNAL = '@getpaseo/client/internal/daemon-client';

  it('is configured like the batch client: no password, no auth header, no SDK reconnecting, an 8 s connect timeout, no SDK logging', async () => {
    const DaemonClient = vi.fn();
    vi.doMock(INTERNAL, () => ({ DaemonClient }));
    vi.stubEnv('PASEO_PASSWORD', 'SENTINEL_PASSWORD_2');
    const { openPaseoLiveClient } = await import('../../../src/server/collectors/paseo/open.ts');

    try {
      await openPaseoLiveClient('ws://127.0.0.1:6767/ws');
    } finally {
      vi.unstubAllEnvs();
    }

    // Exactly these keys: a password, an auth header or a credential would show up as an extra one.
    expect(DaemonClient).toHaveBeenCalledExactlyOnceWith({
      url: 'ws://127.0.0.1:6767/ws',
      clientId: expect.stringMatching(/^paseo-sdk-.+/),
      clientType: 'cli',
      reconnect: { enabled: false },
      connectTimeoutMs: 8_000,
      transportFactory: expect.any(Function),
      // Added with the inbound allowlist (liveTransport.ts): HQ does not offer binary chunking, so no frame arrives in pieces.
      capabilities: { binary_chunking_v1: false },
      logger: expect.objectContaining({
        debug: expect.any(Function),
        info: expect.any(Function),
        warn: expect.any(Function),
        error: expect.any(Function),
      }),
    });
    expect(JSON.stringify(DaemonClient.mock.calls)).not.toContain('SENTINEL_PASSWORD_2');
  });

  it('gives the SDK a logger that prints nothing', async () => {
    const DaemonClient = vi.fn();
    vi.doMock(INTERNAL, () => ({ DaemonClient }));
    const spies = (['debug', 'log', 'info', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    const { openPaseoLiveClient } = await import('../../../src/server/collectors/paseo/open.ts');
    try {
      await openPaseoLiveClient('ws://127.0.0.1:6767/ws');
      const config = (
        DaemonClient.mock.calls[0] as unknown as [
          { logger: Record<string, (o: object, m?: string) => void> },
        ]
      )[0];
      for (const level of ['debug', 'info', 'warn', 'error'])
        config.logger[level]?.({ err: new Error('SENTINEL_DAEMON_ERROR_DETAIL') }, 'x');
      expect(spies.flatMap((spy) => spy.mock.calls)).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('does not load the SDK until it is asked for a client, and a missing SDK rejects with sdk_unavailable', async () => {
    const loaded = vi.fn(() => {
      throw new Error('Cannot find package');
    });
    vi.doMock(INTERNAL, loaded);
    const { openPaseoLiveClient } = await import('../../../src/server/collectors/paseo/open.ts');
    expect(loaded).not.toHaveBeenCalled();

    await expect(openPaseoLiveClient('ws://127.0.0.1:6767/ws')).rejects.toMatchObject({
      code: 'SDK_UNAVAILABLE',
    });
  });
});
