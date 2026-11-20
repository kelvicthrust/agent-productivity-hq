import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClaudeAdapter } from '../../../src/server/collectors/claude/index.ts';
import { tempDir } from '../../server/helpers.ts';
import {
  appendLines,
  assistantLine,
  eventKeys,
  fileRows,
  putTranscript,
  sessionById,
  sessionRows,
  setup,
  totalsOf,
  userLine,
} from './helpers.ts';

// Refreshing over time on folders the tests build: reading from the stored offset, replacing a message by its last line,
// what happens to a file that is half-written, unreadable or replaced, and what each kind of root says. Every transcript is
// invented (SENTINEL_ text where a prompt or a reply would be).

const canDeny = process.getuid?.() !== 0;
const at = (iso: string): number => Date.parse(iso);

const SESSION = 'aaaaaaaa-1111-4111-8111-000000000001';
const MAIN = `-fixture-SENTINEL_CWD_t1-app/${SESSION}.jsonl`;

describe('reading from the stored offset', () => {
  it('ranks a main-thread copy over a previously imported sidechain line in the same file', async () => {
    const dir = tempDir();
    const sidechain = JSON.parse(
      assistantLine({ id: 'msg_shared', at: '2026-10-20T10:00:05Z', output: 100 }),
    ) as Record<string, unknown>;
    const path = putTranscript(dir, MAIN, [JSON.stringify({ ...sidechain, isSidechain: true })]);
    const incremental = setup(() => [dir]);
    await incremental.refresh();
    expect(totalsOf(incremental.db).total).toBe(101);

    appendLines(path, [
      assistantLine({ id: 'msg_shared', at: '2026-10-20T10:00:09Z', output: 29 }),
    ]);
    await incremental.refresh();
    const fresh = setup(() => [dir]);
    await fresh.refresh();
    expect(totalsOf(incremental.db)).toEqual(totalsOf(fresh.db));
    expect(totalsOf(incremental.db)).toMatchObject({ events: 1, total: 30 });
  });

  it('keeps a legacy winner while its transcript is unavailable and resumes with the staged candidate', async () => {
    const dir = tempDir();
    const sidechain = JSON.parse(
      assistantLine({ id: 'msg_shared', at: '2026-10-20T10:00:05Z', output: 100 }),
    ) as Record<string, unknown>;
    const firstCopy = JSON.stringify({ ...sidechain, isSidechain: true });
    const path = putTranscript(dir, MAIN, [firstCopy]);
    const { db, refresh } = setup(() => [dir]);
    await refresh();
    db.exec('UPDATE usage_event SET claude_sidechain = NULL, claude_has_speed = NULL');
    db.exec('UPDATE source_file SET normalization_version = NULL');
    rmSync(path);

    const other = 'aaaaaaaa-1111-4111-8111-000000000002';
    putTranscript(dir, `fixture/${other}.jsonl`, [
      assistantLine({ id: 'msg_shared', at: '2026-10-20T10:00:09Z', output: 29 }),
    ]);
    expect(await refresh()).toMatchObject({
      result: 'partial',
      message: expect.stringContaining('awaiting reconciliation'),
    });
    expect(totalsOf(db)).toMatchObject({ events: 1, total: 101 });
    expect(db.prepare('SELECT owner_recovered FROM claude_legacy_candidate').get()).toMatchObject({
      owner_recovered: 0,
    });

    putTranscript(dir, MAIN, [firstCopy]);
    expect(await refresh()).toMatchObject({ result: 'succeeded' });
    expect(totalsOf(db, other)).toMatchObject({ events: 1, total: 30 });
    expect(db.prepare('SELECT owner_recovered FROM claude_legacy_candidate').all()).toEqual([]);
  });

  it('reads only what was appended, so old messages are not seen again, and moves the offset to the end', async () => {
    const dir = tempDir();
    const path = putTranscript(dir, MAIN, [
      userLine('2026-10-20T10:00:00Z'),
      assistantLine({ id: 'm1', at: '2026-10-20T10:00:05Z', output: 10 }),
      assistantLine({ id: 'm2', at: '2026-10-20T10:00:09Z', output: 20 }),
    ]);
    const { db, refresh } = setup(() => [dir]);
    expect(await refresh()).toMatchObject({ imported: 1, duplicatesSkipped: 0 });
    expect(totalsOf(db).events).toBe(2);

    appendLines(path, [assistantLine({ id: 'm3', at: '2026-10-20T10:05:00Z', output: 30 })]);
    const second = await refresh();
    // Re-reading from the start would have met m1 and m2 again and reported them as duplicates.
    expect(second).toMatchObject({ result: 'succeeded', imported: 0, duplicatesSkipped: 0 });
    expect(totalsOf(db).events).toBe(3);
    const [file] = fileRows(db);
    expect(file!.readOffset).toBe(statSync(path).size);
    expect(sessionById(db, SESSION)).toMatchObject({
      startedAt: at('2026-10-20T10:00:00Z'),
      lastEventAt: at('2026-10-20T10:05:00Z'),
    });
  });

  it('[A4] keeps the larger total of a message continued in an appended read, never a smaller one, and the first of equal ones', async () => {
    const dir = tempDir();
    const path = putTranscript(dir, MAIN, [
      assistantLine({ id: 'm1', at: '2026-10-20T10:00:05Z', output: 50 }),
    ]);
    const { db, refresh } = setup(() => [dir]);
    await refresh();
    expect(totalsOf(db).output).toBe(50);

    appendLines(path, [assistantLine({ id: 'm1', at: '2026-10-20T10:00:07Z', output: 20 })]);
    expect(await refresh()).toMatchObject({ duplicatesSkipped: 1 });
    expect(totalsOf(db)).toMatchObject({ events: 1, output: 50, total: 51 }); // smaller: the stored one stays

    appendLines(path, [assistantLine({ id: 'm1', at: '2026-10-20T10:00:09Z', output: 80 })]);
    await refresh();
    expect(totalsOf(db)).toMatchObject({ events: 1, output: 80, total: 81 }); // larger: it replaces
    expect(eventKeys(db)).toEqual(['m1:req_m1']);

    // The same figures again change nothing and count as a duplicate.
    appendLines(path, [assistantLine({ id: 'm1', at: '2026-10-20T10:00:09Z', output: 80 })]);
    expect(await refresh()).toMatchObject({ duplicatesSkipped: 1 });
    expect(totalsOf(db).output).toBe(80);
  });

  it('leaves a line the provider is still writing until it is complete', async () => {
    const dir = tempDir();
    const whole = assistantLine({ id: 'm2', at: '2026-10-20T10:00:09Z', output: 20 });
    const path = putTranscript(dir, MAIN, [
      assistantLine({ id: 'm1', at: '2026-10-20T10:00:05Z', output: 10 }),
    ]);
    appendFileSync(path, whole.slice(0, 60)); // no newline yet, and not JSON
    const { db, refresh } = setup(() => [dir]);
    const first = await refresh();
    expect(first).toMatchObject({ result: 'succeeded', unreadable: 0 }); // not a damaged line: an unfinished one
    expect(totalsOf(db).events).toBe(1);
    const [file] = fileRows(db);
    expect(file!.readOffset).toBeLessThan(statSync(path).size);

    appendFileSync(path, `${whole.slice(60)}\n`);
    await refresh();
    expect(totalsOf(db).events).toBe(2);
    expect(fileRows(db)[0]!.readOffset).toBe(statSync(path).size);
  });

  it('adds new unreadable lines to the count already stored for the file', async () => {
    const dir = tempDir();
    const path = putTranscript(dir, MAIN, [
      'SENTINEL_GARBAGE_one not json',
      assistantLine({ id: 'm1', at: '2026-10-20T10:00:05Z' }),
    ]);
    const { db, refresh } = setup(() => [dir]);
    expect(await refresh()).toMatchObject({ result: 'partial', unreadable: 1 });
    appendLines(path, ['[1,2,3]', assistantLine({ id: 'm2', at: '2026-10-20T10:01:00Z' })]);
    expect(await refresh()).toMatchObject({ result: 'partial', unreadable: 2 });
    expect(fileRows(db)[0]).toMatchObject({ state: 'partial', unreadableLines: 2 });
  });

  it('reads a replaced file from its start, and a message already stored does not count twice', async () => {
    const dir = tempDir();
    const path = putTranscript(dir, MAIN, [
      userLine('2026-10-20T10:00:00Z'),
      assistantLine({ id: 'm1', at: '2026-10-20T10:00:05Z', output: 10 }),
      assistantLine({ id: 'm2', at: '2026-10-20T10:00:09Z', output: 20 }),
    ]);
    const { db, refresh } = setup(() => [dir]);
    await refresh();

    // Same name, different first bytes, and longer: not an append.
    putTranscript(dir, MAIN, [
      userLine('2026-10-20T09:59:00Z'),
      assistantLine({ id: 'm1', at: '2026-10-20T10:00:05Z', output: 10 }),
      assistantLine({ id: 'm4', at: '2026-10-20T10:07:00Z', output: 40 }),
      userLine('2026-10-20T10:08:00Z'),
    ]);
    const report = await refresh();
    expect(report).toMatchObject({ result: 'succeeded', imported: 0, duplicatesSkipped: 1 });
    expect(eventKeys(db)).toEqual(['m1:req_m1', 'm2:req_m2', 'm4:req_m4']); // history stays
    expect(sessionById(db, SESSION).startedAt).toBe(at('2026-10-20T09:59:00Z')); // an older line moves the start earlier
    expect(fileRows(db)[0]!.readOffset).toBe(statSync(path).size);
  });
});

