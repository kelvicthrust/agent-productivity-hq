import { appendFileSync, cpSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createDiscoveryStep,
  createLocalAdapters,
} from '../../../src/server/collectors/discovery.ts';
import { createRunner } from '../../../src/server/collectors/runner.ts';
import type { ImportProgress, SourceAdapter } from '../../../src/server/collectors/types.ts';
import { getRunningRun, getSourceState } from '../../../src/server/db/queries/sources.ts';
import { buildSources } from '../../../src/server/services/sources.ts';
import { memoryDb, memoryLogger, tempDir } from '../../server/helpers.ts';
import {
  CAN_DENY,
  FORBIDDEN,
  T0,
  TZ,
  everythingStored,
  expectOraclesMatch,
  history,
  makeHome,
  sessionSums,
  startMachine,
  usageAt,
  withoutAccess,
} from './helpers.ts';

// The runner with both real adapters and discovery, over a temp HOME holding copies of the INVENTED fixture logs (so the oracle
// totals agree with those logs, not with a real session). What a refresh does to a machine: first import, nothing new, a file
// that grew, a folder that cannot be read and the Retry that follows, and logs that are gone after a restart.

const DAY = 86_400_000;
const FIFTEEN_MINUTES = 15 * 60_000;
const claudeRoots = (home: string) => [
  join(home, '.claude/projects'),
  join(home, '.config/claude/projects'),
];

