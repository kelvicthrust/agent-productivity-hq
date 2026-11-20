import { describe, expect, it } from 'vitest';
import { liveSessionKey, readLiveSessionLabels } from '../../src/server/db/queries/hq.ts';
import { upsertSession } from '../../src/server/db/queries/usage.ts';
import { memoryDb } from './helpers.ts';

// HQ's one database read: the stored name and workspace of sessions the live feeds found. A SELECT and nothing more.

const base = { kind: 'root' as const, startedAt: 1, startedBasis: 'first_event' as const };

describe('readLiveSessionLabels', () => {
  it('returns the recorded name and workspace of imported sessions, by provider and session id', () => {
    const db = memoryDb();
    upsertSession(db, {
      ...base,
      provider: 'claude',
      providerSessionId: 's-1',
      recordedName: 'A recorded name',
      nameSource: 'provider_title',
      workspaceLabel: 'Workspace one',
    });
    upsertSession(db, {
      ...base,
      provider: 'codex',
      providerSessionId: 's-1',
      recordedName: 'Another',
    });
    upsertSession(db, { ...base, provider: 'claude', providerSessionId: 's-2' });

    const labels = readLiveSessionLabels(db, [
      { provider: 'claude', sessionId: 's-1' },
      { provider: 'codex', sessionId: 's-1' },
      { provider: 'claude', sessionId: 's-2' },
      { provider: 'claude', sessionId: 'not-imported' },
    ]);
    expect(labels.get(liveSessionKey('claude', 's-1'))).toEqual({
      title: 'A recorded name',
      repo: null,
      workspace: 'Workspace one',
    });
    expect(labels.get(liveSessionKey('codex', 's-1'))?.title).toBe('Another');
    expect(labels.get(liveSessionKey('claude', 's-2'))).toEqual({
      title: null,
      repo: null,
      workspace: null,
    });
    expect(labels.has(liveSessionKey('claude', 'not-imported'))).toBe(false);
    expect(labels.size).toBe(3);
  });

  it('returns the stored repo of a session that has one', () => {
    const db = memoryDb();
    upsertSession(db, {
      ...base,
      provider: 'claude',
      providerSessionId: 's-1',
      repoId: 'acme/widgets',
      repoBasis: 'git_config',
    });
    expect(
      readLiveSessionLabels(db, [{ provider: 'claude', sessionId: 's-1' }]).get(
        liveSessionKey('claude', 's-1'),
      )?.repo,
    ).toBe('acme/widgets');
  });

  it('a Paseo-recorded name counts too, whoever recorded it', () => {
    const db = memoryDb();
    upsertSession(db, {
      ...base,
      provider: 'codex',
      providerSessionId: 'c-1',
      recordedName: 'Named by Paseo',
      nameSource: 'paseo',
    });
    expect(
      readLiveSessionLabels(db, [{ provider: 'codex', sessionId: 'c-1' }]).get(
        liveSessionKey('codex', 'c-1'),
      ),
    ).toMatchObject({ title: 'Named by Paseo' });
  });

  it('asks nothing for no keys, and handles many keys across statements', () => {
    const db = memoryDb();
    expect(readLiveSessionLabels(db, []).size).toBe(0);
    for (let index = 0; index < 450; index += 1)
      upsertSession(db, {
        ...base,
        provider: 'claude',
        providerSessionId: `s${index}`,
        recordedName: `n${index}`,
      });
    const keys = Array.from({ length: 450 }, (_, index) => ({
      provider: 'claude' as const,
      sessionId: `s${index}`,
    }));
    const labels = readLiveSessionLabels(db, keys);
    expect(labels.size).toBe(450);
    expect(labels.get(liveSessionKey('claude', 's449'))?.title).toBe('n449');
  });

  it('changes nothing: the database is the same after the read', () => {
    const db = memoryDb();
    upsertSession(db, { ...base, provider: 'claude', providerSessionId: 's-1', recordedName: 'N' });
    const before = JSON.stringify(db.prepare('SELECT * FROM session').all());
    readLiveSessionLabels(db, [{ provider: 'claude', sessionId: 's-1' }]);
    expect(JSON.stringify(db.prepare('SELECT * FROM session').all())).toBe(before);
  });
});