describe('a session starts when its first usage arrives', () => {
  it('makes no session for a file with no usage yet, then creates one when usage is appended', async () => {
    const dir = tempDir();
    const path = putTranscript(dir, MAIN, [userLine('2026-10-20T10:00:00Z')]);
    const { db, refresh } = setup(() => [dir]);
    expect(await refresh()).toMatchObject({ result: 'succeeded', imported: 0 });
    expect(sessionRows(db)).toEqual([]);
    expect(fileRows(db)).toHaveLength(1); // the file is tracked and read to its end

    appendLines(path, [assistantLine({ id: 'm1', at: '2026-10-20T10:00:05Z' })]);
    expect(await refresh()).toMatchObject({ imported: 1 });
    // The start is the first line's time (10:00:00), not the time of the usage that arrived later (10:00:05): the label alone
    // said source_start either way, which is how this stayed unseen.
    expect(sessionById(db, SESSION)).toMatchObject({
      kind: 'root',
      startedAt: at('2026-10-20T10:00:00Z'),
      startedBasis: 'source_start',
    });
  });

  it('keeps the real start when the usage comes much later, after more reads that still held none: the same as a fresh import of the finished file', async () => {
    const dir = tempDir();
    const path = putTranscript(dir, MAIN, [userLine('2026-10-20T10:00:00Z')]);
    const { db, refresh } = setup(() => [dir]);
    await refresh();
    appendLines(path, [userLine('2026-10-20T10:00:03Z')]);
    await refresh();
    expect(sessionRows(db)).toEqual([]); // still no usage, still no session
    appendLines(path, [assistantLine({ id: 'm1', at: '2026-10-20T13:30:00Z' })]);
    await refresh();

    const stored = sessionById(db, SESSION);
    expect(stored.startedAt).toBe(at('2026-10-20T10:00:00Z'));
    expect(stored.startedBasis).toBe('source_start');

    const fresh = setup(() => [dir]);
    await fresh.refresh();
    const once = sessionById(fresh.db, SESSION);
    expect([stored.startedAt, stored.startedBasis]).toEqual([once.startedAt, once.startedBasis]);
    expect(totalsOf(db, SESSION)).toEqual(totalsOf(fresh.db, SESSION)); // reading it again from the start changed no total
  });

  it('does the same for a subagent transcript: its start is its first line, not the first usage appended to it', async () => {
    const dir = tempDir();
    const agentPath = `-fixture-SENTINEL_CWD_t1-app/${SESSION}/subagents/agent-s1.jsonl`;
    putTranscript(dir, MAIN, [assistantLine({ id: 'm1', at: '2026-10-20T10:00:05Z' })]);
    const agent = putTranscript(dir, agentPath, [userLine('2026-10-20T10:00:10Z')]);
    const { db, refresh } = setup(() => [dir]);
    await refresh();
    expect(sessionRows(db).filter((row) => row.kind === 'child')).toEqual([]);

    appendLines(agent, [assistantLine({ id: 'a1', at: '2026-10-20T10:02:00Z' })]);
    await refresh();
    const [child] = sessionRows(db).filter((row) => row.kind === 'child');
    expect(child).toMatchObject({
      startedAt: at('2026-10-20T10:00:10Z'),
      startedBasis: 'source_start',
    });
  });

  it('takes a title written later and never moves the start later', async () => {
    const dir = tempDir();
    const path = putTranscript(dir, MAIN, [
      userLine('2026-10-20T10:00:00Z'),
      assistantLine({ id: 'm1', at: '2026-10-20T10:00:05Z' }),
    ]);
    const { db, refresh } = setup(() => [dir]);
    await refresh();
    expect(sessionById(db, SESSION).recordedName).toBeNull();

    appendLines(path, [
      JSON.stringify({ type: 'custom-title', customTitle: 'SENTINEL_TITLE_later' }),
    ]);
    await refresh();
    expect(sessionById(db, SESSION)).toMatchObject({
      recordedName: 'SENTINEL_TITLE_later',
      nameSource: 'provider_title',
      startedAt: at('2026-10-20T10:00:00Z'),
      startedBasis: 'source_start',
    });
  });
});

