import { describe, expect, it, vi } from 'vitest';
import {
  CAPABLE_KEEP_MS,
  CAPABLE_MAX,
  HOOK_KEEP_MS,
  HOOK_MAX_SESSIONS,
  createHookStore,
  kindOf,
} from '../../../src/server/services/hq/hookStore.ts';

const ev = (hook_event_name: string, session_id = 's1', extra: Record<string, string> = {}) => ({
  hook_event_name,
  session_id,
  ...extra,
});

describe('what an event means', () => {
  it.each([
    [ev('PermissionRequest'), 'permission'],
    [ev('Notification', 's', { notification_type: 'permission_prompt' }), 'permission'],
    [ev('Notification', 's', { notification_type: 'idle_prompt' }), 'idle'],
    [ev('Notification', 's', { notification_type: 'auth_success' }), null],
    [ev('Notification'), null],
    [ev('Stop'), 'stop'],
    [ev('SessionStart'), 'start'],
    [ev('SessionEnd', 's', { reason: 'clear' }), 'end'],
    [ev('PreToolUse'), null],
    [ev('stop'), null],
  ])('%j is %s', (event, kind) => {
    expect(kindOf(event)).toBe(kind);
  });
});

describe('the store', () => {
  it('keeps only the latest event of a session, with the latest working directory it named', () => {
    let now = 1_000;
    const store = createHookStore({ now: () => now });
    store.record(ev('SessionStart', 's1', { cwd: '/a' }));
    now = 2_000;
    store.record(ev('PermissionRequest'));
    expect(store.read().get('s1')).toEqual({ kind: 'permission', at: 2_000, cwd: '/a' });
    now = 3_000;
    store.record(ev('Stop', 's1', { cwd: '/b' }));
    expect(store.read().get('s1')).toEqual({ kind: 'stop', at: 3_000, cwd: '/b' });
    expect(store.read().size).toBe(1);
  });

  it('keeps nothing of an event it does not use, and holds only the kind, the time and the directory', () => {
    const store = createHookStore({ now: () => 1 });
    expect(store.record(ev('PostToolUse'))).toBe(false);
    expect(store.record({ ...ev('Notification'), notification_type: 'other' })).toBe(false);
    expect(store.read().size).toBe(0);
    expect(
      store.record({
        ...ev('Stop'),
        reason: 'SENTINEL_REASON',
        notification_type: 'SENTINEL_TYPE',
      }),
    ).toBe(true);
    expect(JSON.stringify([...store.read()])).not.toContain('SENTINEL');
  });

  it('forgets a session’s event 15 minutes after it, an ended one included', () => {
    let now = 0;
    const store = createHookStore({ now: () => now });
    store.record(ev('SessionEnd'));
    expect(store.read().get('s1')?.kind).toBe('end'); // an ended session is still known: its transcript lingers
    now = HOOK_KEEP_MS - 1;
    expect(store.read().get('s1')?.kind).toBe('end');
    now = HOOK_KEEP_MS;
    expect(store.read().size).toBe(0);
  });

  it('holds at most HOOK_MAX_SESSIONS sessions, dropping the oldest', () => {
    let now = 0;
    const store = createHookStore({ now: () => now });
    for (let i = 0; i < HOOK_MAX_SESSIONS + 25; i += 1) {
      now = i;
      store.record(ev('Stop', `s${i}`));
    }
    const kept = store.read();
    expect(kept.size).toBe(HOOK_MAX_SESSIONS);
    expect(kept.has('s0')).toBe(false);
    expect(kept.has(`s${HOOK_MAX_SESSIONS + 24}`)).toBe(true);
  });

  it('clear forgets everything', () => {
    const store = createHookStore({ now: () => 1 });
    store.record(ev('Stop'));
    store.clear();
    expect(store.read().size).toBe(0);
    expect(store.delivered('s1')).toBe(false);
  });

  it('read returns a copy: changing it does not change the store', () => {
    const store = createHookStore({ now: () => 1 });
    store.record(ev('Stop'));
    (store.read() as Map<string, unknown>).clear();
    expect(store.read().size).toBe(1);
  });
});

