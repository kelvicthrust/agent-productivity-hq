import { describe, expect, it } from 'vitest';
import {
  CLOSED_FINISHED_MS,
  FINISHED_ATTENTION_MS,
  IDLE_VISIBLE_MS,
  mapLiveState,
} from '../../../src/server/collectors/paseo/liveState.ts';
import { readLiveAgent } from '../../../src/server/collectors/paseo/liveAgent.ts';
import { NOW, entry, liveAgent } from './liveHelpers.ts';

// One test per row of the state mapping (data-and-sources › Live roster (HQ) › State mapping), and both edges of each time window.

const MIN = 60_000;
const at = (over: Parameters<typeof liveAgent>[0]) => mapLiveState(liveAgent(over), NOW);

describe('mapLiveState', () => {
  it('an archived agent is not on the roster, whatever it is doing', () => {
    expect(at({ id: 'a', archived: true, status: 'running' })).toBeNull();
  });

  describe('waiting', () => {
    it('a pending permission makes it waiting, even while Paseo says running', () => {
      const state = at({ id: 'a', status: 'running', pendingPermissionKind: 'tool' });
      expect(state).toMatchObject({ state: 'waiting', waitReason: 'permission', activity: 'none' });
    });

    it('takes its reason from the first permission kind: question, plan, anything else', () => {
      expect(at({ id: 'a', pendingPermissionKind: 'question' })?.waitReason).toBe('question');
      expect(at({ id: 'a', pendingPermissionKind: 'plan' })?.waitReason).toBe('plan_approval');
      for (const kind of ['tool', 'mode', 'other'])
        expect(at({ id: 'a', pendingPermissionKind: kind })?.waitReason).toBe('permission');
    });

    it('attention reason permission is waiting for a permission, with no permission listed', () => {
      expect(at({ id: 'a', status: 'idle', attentionReason: 'permission' })).toMatchObject({
        state: 'waiting',
        waitReason: 'permission',
      });
    });

    it('waiting wins over error', () => {
      expect(at({ id: 'a', status: 'error', pendingPermissionKind: 'tool' })?.state).toBe(
        'waiting',
      );
    });

    it('is waiting since the attention time when Paseo gives one, else the last update', () => {
      expect(
        at({ id: 'a', pendingPermissionKind: 'tool', attentionAt: NOW - 3 * MIN })?.since,
      ).toBe(NOW - 3 * MIN);
      expect(at({ id: 'a', pendingPermissionKind: 'tool', updatedAt: NOW - 5 * MIN })?.since).toBe(
        NOW - 5 * MIN,
      );
    });
  });

  describe('error', () => {
    it.each([
      ['status error', { status: 'error' }],
      ['provider unavailable', { providerUnavailable: true }],
      ['attention reason error', { attentionReason: 'error' }],
    ])('%s is error', (_name, over) => {
      expect(at({ id: 'a', ...over })).toMatchObject({
        state: 'error',
        waitReason: null,
        activity: 'none',
      });
    });

    it('an old failure nobody has touched for the idle window leaves the roster', () => {
      const old = { id: 'a', attentionReason: 'error', updatedAt: NOW - IDLE_VISIBLE_MS } as const;
      expect(at(old)).toBeNull();
      expect(at({ ...old, updatedAt: NOW - IDLE_VISIBLE_MS + 1 })?.state).toBe('error');
    });
  });

  describe('running and starting', () => {
    it('running is working with no activity, since the turn started', () => {
      expect(at({ id: 'a', status: 'running', turnStartedAt: NOW - 2 * MIN })).toEqual({
        state: 'working',
        activity: 'none',
        waitReason: null,
        since: NOW - 2 * MIN,
      });
    });

    it('running with no turn start is working since the last update', () => {
      expect(at({ id: 'a', status: 'running', updatedAt: NOW - 4 * MIN })?.since).toBe(
        NOW - 4 * MIN,
      );
    });

    it('initializing is starting', () => {
      expect(at({ id: 'a', status: 'initializing' })?.state).toBe('starting');
    });
  });

  describe('closed', () => {
    it('is finished for 60 s after its last update, then leaves', () => {
      expect(
        at({ id: 'a', status: 'closed', updatedAt: NOW - CLOSED_FINISHED_MS + 1 })?.state,
      ).toBe('finished');
      expect(at({ id: 'a', status: 'closed', updatedAt: NOW - CLOSED_FINISHED_MS })).toBeNull();
    });
  });

  describe('idle', () => {
    it('with attention reason finished and a recent attention time is finished, for under 10 minutes', () => {
      const base = { id: 'a', attentionReason: 'finished' } as const;
      expect(at({ ...base, attentionAt: NOW - FINISHED_ATTENTION_MS + 1 })).toMatchObject({
        state: 'finished',
        since: NOW - FINISHED_ATTENTION_MS + 1,
      });
      // Past 10 minutes it is plain idle (still inside the 30-minute window).
      expect(at({ ...base, attentionAt: NOW - FINISHED_ATTENTION_MS })?.state).toBe('idle');
    });

    it('without an attention time it cannot be finished, so it is idle', () => {
      expect(at({ id: 'a', attentionReason: 'finished', attentionAt: null })?.state).toBe('idle');
    });

    it('is idle when updated under 30 minutes ago, and not shown after that', () => {
      expect(at({ id: 'a', updatedAt: NOW - IDLE_VISIBLE_MS + 1 })).toMatchObject({
        state: 'idle',
        since: NOW - IDLE_VISIBLE_MS + 1,
      });
      expect(at({ id: 'a', updatedAt: NOW - IDLE_VISIBLE_MS })).toBeNull();
    });

    it('a status this code does not know is read as idle', () => {
      expect(at({ id: 'a', status: 'brand-new' })?.state).toBe('idle');
    });
  });

  it('keeps the three windows at 60 s, 10 min and 30 min', () => {
    expect([CLOSED_FINISHED_MS, FINISHED_ATTENTION_MS, IDLE_VISIBLE_MS]).toEqual([
      60_000, 600_000, 1_800_000,
    ]);
  });

  it('keeps an unread completion and error past the idle window', () => {
    const old = { id: 'a', updatedAt: NOW - IDLE_VISIBLE_MS - MIN, requiresAttention: true };
    expect(at({ ...old, attentionReason: 'finished' })?.state).toBe('finished');
    expect(at({ ...old, status: 'closed', attentionReason: 'finished' })?.state).toBe('finished');
    expect(at({ ...old, attentionReason: 'error' })?.state).toBe('error');
    expect(at({ ...old, attentionReason: 'finished', requiresAttention: false })).toBeNull();
    expect(at({ ...old, attentionReason: 'error', requiresAttention: false })).toBeNull();
  });

  it('keeps a quiet agent on the roster while its background work is running', () => {
    const old = { id: 'a', updatedAt: NOW - IDLE_VISIBLE_MS - MIN };
    expect(at({ ...old, backgroundWorkActive: true })?.state).toBe('idle');
    expect(at({ ...old, backgroundWorkActive: false })).toBeNull();
  });

  it('uses an active turn even if its timestamp is missing', () => {
    expect(at({ id: 'a', status: 'idle', hasActiveTurn: true })?.state).toBe('working');
    expect(
      at({ id: 'a', status: 'idle', hasActiveTurn: true, pendingPermissionKind: 'plan' })?.state,
    ).toBe('waiting');
  });
});