describe('subagent parentage', () => {
  const AGENT = (name: string) => `-fixture-SENTINEL_CWD_t1-app/${SESSION}/subagents/${name}.jsonl`;

  it('gives two subagent files of one session two children, and the same agent file name in another session its own', async () => {
    const dir = tempDir();
    putTranscript(dir, MAIN, [assistantLine({ id: 'm1', at: '2026-10-20T10:00:05Z' })]);
    putTranscript(dir, AGENT('agent-x1'), [
      assistantLine({ id: 'a1', at: '2026-10-20T10:00:10Z' }),
    ]);
    putTranscript(dir, AGENT('agent-x2'), [
      assistantLine({ id: 'a2', at: '2026-10-20T10:00:11Z' }),
    ]);
    const other = 'bbbbbbbb-2222-4222-8222-000000000002';
    putTranscript(dir, `-fixture-SENTINEL_CWD_t1-app/${other}.jsonl`, [
      assistantLine({ id: 'm9', at: '2026-10-20T11:00:05Z' }),
    ]);
    putTranscript(dir, `-fixture-SENTINEL_CWD_t1-app/${other}/subagents/agent-x1.jsonl`, [
      assistantLine({ id: 'a9', at: '2026-10-20T11:00:10Z' }),
    ]);
    const { db, refresh } = setup(() => [dir]);
    await refresh();
    const root = sessionById(db, SESSION);
    const children = sessionRows(db).filter((row) => row.kind === 'child');
    expect(children.map((row) => [row.providerSessionId, row.parentSessionId])).toEqual([
      [`${SESSION}:agent-x1`, root.id],
      [`${SESSION}:agent-x2`, root.id],
      [`${other}:agent-x1`, sessionById(db, other).id],
    ]);
  });

  it('links a subagent to a parent in another config dir, because main transcripts are written first', async () => {
    const base = tempDir();
    const a = join(base, 'a');
    const b = join(base, 'b');
    // Sorted by path, the subagent's dir comes first: the parent must still exist when the child is written.
    putTranscript(a, AGENT('agent-x1'), [assistantLine({ id: 'a1', at: '2026-10-20T10:00:10Z' })]);
    putTranscript(b, MAIN, [assistantLine({ id: 'm1', at: '2026-10-20T10:00:05Z' })]);
    const { db, refresh } = setup(() => [a, b]);
    await refresh();
    expect(sessionById(db, `${SESSION}:agent-x1`).parentSessionId).toBe(
      sessionById(db, SESSION).id,
    );
  });

  it.runIf(canDeny)(
    'links stored children when their parent becomes readable later, though their files did not change',
    async () => {
      const dir = tempDir();
      const main = putTranscript(dir, MAIN, [
        assistantLine({ id: 'm1', at: '2026-10-20T10:00:05Z' }),
      ]);
      putTranscript(dir, AGENT('agent-x1'), [
        assistantLine({ id: 'a1', at: '2026-10-20T10:00:10Z' }),
      ]);
      chmodSync(main, 0o000);
      const { db, refresh } = setup(() => [dir]);
      try {
        const first = await refresh();
        expect(first).toMatchObject({ result: 'partial', imported: 1, unreadable: 1 });
        expect(sessionById(db, `${SESSION}:agent-x1`)).toMatchObject({
          kind: 'child',
          parentSessionId: null,
        });
      } finally {
        chmodSync(main, 0o644);
      }
      const second = await refresh();
      expect(second).toMatchObject({ result: 'succeeded', imported: 1 }); // the parent, now
      expect(sessionById(db, `${SESSION}:agent-x1`).parentSessionId).toBe(
        sessionById(db, SESSION).id,
      );
    },
  );
});