describe('a session that delivers outlives its latest event (hooks are exact for as long as it is followed)', () => {
  const clock = () => {
    const time = { now: 0 };
    return { time, store: createHookStore({ now: () => time.now }) };
  };

  it('is capable from its first used event, and never before one', () => {
    const { store } = clock();
    expect(store.delivered('s1')).toBe(false);
    store.record(ev('Stop'));
    expect(store.delivered('s1')).toBe(true);
    expect(store.delivered('other')).toBe(false);
  });

  it('counts an event HQ installed a hook for even when HQ uses nothing of it, and nothing else', () => {
    const { store } = clock();
    expect(store.record(ev('Notification', 'a', { notification_type: 'auth_success' }))).toBe(
      false,
    );
    expect(store.delivered('a')).toBe(true);
    expect(store.record(ev('PostToolUse', 'b'))).toBe(false);
    expect(store.delivered('b')).toBe(false);
    expect(store.read().size).toBe(0);
  });

  it('stays capable after its event expires while the transcript feed keeps asking, and for a grace period after', () => {
    const { time, store } = clock();
    store.record(ev('PermissionRequest'));
    // The feed asks at every read while it follows the transcript, for far longer than the event is kept.
    for (time.now = 60_000; time.now <= 3 * HOOK_KEEP_MS; time.now += 60_000)
      expect(store.delivered('s1')).toBe(true);
    expect(store.read().size).toBe(0); // the event itself is long gone
    // The transcript is no longer followed: nobody asks. The fact is forgotten CAPABLE_KEEP_MS after the last sighting (the one
    // above, which was a question like any other), and asking after that does not bring it back.
    const lastSeen = time.now - 60_000;
    time.now = lastSeen + CAPABLE_KEEP_MS;
    expect(store.delivered('s1')).toBe(false);
    time.now += 1;
    expect(store.delivered('s1')).toBe(false);
  });

  it('is still capable just short of CAPABLE_KEEP_MS after the last sighting', () => {
    const { time, store } = clock();
    store.record(ev('Stop'));
    time.now = 3 * HOOK_KEEP_MS;
    expect(store.delivered('s1')).toBe(true); // seen at 45 minutes: the event expired 30 minutes ago
    time.now += CAPABLE_KEEP_MS - 1;
    expect(store.delivered('s1')).toBe(true);
  });

  it('is forgotten CAPABLE_KEEP_MS after the last event when nobody asks', () => {
    const a = clock();
    a.store.record(ev('Stop'));
    a.time.now = CAPABLE_KEEP_MS - 1;
    expect(a.store.delivered('s1')).toBe(true);
    const b = clock();
    b.store.record(ev('Stop'));
    b.time.now = CAPABLE_KEEP_MS;
    expect(b.store.delivered('s1')).toBe(false);
  });

  it('a new event renews it', () => {
    const { time, store } = clock();
    store.record(ev('Stop'));
    time.now = CAPABLE_KEEP_MS - 1;
    store.record(ev('Stop'));
    time.now = 2 * CAPABLE_KEEP_MS - 2;
    expect(store.delivered('s1')).toBe(true);
  });

  it('is dropped by SessionEnd at once, while the ended record stays for its own 15 minutes', () => {
    const { time, store } = clock();
    store.record(ev('Stop'));
    expect(store.delivered('s1')).toBe(true);
    time.now = 1_000;
    store.record(ev('SessionEnd', 's1', { reason: 'clear' }));
    expect(store.delivered('s1')).toBe(false);
    expect(store.read().get('s1')?.kind).toBe('end');
    time.now = 2_000;
    expect(store.delivered('s1')).toBe(false); // being asked about does not bring it back
    time.now = 1_000 + HOOK_KEEP_MS;
    expect(store.read().size).toBe(0);
    // A later event of the same id (it was used again) makes it capable again.
    store.record(ev('Stop'));
    expect(store.delivered('s1')).toBe(true);
  });

  it('a SessionEnd for a session that was never capable makes nothing capable', () => {
    const { store } = clock();
    store.record(ev('SessionEnd', 'fresh'));
    expect(store.delivered('fresh')).toBe(false);
  });

  it('holds at most CAPABLE_MAX sessions, forgetting the one seen longest ago first, and a sighting protects one', () => {
    const { time, store } = clock();
    for (let i = 0; i < CAPABLE_MAX; i += 1) {
      time.now = i;
      store.record(ev('Stop', `s${i}`));
    }
    time.now = CAPABLE_MAX;
    expect(store.delivered('s0')).toBe(true); // the oldest is seen again: now the newest
    for (let i = 0; i < 10; i += 1) {
      time.now = CAPABLE_MAX + 1 + i;
      store.record(ev('Stop', `n${i}`));
    }
    expect(store.delivered('s0')).toBe(true);
    expect(store.delivered('s1')).toBe(false); // the ten that went were the oldest after s0
    expect(store.delivered('s10')).toBe(false);
    expect(store.delivered('s11')).toBe(true);
    expect(store.delivered('n9')).toBe(true);
  });

  it('clear forgets who is capable, as well as the events', () => {
    const { store } = clock();
    store.record(ev('Stop'));
    store.clear();
    expect(store.delivered('s1')).toBe(false);
    expect(store.read().size).toBe(0);
  });

  it('keeps nothing of a capable session beyond its id and a time', () => {
    const { store } = clock();
    store.record({ ...ev('Stop'), cwd: '/SENTINEL_CWD' });
    expect(JSON.stringify([...store.read()])).toContain('SENTINEL_CWD'); // the event holds the folder, as before
    store.clear();
    expect(store.delivered('s1')).toBe(false);
  });
});

describe('a flood of events', () => {
  it('stays within its bounds and does constant work for each event', () => {
    let now = 0;
    const store = createHookStore({ now: () => now });
    const started = performance.now();
    for (let i = 0; i < 20_000; i += 1) {
      now = i;
      store.record(ev(i % 3 === 0 ? 'SessionEnd' : 'Stop', `flood-${i}`));
      if (i % 50 === 0) {
        expect(store.read().size).toBeLessThanOrEqual(HOOK_MAX_SESSIONS);
        store.delivered(`flood-${i}`);
      }
    }
    expect(store.read().size).toBe(HOOK_MAX_SESSIONS);
    expect(store.read().has('flood-19999')).toBe(true);
    expect(store.read().has('flood-0')).toBe(false);
    let capable = 0;
    for (let i = 0; i < 20_000; i += 1) if (store.delivered(`flood-${i}`)) capable += 1;
    expect(capable).toBeLessThanOrEqual(CAPABLE_MAX);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('keeps the events in the order of arrival when one session writes again, and expires from the oldest', () => {
    let now = 0;
    const store = createHookStore({ now: () => now });
    store.record(ev('Stop', 'a'));
    now = 10;
    store.record(ev('Stop', 'b'));
    now = 20;
    store.record(ev('Stop', 'a')); // a is now the newest
    now = HOOK_KEEP_MS + 15;
    expect([...store.read().keys()]).toEqual(['a']);
  });

  it('has no timers: nothing is scheduled by recording, reading, asking or clearing', () => {
    vi.useFakeTimers();
    try {
      const store = createHookStore({ now: () => 1 });
      store.record(ev('Stop'));
      store.read();
      store.delivered('s1');
      store.clear();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