describe('a refresh on a machine with both providers', () => {
  it('imports both in one run, records both sources as found and ok, and agrees with the oracles to the token', async () => {
    const m = startMachine({ home: makeHome() });
    const run = await m.refresh();
    expect(run.state).toBe('succeeded');
    expect(run.sources['codex']).toMatchObject({ state: 'succeeded', imported: 3, unreadable: 0 });
    // 3 root sessions and 2 subagents across the two config dirs; session 2 is in both dirs and counts once.
    expect(run.sources['claude']).toMatchObject({ state: 'succeeded', imported: 6, unreadable: 0 });
    for (const id of ['codex', 'claude']) {
      expect(getSourceState(m.db, id), id).toMatchObject({
        status: 'ok',
        lastAttemptResult: 'succeeded',
        consecutiveFailures: 0,
        lastSuccessAt: T0,
        unreadableCount: 0,
      });
      expect(getSourceState(m.db, id)?.oldestEventAt, id).toBeGreaterThan(0);
    }
    expect(getSourceState(m.db, 'codex')?.location).toBe(join(m.home, '.codex/sessions'));
    expectOraclesMatch(m.db);
  });

  it('asks discovery before it attempts anything, and a failed look does not stop the run', async () => {
    const home = makeHome();
    const db = memoryDb();
    const logs = memoryLogger('debug');
    const runner = createRunner({
      db,
      now: () => T0,
      logger: logs.logger,
      adapters: createLocalAdapters({ env: {}, home }),
      beforeSources: [
        { name: 'broken look', run: () => Promise.reject(new Error('the look broke')) },
        createDiscoveryStep({ db, env: {}, home, logger: logs.logger }),
      ],
    });
    runner.start({ trigger: 'scheduler' });
    await runner.idle();
    const messages = logs.entries.map((entry) => entry['msg']);
    expect(messages).toContain('a step before the sources failed');
    expect(messages.indexOf('discovery')).toBeGreaterThan(-1);
    expect(messages.indexOf('discovery')).toBeLessThan(messages.indexOf('claude refresh read'));
    expect(sessionSums(db, 'claude').size).toBe(6); // the imports went ahead
  });

  it('shows progress on the first import, and says nothing when there is nothing new to read', async () => {
    const seen: Record<string, { progress: ImportProgress; shown: unknown }[]> = {};
    const m = startMachine({
      home: makeHome(),
      wrap: (adapters): SourceAdapter[] =>
        adapters.map((adapter) => ({
          id: adapter.id,
          refresh: (context) =>
            adapter.refresh({
              ...context,
              progress: (progress) => {
                context.progress(progress);
                // What the run row says at that moment: the client's 1-second poll reads exactly this.
                const shown = getRunningRun(context.db)?.sources[adapter.id];
                (seen[adapter.id] ??= []).push({ progress, shown });
              },
            }),
        })),
    });

    const first = await m.refresh();
    // "Importing 0 of N files" the moment the number of files to read is known, then once after every file.
    expect(seen['codex']?.map((item) => item.progress)).toEqual([
      { done: 0, total: 3 },
      { done: 1, total: 3 },
      { done: 2, total: 3 },
      { done: 3, total: 3 },
    ]);
    expect(seen['claude']?.[0]?.progress).toEqual({ done: 0, total: 7 });
    expect(seen['claude']?.at(-1)?.progress).toEqual({ done: 7, total: 7 });
    expect(seen['codex']?.[0]?.shown).toEqual({
      state: 'running',
      message: 'Importing 0 of 3 files',
    });
    expect(seen['claude']?.[0]?.shown).toEqual({
      state: 'running',
      message: 'Importing 0 of 7 files',
    });
    // The finished entry replaces the sentence: a late figure cannot bring it back.
    expect(first.sources['codex']).toEqual({
      state: 'succeeded',
      imported: 3,
      duplicatesSkipped: expect.any(Number),
      unreadable: 0,
    });

    const before = Object.values(seen).flat().length;
    m.tick(FIFTEEN_MINUTES);
    const second = await m.refresh();
    expect(second.state).toBe('succeeded');
    expect(Object.values(seen).flat()).toHaveLength(before);
  });

  it('reads no file and changes no row when nothing is new', async () => {
    const m = startMachine({ home: makeHome() });
    await m.refresh();
    const before = history(m.db);
    m.tick(FIFTEEN_MINUTES);
    const run = await m.refresh();
    expect(run.sources['codex']).toMatchObject({
      state: 'succeeded',
      imported: 0,
      duplicatesSkipped: 0,
    });
    expect(run.sources['claude']).toMatchObject({
      state: 'succeeded',
      imported: 0,
      duplicatesSkipped: 0,
    });
    // Every file row keeps the `last_read_at` of the first import: no file was opened.
    expect(history(m.db)).toEqual(before);
    expectOraclesMatch(m.db);
  });

  it('reads a grown Claude transcript from where it stopped, and a grown Codex rollout without counting anything twice', async () => {
    const m = startMachine({ home: makeHome() });
    await m.refresh();
    const before = history(m.db);
    m.tick(FIFTEEN_MINUTES);

    const claudeFile = join(
      m.home,
      '.claude/projects/-fixture-SENTINEL_CWD_d4e5f6-lib/33333333-cccc-4ccc-8ccc-000000000003.jsonl',
    );
    appendFileSync(
      claudeFile,
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-10-13T09:00:00.000Z',
        sessionId: '33333333-cccc-4ccc-8ccc-000000000003',
        message: {
          id: 'msg_grown_1',
          model: 'claude-sonnet-4-5',
          usage: {
            input_tokens: 4,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 100,
            output_tokens: 6,
          },
        },
        requestId: 'req_grown_1',
      }) + '\n',
    );

    const rollout = join(
      m.home,
      '.codex/sessions/2026/10/12/rollout-2026-10-12T09-00-00-aaaaaaaa-1111-4111-8111-00000000000a.jsonl',
    );
    const lastCount = readFileSync(rollout, 'utf8')
      .split('\n')
      .filter((line) => line.includes('"token_count"'))
      .at(-1)!;
    const next = JSON.parse(lastCount) as {
      timestamp: string;
      payload: {
        info: {
          total_token_usage: Record<string, number>;
          last_token_usage: Record<string, number>;
        };
      };
    };
    next.timestamp = '2026-10-12T09:30:00.000Z';
    const grown: Record<string, number> = {
      input_tokens: 100,
      cached_input_tokens: 50,
      output_tokens: 20,
      reasoning_output_tokens: 5,
      total_tokens: 120,
    };
    const totals = next.payload.info.total_token_usage;
    for (const [key, by] of Object.entries(grown)) totals[key] = (totals[key] ?? 0) + by;
    // Codex writes the request's own usage beside the running total, and the oracle counts that: a consistent line says the same.
    next.payload.info.last_token_usage = grown;
    appendFileSync(rollout, JSON.stringify(next) + '\n');

    const codexBefore = sessionSums(m.db, 'codex').get('aaaaaaaa-1111-4111-8111-00000000000a');
    const claudeBefore = sessionSums(m.db, 'claude').get('33333333-cccc-4ccc-8ccc-000000000003');
    const run = await m.refresh();
    expect(run.state).toBe('succeeded');

    expect(sessionSums(m.db, 'claude').get('33333333-cccc-4ccc-8ccc-000000000003')?.['total']).toBe(
      claudeBefore!['total']! + 110,
    );
    expect(sessionSums(m.db, 'codex').get('aaaaaaaa-1111-4111-8111-00000000000a')?.['total']).toBe(
      codexBefore!['total']! + 120,
    );
    const after = history(m.db);
    expect(after.events['n']).toBe((before.events['n'] as number) + 2);
    // Both growing files and the Codex child were read; the unrelated files retain their checkpoints.
    const changed = after.files.filter(
      (file, index) => JSON.stringify(file) !== JSON.stringify(before.files[index]),
    );
    const child = join(
      m.home,
      '.codex/sessions/2026/10/12/rollout-2026-10-12T09-05-00-bbbbbbbb-2222-4222-8222-00000000000b.jsonl',
    );
    expect(changed.map((file) => file['path'])).toEqual([claudeFile, rollout, child].sort());
    expect(changed.find((file) => file['path'] === claudeFile)).toMatchObject({
      read_offset: readFileSync(claudeFile).length,
      state: 'ok',
    });
  });

  it('follows a changed override without a restart: the folders are worked out again at every attempt', async () => {
    const empty = tempDir();
    const elsewhere = tempDir();
    const source = makeHome();
    const env: Record<string, string | undefined> = {};
    const m = startMachine({ home: empty, env });

    const nothing = await m.refresh();
    expect(nothing.state).toBe('succeeded'); // nothing to attempt is not a failure
    expect(nothing.sources['codex']).toMatchObject({ state: 'skipped' });
    expect(getSourceState(m.db, 'codex')).toMatchObject({
      status: 'notfound',
      lastAttemptAt: null,
      consecutiveFailures: 0,
    });

    // Codex now lives somewhere else and the variable says so.
    cpSync(join(source, '.codex'), join(elsewhere, 'codex-data'), { recursive: true });
    env['CODEX_HOME'] = join(elsewhere, 'codex-data');
    m.tick(FIFTEEN_MINUTES);
    const found = await m.refresh();
    expect(found.sources['codex']).toMatchObject({ state: 'succeeded', imported: 3 });
    expect(getSourceState(m.db, 'codex')).toMatchObject({ status: 'ok', consecutiveFailures: 0 });
    expect(getSourceState(m.db, 'claude')?.status).toBe('notfound');
  });

  it('keeps no prompt, reply, tool text or token from the logs, in the database or the log lines', async () => {
    const m = startMachine({ home: makeHome() });
    await m.refresh();
    m.tick(FIFTEEN_MINUTES);
    await m.refresh();
    for (const [table, text] of Object.entries(everythingStored(m.db)))
      expect(text, table).not.toMatch(FORBIDDEN);
    // The run rows, source rows and every log line, at debug level: not a prompt, and not a path (a project name is in it).
    expect(JSON.stringify(m.logs.entries)).not.toMatch(/SENTINEL/);
    expect(JSON.stringify(m.logs.entries)).not.toContain(m.home);
  });
});