describe('repo association', () => {
  it('finds the repository from the working directory’s git config, and keeps it when the directory is gone', async () => {
    const dir = tempDir();
    const work = join(tempDir(), 'checkout');
    mkdirSync(join(work, '.git'), { recursive: true });
    mkdirSync(join(work, 'src'), { recursive: true });
    writeFileSync(
      join(work, '.git/config'),
      '[remote "origin"]\n\turl = git@github.com:Fixture-Owner/Fixture-Repo.git\n',
    );
    const path = putTranscript(dir, MAIN, [
      assistantLine({ id: 'm1', at: '2026-10-20T10:00:05Z', cwd: join(work, 'src') }),
    ]);
    const { db, refresh } = setup(() => [dir]);
    await refresh();
    expect(sessionById(db, SESSION)).toMatchObject({
      repoId: 'fixture-owner/fixture-repo',
      repoBasis: 'git_config',
      cwd: join(work, 'src'),
    });

    rmSync(work, { recursive: true });
    appendLines(path, [
      assistantLine({ id: 'm2', at: '2026-10-20T10:01:05Z', cwd: join(work, 'src') }),
    ]);
    await refresh();
    expect(sessionById(db, SESSION)).toMatchObject({
      repoId: 'fixture-owner/fixture-repo',
      repoBasis: 'git_config',
    });
  });
});