describe('readLiveAgent', () => {
  it('requires explicit absence of a prompt and saved session to mark empty history', () => {
    const read = (data: Record<string, unknown>) =>
      readLiveAgent({ agent: { id: 'a', ...data } }, NOW);
    const empty = { status: 'idle', lastUserMessageAt: null, persistence: null };
    expect(read(empty)?.reportsEmptyThread).toBe(true);
    expect(read({ lastUserMessageAt: null })?.reportsEmptyThread).toBe(false);
    expect(read({ persistence: null })?.reportsEmptyThread).toBe(false);
    expect(read({ ...empty, lastUserMessageAt: 'unusable' })?.reportsEmptyThread).toBe(false);
    expect(read({ ...empty, persistence: { provider: 'codex' } })?.reportsEmptyThread).toBe(false);
    expect(read({ ...empty, runtimeInfo: { sessionId: 'imported' } })?.reportsEmptyThread).toBe(
      false,
    );
  });

  it.each([
    { backgroundWork: { count: '1' } },
    { activeTurn: false },
    { activeTurn: [] },
    { attentionTimestamp: 'unusable' },
    { requiresAttention: 'false' },
    { attentionReason: 22 },
    { pendingPermissions: 'unknown' },
  ])('keeps incomplete evidence uncertain for %j', (work) => {
    const kept = readLiveAgent(
      {
        agent: { id: 'a', status: 'idle', lastUserMessageAt: null, persistence: null, ...work },
      },
      NOW,
    );
    expect(kept?.reportsEmptyThread).toBe(false);
  });

  it('keeps attention presence, work count and active-turn presence as coarse flags', () => {
    const active = readLiveAgent(
      {
        agent: {
          id: 'a',
          activeTurn: { turnId: 'private-key', startedAt: null },
          backgroundWork: { count: 2, detail: 'private-work' },
          requiresAttention: false,
        },
      },
      NOW,
    );
    expect(active).toMatchObject({
      hasActiveTurn: true,
      turnStartedAt: null,
      backgroundWorkActive: true,
      requiresAttention: false,
    });
    expect(JSON.stringify(active)).not.toContain('private-');
    expect(readLiveAgent({ agent: { id: 'a' } }, NOW)?.requiresAttention).toBeUndefined();
  });

  it('keeps exactly the allowed fields, so nothing else can leak', () => {
    const kept = readLiveAgent(
      entry({
        id: 'a-1',
        provider: 'claude',
        title: 'A title',
        cwd: '/work/x',
        sessionId: 'sess-1',
        parent: 'a-0',
        workspaceName: 'Workspace',
        permissions: ['question', 'tool'],
        attentionReason: 'permission',
        attentionTimestamp: '2026-11-04T19:50:00Z',
        requiresAttention: true,
        turnStartedAt: '2026-11-04T19:55:00Z',
      }),
      NOW,
    );
    expect(kept).toEqual({
      id: 'a-1',
      provider: 'claude',
      cwd: '/work/x',
      title: 'A title',
      workspaceName: 'Workspace',
      parentAgentId: 'a-0',
      sessionId: 'sess-1',
      status: 'idle',
      reportsEmptyThread: false,
      hasActiveTurn: true,
      turnStartedAt: Date.parse('2026-11-04T19:55:00Z'),
      backgroundWorkActive: false,
      pendingPermissionKind: 'question',
      requiresAttention: true,
      attentionReason: 'permission',
      attentionAt: Date.parse('2026-11-04T19:50:00Z'),
      updatedAt: Date.parse('2026-11-04T19:59:00Z'),
      createdAt: Date.parse('2026-11-04T19:20:00Z'),
      archived: false,
      providerUnavailable: false,
    });
    expect(JSON.stringify(kept)).not.toContain('SENTINEL');
  });

  it('is null without an id, and reads an unreadable archive time as archived', () => {
    expect(readLiveAgent({ agent: { title: 'x' } }, NOW)).toBeNull();
    expect(readLiveAgent(null, NOW)).toBeNull();
    const archived = readLiveAgent({ agent: { id: 'a', archivedAt: 'not a time' } }, NOW);
    expect(archived?.archived).toBe(true);
  });

  it('falls back to the creation time, then to now, for a missing update time', () => {
    expect(
      readLiveAgent({ agent: { id: 'a', createdAt: '2026-11-04T19:00:00Z' } }, NOW)?.updatedAt,
    ).toBe(Date.parse('2026-11-04T19:00:00Z'));
    expect(readLiveAgent({ agent: { id: 'a' } }, NOW)?.updatedAt).toBe(NOW);
  });
});