describe.skipIf(!CAN_DENY)('EACCES, then Retry', () => {
  it('a Claude folder that cannot be read fails the attempt and leaves everything imported; Retry brings it back', async () => {
    const m = startMachine({ home: makeHome() });
    await m.refresh();
    const before = history(m.db);

    m.tick(FIFTEEN_MINUTES);
    const denied = await withoutAccess(claudeRoots(m.home), () => m.refresh());
    expect(denied.state).toBe('partial'); // Claude failed, Codex did not
    expect(denied.sources['claude']).toMatchObject({ state: 'failed' });
    expect(denied.sources['codex']).toMatchObject({ state: 'succeeded' });
    expect(getSourceState(m.db, 'claude')).toMatchObject({
      status: 'denied',
      lastAttemptResult: 'failed',
      consecutiveFailures: 1,
      errorCode: 'access_denied',
      lastSuccessAt: T0, // the last time data came in
    });
    expect(getSourceState(m.db, 'codex')?.consecutiveFailures).toBe(0);
    expect(history(m.db)).toEqual(before); // nothing deleted, nothing changed (P-07)

    m.tick(FIFTEEN_MINUTES);
    await withoutAccess(claudeRoots(m.home), () => m.refresh());
    expect(getSourceState(m.db, 'claude')?.consecutiveFailures).toBe(2); // "failed again"
    const sources = buildSources(m.db, { timezone: TZ }).sources ?? [];
    expect(sources.find((source) => source.id === 'claude')).toMatchObject({
      status: 'denied',
      consecutiveFailures: 2,
      lastAttemptResult: 'failed',
    });

    // Permissions fixed. Retry is an ordinary run: the source is attempted again and the history is the same history.
    m.tick(FIFTEEN_MINUTES);
    const retry = await m.refresh();
    expect(retry.state).toBe('succeeded');
    expect(getSourceState(m.db, 'claude')).toMatchObject({
      status: 'ok',
      lastAttemptResult: 'succeeded',
      consecutiveFailures: 0,
      errorCode: null,
    });
    expect(history(m.db).events).toEqual(before.events);
    expectOraclesMatch(m.db);
  });

  it('coverage reads stale while the folder is denied, from the last day that was collected, and ok again after Retry', async () => {
    const m = startMachine({ home: makeHome() });
    await m.refresh();
    const query = '?start=2026-11-02&end=2026-11-08&provider=claude';

    m.tick(3 * DAY);
    await withoutAccess(claudeRoots(m.home), () => m.refresh());
    const denied = await usageAt(m.db, T0 + 3 * DAY, query);
    expect(denied.claude?.coverage).toBe('stale');

    m.tick(FIFTEEN_MINUTES);
    await m.refresh();
    expect((await usageAt(m.db, T0 + 3 * DAY + FIFTEEN_MINUTES, query)).claude?.coverage).toBe(
      'ok',
    );
  });

  it('a Claude folder denied from the very first attempt fails with nothing imported, and Retry imports everything', async () => {
    const m = startMachine({ home: makeHome() });
    const denied = await withoutAccess(claudeRoots(m.home), () => m.refresh());
    expect(denied.sources['claude']).toMatchObject({ state: 'failed' });
    expect(getSourceState(m.db, 'claude')).toMatchObject({
      status: 'denied',
      lastSuccessAt: null,
      consecutiveFailures: 1,
    });
    expect(sessionSums(m.db, 'claude').size).toBe(0);
    // Never imported, so there is no history to cover: "none", not a zero.
    expect(
      (await usageAt(m.db, T0, '?start=2026-11-02&end=2026-11-08&provider=claude')).claude
        ?.coverage,
    ).toBe('none');

    m.tick(FIFTEEN_MINUTES);
    const retry = await m.refresh();
    expect(retry.state).toBe('succeeded');
    expect(getSourceState(m.db, 'claude')).toMatchObject({ status: 'ok', consecutiveFailures: 0 });
    expectOraclesMatch(m.db);
  });

  it('one transcript that cannot be opened makes the source partial, the rest is imported, and Retry reads it', async () => {
    const m = startMachine({ home: makeHome() });
    const project = join(m.home, '.claude/projects/-fixture-SENTINEL_CWD_d4e5f6-lib');
    const file = join(
      project,
      readdirSync(project).find((name) => name.endsWith('.jsonl'))!,
    );

    const run = await withoutAccess([file], () => m.refresh());
    expect(run.state).toBe('partial');
    expect(run.sources['claude']).toMatchObject({ state: 'partial', unreadable: 1 });
    expect(getSourceState(m.db, 'claude')).toMatchObject({
      status: 'partial',
      unreadableCount: 1,
      consecutiveFailures: 0, // partial is not a failure
    });
    expect(sessionSums(m.db, 'claude').size).toBe(5); // everything but session 3

    m.tick(FIFTEEN_MINUTES);
    const retry = await m.refresh(); // the file's size and mtime did not change: it is retried because it was unreadable
    expect(retry.state).toBe('succeeded');
    expect(getSourceState(m.db, 'claude')).toMatchObject({ status: 'ok', unreadableCount: 0 });
    expectOraclesMatch(m.db);
  });

  it('a Codex sessions/ folder that cannot be read is partial (archived_sessions/ is still read); Retry reads the rest', async () => {
    const m = startMachine({ home: makeHome() });
    const run = await withoutAccess([join(m.home, '.codex/sessions')], () => m.refresh());
    expect(run.sources['codex']).toMatchObject({ state: 'partial', imported: 1 });
    expect(getSourceState(m.db, 'codex')).toMatchObject({
      status: 'partial',
      consecutiveFailures: 0,
    });

    m.tick(FIFTEEN_MINUTES);
    const retry = await m.refresh();
    expect(retry.sources['codex']).toMatchObject({ state: 'succeeded', imported: 2 });
    expect(getSourceState(m.db, 'codex')).toMatchObject({ status: 'ok', unreadableCount: 0 });
    expectOraclesMatch(m.db);
  });

  it('a Codex home that cannot be entered fails the attempt and keeps the history; Retry brings it back', async () => {
    const m = startMachine({ home: makeHome() });
    await m.refresh();
    const before = history(m.db);

    m.tick(FIFTEEN_MINUTES);
    const denied = await withoutAccess([join(m.home, '.codex')], () => m.refresh());
    expect(denied.sources['codex']).toMatchObject({ state: 'failed' });
    expect(getSourceState(m.db, 'codex')).toMatchObject({
      status: 'denied',
      consecutiveFailures: 1,
      errorCode: 'access_denied',
    });
    expect(history(m.db)).toEqual(before);

    m.tick(FIFTEEN_MINUTES);
    await m.refresh();
    expect(getSourceState(m.db, 'codex')).toMatchObject({ status: 'ok', consecutiveFailures: 0 });
    expect(history(m.db).events).toEqual(before.events);
    expectOraclesMatch(m.db);
  });
});