describe('what each root says', () => {
  it('skips, recording nothing, when no config dir has a projects folder and nothing was imported before', async () => {
    const { db, refresh } = setup(() => [
      join(tempDir(), 'nowhere'),
      join(tempDir(), 'also-nowhere'),
    ]);
    const report = await refresh();
    expect(report).toMatchObject({ result: 'skipped' });
    expect(fileRows(db)).toEqual([]);
    expect(await setup(() => []).refresh()).toMatchObject({ result: 'skipped' });
  });

  it('skips for a projects folder with no transcript in it, too', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'projects/-fixture-empty'), { recursive: true });
    writeFileSync(join(dir, 'projects/-fixture-empty/notes.txt'), 'SENTINEL_NOTES');
    expect(await setup(() => [dir]).refresh()).toMatchObject({ result: 'skipped' });
  });

  it('succeeds with nothing to read, and keeps the history, when the logs were deleted after an import', async () => {
    const dir = tempDir();
    putTranscript(dir, MAIN, [assistantLine({ id: 'm1', at: '2026-10-20T10:00:05Z' })]);
    const { db, refresh } = setup(() => [dir]);
    await refresh();
    rmSync(join(dir, 'projects'), { recursive: true });
    const report = await refresh();
    expect(report).toMatchObject({ result: 'succeeded', imported: 0, unreadable: 0 });
    expect(totalsOf(db).events).toBe(1);
    expect(sessionRows(db)).toHaveLength(1);

    mkdirSync(join(dir, 'projects'));
    expect(await refresh()).toMatchObject({ result: 'succeeded' });
    expect(totalsOf(db).events).toBe(1);
  });

  it('reads a config dir that is a link to another one only once', async () => {
    const base = tempDir();
    const real = join(base, 'real');
    putTranscript(real, MAIN, [assistantLine({ id: 'm1', at: '2026-10-20T10:00:05Z' })]);
    const link = join(base, 'link');
    symlinkSync(real, link);
    const { db, refresh } = setup(() => [real, link, real]);
    expect(await refresh()).toMatchObject({ imported: 1, duplicatesSkipped: 0 });
    expect(fileRows(db)).toHaveLength(1);
  });

  it.runIf(canDeny)(
    'fails with Access denied when the only projects folder cannot be read, and keeps earlier history',
    async () => {
      const dir = tempDir();
      putTranscript(dir, MAIN, [assistantLine({ id: 'm1', at: '2026-10-20T10:00:05Z' })]);
      const { db, refresh } = setup(() => [dir]);
      await refresh();
      chmodSync(join(dir, 'projects'), 0o000);
      try {
        const report = await refresh();
        expect(report).toMatchObject({
          result: 'failed',
          status: 'denied',
          errorCode: 'access_denied',
          location: join(dir, 'projects'),
        });
        expect(totalsOf(db).events).toBe(1);
      } finally {
        chmodSync(join(dir, 'projects'), 0o755);
      }
    },
  );

  it.runIf(canDeny)(
    'is partial when one projects folder is readable and another is denied',
    async () => {
      const good = tempDir();
      const bad = tempDir();
      putTranscript(good, MAIN, [assistantLine({ id: 'm1', at: '2026-10-20T10:00:05Z' })]);
      putTranscript(bad, 'x/y.jsonl', [assistantLine({ id: 'm2', at: '2026-10-20T10:00:06Z' })]);
      chmodSync(join(bad, 'projects'), 0o000);
      try {
        const { db, refresh } = setup(() => [bad, good]);
        const report = await refresh();
        expect(report).toMatchObject({ result: 'partial', imported: 1, unreadable: 1 });
        expect(totalsOf(db).events).toBe(1);
      } finally {
        chmodSync(join(bad, 'projects'), 0o755);
      }
    },
  );

  it.runIf(canDeny)(
    'marks one unreadable file, imports the rest, and reads it again once it can be read',
    async () => {
      const dir = tempDir();
      const locked = putTranscript(dir, MAIN, [
        assistantLine({ id: 'm1', at: '2026-10-20T10:00:05Z' }),
      ]);
      putTranscript(
        dir,
        '-fixture-SENTINEL_CWD_t2-lib/cccccccc-3333-4333-8333-000000000003.jsonl',
        [assistantLine({ id: 'm2', at: '2026-10-20T10:00:06Z' })],
      );
      chmodSync(locked, 0o000);
      const { db, refresh } = setup(() => [dir]);
      try {
        const first = await refresh();
        expect(first).toMatchObject({ result: 'partial', imported: 1, unreadable: 1 });
        expect(fileRows(db).map((row) => row.state)).toEqual(['unreadable', 'ok']);
      } finally {
        chmodSync(locked, 0o644);
      }
      const second = await refresh();
      expect(second).toMatchObject({ result: 'succeeded', imported: 1, unreadable: 0 });
      expect(fileRows(db).map((row) => row.state)).toEqual(['ok', 'ok']);
      expect(totalsOf(db).events).toBe(2);
    },
  );
});

