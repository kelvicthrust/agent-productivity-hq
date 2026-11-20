import { chmodSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  checkLocalSources,
  claudeConfigDirs,
  codexHomes,
  discoverLocalSources,
  recordDiscoveries,
} from '../../../src/server/collectors/discovery.ts';
import { getSourceState, recordAttempt } from '../../../src/server/db/queries/sources.ts';
import { memoryDb, memoryLogger, tempDir } from '../../server/helpers.ts';
import { CAN_DENY, FORBIDDEN, T0, everythingStored, makeHome, withoutAccess } from './helpers.ts';

// Discovery (TECH › Discovery): it looks at the documented default folders and the override variables, says notfound, denied,
// partial or ok, records that on the source's row, and imports nothing. The home and the environment are passed in; the
// functions never read this computer's own.

describe('where discovery looks', () => {
  const home = '/home/kelvin';

  it('looks in ~/.codex, and in ~/.config/claude then ~/.claude, when no variable is set', () => {
    expect(codexHomes({ env: {}, home })).toEqual(['/home/kelvin/.codex']);
    expect(claudeConfigDirs({ env: {}, home })).toEqual([
      '/home/kelvin/.config/claude',
      '/home/kelvin/.claude',
    ]);
  });

  it('takes each comma-separated entry of CODEX_HOME and CLAUDE_CONFIG_DIR instead of the defaults', () => {
    const env = { CODEX_HOME: '/data/a, /data/b ,', CLAUDE_CONFIG_DIR: '/cfg/one,/cfg/two' };
    expect(codexHomes({ env, home })).toEqual(['/data/a', '/data/b']);
    expect(claudeConfigDirs({ env, home })).toEqual(['/cfg/one', '/cfg/two']);
  });

  it('reads a leading ~ as the home folder, drops repeats, and treats an empty variable as unset', () => {
    expect(codexHomes({ env: { CODEX_HOME: '~/x,~/x,~' }, home })).toEqual([
      '/home/kelvin/x',
      '/home/kelvin',
    ]);
    expect(codexHomes({ env: { CODEX_HOME: ' , ' }, home })).toEqual(['/home/kelvin/.codex']);
    expect(claudeConfigDirs({ env: { CLAUDE_CONFIG_DIR: '' }, home })).toHaveLength(2);
  });

  it('never reads the process environment: only the env it is given counts', () => {
    vi.stubEnv('CODEX_HOME', '/process/env/codex');
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/process/env/claude');
    try {
      expect(codexHomes({ env: {}, home })).toEqual(['/home/kelvin/.codex']);
      expect(claudeConfigDirs({ env: {}, home })[1]).toBe('/home/kelvin/.claude');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('what discovery finds', () => {
  it('says notfound for both when the folders are not there', async () => {
    const report = await discoverLocalSources({ env: {}, home: tempDir() });
    expect(report.codex).toMatchObject({ status: 'notfound', files: 0, location: null });
    expect(report.claude).toMatchObject({ status: 'notfound', files: 0, location: null });
    expect(report.codex.message).toContain('run it once, then check again');
    expect(report.claude.roots).toHaveLength(2);
  });

  it('says ok and where, counting what can be read, across both Claude config dirs and both Codex folders', async () => {
    const home = makeHome();
    const report = await discoverLocalSources({ env: {}, home });
    // Claude: 4 transcripts in ~/.claude (the orphaned copy is not one) and 3 in ~/.config/claude (the superseded copy is not one).
    expect(report.claude).toMatchObject({ status: 'ok', files: 7 });
    // The first config dir that holds a readable projects/ is the location: the documented order, not the alphabet.
    expect(report.claude.location).toBe(join(home, '.config/claude/projects'));
    // Codex: two rollouts in sessions/ (a plain file beats its .zst twin) and one archived.
    expect(report.codex).toMatchObject({
      status: 'ok',
      files: 3,
      location: join(home, '.codex/sessions'),
    });
    expect(report.codex.message).toBeUndefined();
  });

  it('follows the override variables, and ignores a default when an override is given', async () => {
    const home = makeHome();
    const elsewhere = tempDir();
    const report = await discoverLocalSources({
      env: { CODEX_HOME: join(elsewhere, 'nope'), CLAUDE_CONFIG_DIR: join(home, '.claude') },
      home,
    });
    expect(report.codex.status).toBe('notfound'); // ~/.codex is full, but the override says otherwise
    expect(report.claude).toMatchObject({ status: 'ok', files: 4 });
    expect(report.claude.roots).toEqual([join(home, '.claude/projects')]);
  });

  it('says notfound for a folder with nothing in it: found means a readable transcript or rollout exists', async () => {
    const home = tempDir();
    mkdirSync(join(home, '.claude/projects'), { recursive: true });
    mkdirSync(join(home, '.codex/sessions/2026/10'), { recursive: true });
    mkdirSync(join(home, '.codex/archived_sessions'), { recursive: true });
    writeFileSync(join(home, '.codex/sessions/notes.txt'), 'not a rollout');
    const report = await discoverLocalSources({ env: {}, home });
    expect(report.claude.status).toBe('notfound');
    expect(report.codex.status).toBe('notfound');
  });

  it('only looks: it opens no transcript, so a file with nothing readable in it is still found, and nothing is imported', async () => {
    const home = tempDir();
    mkdirSync(join(home, '.claude/projects/-p'), { recursive: true });
    writeFileSync(
      join(home, '.claude/projects/-p/abc.jsonl'),
      'this is not json at all\n{"cut off',
    );
    const db = memoryDb();
    const logs = memoryLogger('debug');
    const report = await checkLocalSources(db, { env: {}, home }, logs.logger);
    expect(report.claude).toMatchObject({ status: 'ok', files: 1 });
    for (const [table, text] of Object.entries(everythingStored(db))) {
      if (['usage_event', 'session', 'source_file', 'session_ref'].includes(table))
        expect(text, table).toBe('[]');
    }
    expect(getSourceState(db, 'claude')).toMatchObject({ status: 'ok', unreadableCount: 0 });
  });

  describe.skipIf(!CAN_DENY)('permissions', () => {
    it('says denied when the folder is there and cannot be read, with where it is', async () => {
      const home = makeHome();
      const projects = [join(home, '.claude/projects'), join(home, '.config/claude/projects')];
      const report = await withoutAccess(projects, () => discoverLocalSources({ env: {}, home }));
      expect(report.claude).toMatchObject({ status: 'denied', files: 0, location: projects[1] });
      expect(report.claude.message).toContain('permission denied');
      expect(report.codex.status).toBe('ok'); // one source's trouble is not the other's
      expect((await discoverLocalSources({ env: {}, home })).claude.status).toBe('ok'); // and it passes
    });

    it('says denied when the whole Codex home cannot be entered', async () => {
      const home = makeHome();
      const report = await withoutAccess([join(home, '.codex')], () =>
        discoverLocalSources({ env: {}, home }),
      );
      expect(report.codex).toMatchObject({ status: 'denied', files: 0 });
      expect(report.codex.location).toContain('.codex');
    });

    it('says partial when some of it can be read: one root, one folder, one file', async () => {
      const home = makeHome();
      const env = {};
      // A root: sessions/ is denied, archived_sessions/ is read.
      const oneFolder = await withoutAccess([join(home, '.codex/sessions')], () =>
        discoverLocalSources({ env, home }),
      );
      expect(oneFolder.codex).toMatchObject({ status: 'partial', files: 1 });
      // A config dir: ~/.claude/projects is denied, ~/.config/claude/projects is read.
      const oneDir = await withoutAccess([join(home, '.claude/projects')], () =>
        discoverLocalSources({ env, home }),
      );
      expect(oneDir.claude).toMatchObject({ status: 'partial', files: 3 });
      // A project folder below a readable root.
      const project = join(
        home,
        '.config/claude/projects',
        readdirSync(join(home, '.config/claude/projects'))[0]!,
      );
      const oneProject = await withoutAccess([project], () => discoverLocalSources({ env, home }));
      expect(oneProject.claude.status).toBe('partial');
      // One transcript, read by nobody.
      const file = join(
        project,
        readdirSync(project).find((name) => name.endsWith('.jsonl'))!,
      );
      const oneFile = await withoutAccess([file], () => discoverLocalSources({ env, home }));
      expect(oneFile.claude).toMatchObject({ status: 'partial', files: 6 });
      expect(statSync(file).mode & 0o400).toBe(0o400); // withoutAccess put the permission back
    });

    it('says denied, not notfound, when the only transcript cannot be opened', async () => {
      const home = tempDir();
      const file = join(home, '.claude/projects/-p/only.jsonl');
      mkdirSync(join(home, '.claude/projects/-p'), { recursive: true });
      writeFileSync(file, '{}\n');
      chmodSync(file, 0o644);
      const report = await withoutAccess([file], () => discoverLocalSources({ env: {}, home }));
      expect(report.claude).toMatchObject({ status: 'denied', files: 0 });
    });
  });
});

describe('what discovery records', () => {
  const found = {
    roots: ['/r'],
    location: '/r/projects',
    files: 2,
  };
  const report = (claude: string, codex = 'notfound') =>
    ({
      claude: { ...found, status: claude },
      codex: { ...found, status: codex, location: codex === 'notfound' ? null : '/c/sessions' },
    }) as Parameters<typeof recordDiscoveries>[1];

  it('records ok or partial for a source nothing has attempted yet, and not as an attempt', () => {
    const db = memoryDb();
    recordDiscoveries(db, report('ok', 'partial'));
    expect(getSourceState(db, 'claude')).toMatchObject({
      status: 'ok',
      location: '/r/projects',
      lastAttemptAt: null,
      lastAttemptResult: null,
      lastSuccessAt: null,
      consecutiveFailures: 0,
    });
    expect(getSourceState(db, 'codex')).toMatchObject({ status: 'partial', lastAttemptAt: null });
  });

  it('records notfound and denied always, over an earlier attempt, without touching the attempt', () => {
    const db = memoryDb();
    recordAttempt(db, {
      sourceId: 'claude',
      result: 'succeeded',
      at: T0,
      status: 'ok',
      location: '/r/projects',
    });
    recordAttempt(db, {
      sourceId: 'codex',
      result: 'partial',
      at: T0,
      status: 'partial',
      location: '/c/sessions',
    });
    recordDiscoveries(db, report('denied'));
    expect(getSourceState(db, 'claude')).toMatchObject({
      status: 'denied',
      location: '/r/projects',
      lastAttemptAt: T0,
      lastAttemptResult: 'succeeded',
      lastSuccessAt: T0,
      consecutiveFailures: 0,
    });
    expect(getSourceState(db, 'codex')).toMatchObject({
      status: 'notfound',
      location: '/c/sessions', // where it was last found stays
      lastAttemptResult: 'partial',
      consecutiveFailures: 0,
    });
  });

  it("never overwrites an attempt's failed or partial status with ok or partial", () => {
    const db = memoryDb();
    recordAttempt(db, {
      sourceId: 'claude',
      result: 'failed',
      at: T0,
      status: 'failed',
      errorCode: 'eio',
      errorDetail: 'x',
    });
    recordAttempt(db, {
      sourceId: 'codex',
      result: 'partial',
      at: T0,
      status: 'partial',
      unreadable: 3,
    });
    recordDiscoveries(db, report('ok', 'ok'));
    recordDiscoveries(db, report('partial', 'partial'));
    expect(getSourceState(db, 'claude')).toMatchObject({
      status: 'failed',
      consecutiveFailures: 1,
      errorCode: 'eio',
    });
    expect(getSourceState(db, 'codex')).toMatchObject({ status: 'partial', unreadableCount: 3 });
  });

  it('lets a first-launch denied become ok once the permission is fixed, as no attempt has happened', () => {
    const db = memoryDb();
    recordDiscoveries(db, report('denied'));
    expect(getSourceState(db, 'claude')?.status).toBe('denied');
    recordDiscoveries(db, report('ok'));
    expect(getSourceState(db, 'claude')).toMatchObject({ status: 'ok', consecutiveFailures: 0 });
  });

  it('keeps no path, file name or sentinel in its log line', async () => {
    const home = makeHome();
    const logs = memoryLogger('debug');
    await checkLocalSources(memoryDb(), { env: {}, home }, logs.logger);
    expect(logs.entries.filter((entry) => entry['msg'] === 'discovery')).toHaveLength(2);
    expect(JSON.stringify(logs.entries)).not.toMatch(/SENTINEL|\.jsonl|\.claude|\.codex/);
    expect(JSON.stringify(logs.entries)).not.toMatch(FORBIDDEN);
  });
});