describe('the logs are deleted, then the app restarts', () => {
  it('keeps every event, session and total, and the sources are not failures', async () => {
    const home = makeHome();
    const dbPath = join(tempDir(), 'agent-productivity.db');
    const first = startMachine({ home, dbPath });
    await first.refresh();
    const before = history(first.db);
    const oldest = getSourceState(first.db, 'claude')?.oldestEventAt;
    first.close();

    // Claude Code deletes old transcripts (30 days by default) and Codex's folder can be cleaned up: here all of it is gone.
    for (const folder of ['.claude', '.config/claude', '.codex'])
      rmSync(join(home, folder), { recursive: true, force: true });

    const second = startMachine({ home, dbPath, now: () => T0 + DAY });
    const run = await second.refresh();
    expect(run.state).toBe('succeeded');
    expect(run.sources['claude']).toMatchObject({ state: 'succeeded', imported: 0 });
    expect(run.sources['codex']).toMatchObject({ state: 'succeeded', imported: 0 });
    expect(history(second.db)).toEqual(before);
    expectOraclesMatch(second.db);
    for (const id of ['claude', 'codex'])
      expect(getSourceState(second.db, id), id).toMatchObject({
        lastAttemptResult: 'succeeded',
        consecutiveFailures: 0,
        errorCode: null,
      });
    expect(getSourceState(second.db, 'claude')?.oldestEventAt).toBe(oldest);

    // Sources still counts the sessions and still says where history starts; coverage over the days with data is still ok.
    const claude = buildSources(second.db, { timezone: TZ }).sources?.find(
      (s) => s.id === 'claude',
    );
    expect(claude).toMatchObject({ sessions: 6, oldestDate: '2026-10-12' });
    const days = await usageAt(
      second.db,
      T0 + DAY,
      '?start=2026-10-12&end=2026-10-18&provider=claude',
    );
    expect(days.claude?.coverage).toBe('ok');
    second.close();
  });

  it('copes with logs that come back: the same files are read again and nothing is counted twice', async () => {
    const home = makeHome();
    const dbPath = join(tempDir(), 'agent-productivity.db');
    const first = startMachine({ home, dbPath });
    await first.refresh();
    const before = history(first.db).events;
    first.close();

    const aside = join(tempDir(), 'aside');
    cpSync(join(home, '.codex'), aside, { recursive: true });
    rmSync(join(home, '.codex'), { recursive: true });
    const second = startMachine({ home, dbPath });
    await second.refresh();
    cpSync(aside, join(home, '.codex'), { recursive: true }); // copied back: new mtimes, same content
    second.tick(FIFTEEN_MINUTES);
    const run = await second.refresh();
    expect(run.sources['codex']).toMatchObject({ state: 'succeeded', imported: 0 });
    expect(history(second.db).events).toEqual(before);
    expectOraclesMatch(second.db);
    second.close();
  });
});
