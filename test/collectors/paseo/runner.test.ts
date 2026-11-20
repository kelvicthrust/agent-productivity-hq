import { describe, expect, it } from 'vitest';
import { createPaseoAdapter } from '../../../src/server/collectors/paseo/index.ts';
import { createRunner } from '../../../src/server/collectors/runner.ts';
import { getRun, getSourceState } from '../../../src/server/db/queries/sources.ts';
import { NOW, memoryLogger } from '../../server/helpers.ts';
import { OK, daemonFrom, fixture, memoryDb, seedSession, sessionRow } from './helpers.ts';

// The Paseo adapter under the real runner: what the runner does with a skip and with a failure decides what Sources shows, so the
// adapter's two "source state" outcomes are checked against it, not only against the report they return.

async function run(db: ReturnType<typeof memoryDb>, daemon: ReturnType<typeof daemonFrom>) {
  const runner = createRunner({
    db,
    now: () => NOW,
    logger: memoryLogger().logger,
    adapters: [createPaseoAdapter({ open: daemon.open })],
  });
  const started = runner.start({ trigger: 'manual', sources: ['paseo'] });
  await runner.idle();
  const id = started.started ? started.run.id : started.runId;
  return getRun(db, id)?.sources['paseo'];
}

describe('Paseo under the runner', () => {
  it('a reachable daemon: the source is ok, with a plain message and a last success', async () => {
    const db = memoryDb();
    const session = seedSession(db, 'codex', OK.parentSession);

    const entry = await run(db, daemonFrom(fixture('ok')));

    expect(entry).toMatchObject({ state: 'succeeded', message: expect.stringContaining('Read 5') });
    expect(getSourceState(db, 'paseo')).toMatchObject({
      status: 'ok',
      lastAttemptResult: 'succeeded',
      lastSuccessAt: NOW,
      consecutiveFailures: 0,
    });
    expect(sessionRow(db, session)).toMatchObject({ paseo_agent_id: OK.parentAgent });
  });

  it('no daemon: the run says skipped and Sources says notrunning, with no failure counted', async () => {
    const db = memoryDb();

    const entry = await run(db, daemonFrom(fixture('down')));

    expect(entry).toMatchObject({ state: 'skipped' });
    expect(getSourceState(db, 'paseo')).toMatchObject({
      status: 'notrunning',
      location: 'ws://127.0.0.1:6767/ws',
      lastAttemptAt: null,
      consecutiveFailures: 0,
    });
  });

  it('a password: the run says skipped and Sources says needspassword, with no failure counted', async () => {
    const db = memoryDb();

    const entry = await run(db, daemonFrom(fixture('password')));

    expect(entry).toMatchObject({ state: 'skipped' });
    expect(getSourceState(db, 'paseo')).toMatchObject({
      status: 'needspassword',
      lastAttemptAt: null,
      consecutiveFailures: 0,
    });
  });

  it('the daemon coming back after it was off returns the source to ok', async () => {
    const db = memoryDb();
    await run(db, daemonFrom(fixture('down')));

    await run(db, daemonFrom(fixture('ok')));

    expect(getSourceState(db, 'paseo')).toMatchObject({
      status: 'ok',
      lastAttemptResult: 'succeeded',
    });
  });
});