describe('what never leaves a line', () => {
  it('counts a line over the size limit as unreadable and carries on with the next one', async () => {
    const dir = tempDir();
    const path = putTranscript(dir, MAIN, [
      assistantLine({ id: 'm1', at: '2026-10-20T10:00:05Z' }),
    ]);
    appendFileSync(path, `{"type":"user","content":"${'x'.repeat(17 * 1024 * 1024)}"}\n`);
    appendLines(path, [assistantLine({ id: 'm2', at: '2026-10-20T10:00:09Z' })]);
    const { db, refresh } = setup(() => [dir]);
    expect(await refresh()).toMatchObject({ result: 'partial', unreadable: 1 });
    expect(totalsOf(db).events).toBe(2);
    expect(fileRows(db)[0]!.readOffset).toBe(statSync(path).size);
  });

  it('puts no line text, prompt, reply or parser message in a report or a log, whatever is wrong with the file', async () => {
    const dir = tempDir();
    putTranscript(dir, MAIN, [
      'SENTINEL_GARBAGE_a {"unterminated": "SENTINEL_BROKEN_a',
      '["SENTINEL_ARRAY_a"]',
      JSON.stringify({
        type: 'assistant',
        timestamp: 'SENTINEL_TIME_a',
        requestId: 'SENTINEL_REQ_a',
        message: {
          id: 'SENTINEL_ID_a',
          model: 'SENTINEL_MODEL_a',
          usage: { input_tokens: 'SENTINEL_N_a' },
        },
      }),
      assistantLine({ id: 'm1', req: null, at: '2026-10-20T10:00:05Z' }), // no request id
      assistantLine({ id: 'm2', at: '2026-10-20T10:00:09Z' }),
    ]);
    const { refresh, logs } = setup(() => [dir]);
    const report = await refresh();
    expect(report).toMatchObject({ result: 'partial', unreadable: 3, imported: 1 }); // a usage line with no request id is counted, not damage
    expect(JSON.stringify([report, logs.entries])).not.toMatch(/SENTINEL/);
  });

  it('reduces an unexpected failure to a code, so nothing it says can carry text', async () => {
    const { db, logs } = setup(() => []);
    const adapter = createClaudeAdapter({
      configDirs: () => {
        throw new Error('SENTINEL_LEAK_a: the line was {"prompt":"SENTINEL_PROMPT_a"}');
      },
    });
    const report = await adapter.refresh({
      db,
      now: () => 1,
      logger: logs.logger,
      progress: () => undefined,
    });
    expect(report).toMatchObject({ result: 'failed', status: 'failed', errorCode: 'unknown' });
    expect(JSON.stringify([report, logs.entries])).not.toMatch(/SENTINEL/);
  });
});
