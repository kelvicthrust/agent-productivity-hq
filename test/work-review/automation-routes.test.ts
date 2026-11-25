import { expect, it, vi } from 'vitest';
import { setMeta } from '../../src/server/db/queries/meta.ts';
import { createWorkReviewService } from '../../src/server/services/work-review/service.ts';
import { call, HOST, memoryDb, NOW, testApp, TZ, WRITE } from '../server/helpers.ts';

const path = '/api/work-review/automation';

it('requires a connected owner opt-in and clears it on account changes and reset', async () => {
  const db = memoryDb();
  let connected = false;
  const status = () => ({
    status: connected ? ('connected' as const) : ('disconnected' as const),
    account: null,
    message: null,
  });
  const worker = { extract: vi.fn(), summarize: vi.fn() };
  const workReview = createWorkReviewService({
    db,
    timezone: TZ,
    now: () => NOW,
    worker,
    accountStatus: () => status().status,
  });
  const { app } = testApp({
    db,
    workReview,
    reviewAuth: {
      status,
      connect: async (newProfile, clear) => {
        if (newProfile) await clear?.();
        return { url: 'https://auth.openai.com/api/accounts/authorize' };
      },
      disconnect: async (clear) => {
        connected = false;
        await clear?.();
        return status();
      },
      reset: async () => {},
      close: async () => {},
      accessToken: vi.fn(),
      invalidateAccessToken: vi.fn(),
    },
  });
  const get = async () => (await call(app, path, { headers: HOST })).json();
  const post = (url: string, body: unknown, headers: Record<string, string> = WRITE) =>
    call(app, url, { method: 'POST', headers, body: JSON.stringify(body) });

  try {
    expect(await get()).toEqual({ enabled: false });
    expect((await post(path, { enabled: true })).status).toBe(400);
    setMeta(db, 'setup_completed_at', '1');
    expect((await post(path, { enabled: true })).status).toBe(502);
    connected = true;
    expect((await post(path, { enabled: true }, HOST)).status).toBe(403);
    expect((await post(path, { enabled: 'yes' })).status).toBe(400);
    expect(await get()).toEqual({ enabled: false });

    for (const [url, body] of [
      ['/api/work-review/account/connect', { newProfile: true }],
      ['/api/work-review/account/disconnect', {}],
      ['/api/setup/reset', { confirmed: true }],
    ] as const) {
      connected = true;
      expect(await (await post(path, { enabled: true })).json()).toEqual({ enabled: true });
      expect(await get()).toEqual({ enabled: true });
      expect((await post(url, body)).ok).toBe(true);
      expect(await get()).toEqual({ enabled: false });
    }
    expect(worker.extract).not.toHaveBeenCalled();
    expect(worker.summarize).not.toHaveBeenCalled();
  } finally {
    await workReview.close();
    db.close();
  }
});
