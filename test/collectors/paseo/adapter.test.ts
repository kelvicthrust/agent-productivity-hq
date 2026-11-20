import { describe, expect, it } from 'vitest';
import {
  createPaseoAdapter,
  DEFAULT_PASEO_URL,
} from '../../../src/server/collectors/paseo/index.ts';
import { readPaseoCounts } from '../../../src/server/db/queries/paseo.ts';
import {
  MISMATCH,
  NOW,
  OK,
  connectErrors,
  daemonFrom,
  daemonWith,
  fixture,
  memoryDb,
  refresh,
  seedSession,
  sessionRow,
  sourceRow,
  usageEvents,
} from './helpers.ts';

// The Paseo adapter (G8_5, P-22, P-23): a reachable daemon enriches stored sessions, and a daemon that is off or asks for a
// password is a source state, not an error. The daemon here is a fake client over the DRAFT fixtures in test/fixtures/paseo
// (invented shapes, no real Paseo); the SQL half is tested in test/db/paseo.test.ts. No test opens a socket.

const agentRows = (db: ReturnType<typeof memoryDb>) =>
  db
    .prepare(
      `SELECT id, title, provider, provider_session_id, parent_agent_id, workspace_id, workspace_label, cwd, background, archived_at,
              first_seen_at, last_seen_at
         FROM paseo_agent ORDER BY id`,
    )
    .all() as Record<string, unknown>[];

describe('a reachable daemon', () => {
  it('stores the agents, joins them to the sessions already imported, and says so in a plain message', async () => {
    const db = memoryDb();
    const parent = seedSession(db, 'codex', OK.parentSession);
    const child = seedSession(db, 'codex', OK.childSession);
    const claude = seedSession(db, 'claude', OK.claudeSession);
    const daemon = daemonFrom(fixture('ok'));

    const { report } = await refresh(db, daemon.open);

    expect(report).toEqual({
      result: 'succeeded',
      status: 'ok',
      location: DEFAULT_PASEO_URL,
      adapterVersion: 'paseo-agents/1',
      message: 'Read 5 Paseo agents; 3 sessions matched.',
    });
    // Names and workspace labels come from Paseo, because the provider recorded none.
    expect(sessionRow(db, parent)).toMatchObject({
      kind: 'root',
      recorded_name: 'SENTINEL_TITLE_5e1a09',
      name_source: 'paseo',
      paseo_agent_id: OK.parentAgent,
      workspace_label: 'SENTINEL_WORKSPACE_5e1a09',
    });
    expect(sessionRow(db, claude)).toMatchObject({
      recorded_name: 'SENTINEL_TITLE_1b9e44',
      paseo_agent_id: OK.claudeAgent,
      workspace_label: 'SENTINEL_WORKSPACE_1b9e44',
    });
    // The parent comes from the `paseo.parent-agent-id` label, through the parent agent's own session.
    expect(sessionRow(db, child)).toMatchObject({
      kind: 'child',
      parent_session_id: parent,
      parent_basis: 'paseo',
      native_kind: 'paseo',
    });
  });

  it('asks for background agents and archived ones, and sends nothing else about the caller', async () => {
    const db = memoryDb();
    const daemon = daemonFrom(fixture('ok'));

    await refresh(db, daemon.open, { url: 'ws://127.0.0.1:7000/ws' });

    expect(daemon.opened).toEqual(['ws://127.0.0.1:7000/ws']);
    expect(daemon.lists).toHaveLength(1);
    expect(daemon.lists[0]).toMatchObject({
      includeBackground: true,
      filter: { includeBackground: true, includeArchived: true },
    });
    // Connected once and closed once: nothing is left open.
    expect([daemon.connects, daemon.closes]).toEqual([1, 1]);
  });

  it('keeps provider, session id, parent, workspace and archive time as the SDK gave them, with provider normalised', async () => {
    const db = memoryDb();
    const daemon = daemonFrom(fixture('ok'));

    await refresh(db, daemon.open);

    const byId = new Map(agentRows(db).map((row) => [row['id'], row]));
    expect(byId.size).toBe(5);
    expect(byId.get(OK.childAgent)).toMatchObject({
      provider: 'codex',
      provider_session_id: OK.childSession,
      parent_agent_id: OK.parentAgent,
      workspace_id: 'w-0001',
      workspace_label: 'SENTINEL_WORKSPACE_5e1a09',
      cwd: '/fixture-repo/SENTINEL_CWD_77c2d1',
      archived_at: null,
      first_seen_at: NOW,
      last_seen_at: NOW,
    });
    // An agent that has not started a provider session yet is stored, with no session id, and so maps to nothing.
    expect(byId.get(OK.noSessionAgent)).toMatchObject({
      provider: 'claude',
      provider_session_id: null,
      title: null,
    });
    // Archived agents are stored too, with the archive time in epoch ms.
    expect(byId.get(OK.archivedAgent)).toMatchObject({
      provider: 'codex',
      archived_at: OK.archivedAt,
    });
    // No per-agent background flag exists in the SDK, so none is claimed.
    expect([...byId.values()].every((row) => row['background'] === 0)).toBe(true);
    // Counts for Sources diagnostics: five agents, none of them a session here yet.
    expect(readPaseoCounts(db)).toMatchObject({
      agents: 5,
      mapped: 0,
      unmapped: 5,
      archived: 1,
      firstSeenAt: NOW,
    });
  });

  it('adds no usage event and changes no token: a session total is the same before and after', async () => {
    const db = memoryDb();
    seedSession(db, 'codex', OK.parentSession);
    seedSession(db, 'codex', OK.childSession);
    seedSession(db, 'claude', OK.claudeSession);
    const before = usageEvents(db);

    await refresh(db, daemonFrom(fixture('ok')).open);
    await refresh(db, daemonFrom(fixture('ok')).open, { now: NOW + 60_000 });

    expect(before).toHaveLength(3);
    expect(usageEvents(db)).toEqual(before);
  });

  it('repeats without change: no duplicate agent, first_seen_at kept, last_seen_at moved, and the join leaves the sessions as they were', async () => {
    const db = memoryDb();
    const parent = seedSession(db, 'codex', OK.parentSession);
    const child = seedSession(db, 'codex', OK.childSession);
    await refresh(db, daemonFrom(fixture('ok')).open);
    const sessionsBefore = [sessionRow(db, parent), sessionRow(db, child)];

    const second = await refresh(db, daemonFrom(fixture('ok')).open, { now: NOW + 900_000 });

    expect(second.report).toMatchObject({ result: 'succeeded' });
    const rows = agentRows(db);
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row['first_seen_at'] === NOW)).toBe(true);
    expect(rows.every((row) => row['last_seen_at'] === NOW + 900_000)).toBe(true);
    expect([sessionRow(db, parent), sessionRow(db, child)]).toEqual(sessionsBefore);
  });

  it('reads a listing in pages, following the cursor, and stores each agent once', async () => {
    const db = memoryDb();
    const all = fixture('ok').agents ?? [];
    const seen: (string | undefined)[] = [];
    const daemon = daemonWith({
      list: (options) => {
        seen.push(options.page.cursor);
        if (options.page.cursor === undefined)
          return { entries: all.slice(0, 2), pageInfo: { hasMore: true, nextCursor: 'next-1' } };
        // The second page repeats an agent from the first: it is kept once.
        return { entries: all.slice(1), pageInfo: { hasMore: false, nextCursor: null } };
      },
    });

    const { report } = await refresh(db, daemon.open);

    expect(seen).toEqual([undefined, 'next-1']);
    expect(report).toMatchObject({
      result: 'succeeded',
      message: expect.stringContaining('Read 4 Paseo agents'),
    });
    expect(agentRows(db)).toHaveLength(4);
  });

  it('stops a listing that never ends: it reads what it can and says the rest was not read (partial)', async () => {
    const db = memoryDb();
    let page = 0;
    const daemon = daemonWith({
      list: () => ({
        entries: [],
        pageInfo: { hasMore: true, nextCursor: `cursor-${(page += 1)}` },
      }),
    });

    const { report } = await refresh(db, daemon.open);

    expect(report).toMatchObject({ result: 'partial', status: 'partial' });
    expect(daemon.lists).toHaveLength(100);
  });

  it('stops when the daemon repeats a cursor, instead of listing the same page for ever', async () => {
    const db = memoryDb();
    const daemon = daemonWith({
      list: () => ({ entries: [], pageInfo: { hasMore: true, nextCursor: 'same' } }),
    });

    const { report } = await refresh(db, daemon.open);

    expect(report).toMatchObject({ result: 'succeeded' });
    expect(daemon.lists).toHaveLength(2);
  });

  it('reads the live listing when the daemon refuses the archived one, and still succeeds', async () => {
    const db = memoryDb();
    const parent = seedSession(db, 'codex', MISMATCH.session);
    const daemon = daemonFrom(fixture('mismatch'));

    const { report } = await refresh(db, daemon.open);

    expect(daemon.lists.map((request) => request.filter.includeArchived)).toEqual([true, false]);
    expect(report).toMatchObject({
      result: 'succeeded',
      message: 'Read 2 Paseo agents; 1 session matched.',
    });
    expect(agentRows(db)).toHaveLength(2);
    // A workspace name that is null or empty is no label, and the join then leaves the session's label alone.
    expect(agentRows(db).every((row) => row['workspace_label'] === null)).toBe(true);
    expect(sessionRow(db, parent)).toMatchObject({ workspace_label: null });
  });

  it('marks a session Unknown, not a child, when its Paseo parent is not a session we hold (P-23)', async () => {
    const db = memoryDb();
    const orphan = seedSession(db, 'codex', MISMATCH.session);

    await refresh(db, daemonFrom(fixture('mismatch')).open);

    expect(sessionRow(db, orphan)).toMatchObject({
      kind: 'unknown',
      parent_session_id: null,
      parent_basis: null,
      paseo_agent_id: MISMATCH.agent,
    });
    expect(readPaseoCounts(db)).toMatchObject({ parentUnmapped: 1 });
  });

  it('never matches a session by title, folder or time: an agent whose session id is not stored maps to nothing', async () => {
    const db = memoryDb();
    // A session that shares the agent's folder-free surroundings but not its session id.
    const other = seedSession(db, 'codex', 'c0de0000-0000-4000-8000-0000000000ee', {
      cwd: '/fixture-repo/SENTINEL_CWD_5e1a09',
    });
    // The same session id under the other provider is a different session.
    const wrongProvider = seedSession(db, 'claude', OK.parentSession);

    await refresh(db, daemonFrom(fixture('ok')).open);

    expect(sessionRow(db, other)).toMatchObject({ paseo_agent_id: null, recorded_name: null });
    expect(sessionRow(db, wrongProvider)).toMatchObject({
      paseo_agent_id: null,
      recorded_name: null,
    });
  });

  it('keeps a title the provider recorded: Paseo names a session only when the provider gave none', async () => {
    const db = memoryDb();
    const named = seedSession(db, 'codex', OK.parentSession, {
      recordedName: 'Provider title',
      nameSource: 'provider_title',
    });

    await refresh(db, daemonFrom(fixture('ok')).open);

    expect(sessionRow(db, named)).toMatchObject({
      recorded_name: 'Provider title',
      name_source: 'provider_title',
      paseo_agent_id: OK.parentAgent,
    });
  });

  it('maps provider names the way E3 does: codex and claude (with or without a model), anything else is other', async () => {
    const db = memoryDb();
    const entry = (id: string, provider: string) => ({
      agent: { id, provider, runtimeInfo: { sessionId: `s-${id}` } },
    });
    const daemon = daemonWith({
      list: () => ({
        entries: [
          entry('p1', 'codex'),
          entry('p2', 'Claude/sonnet'),
          entry('p3', 'opencode'),
          entry('p4', 'codex/gpt-5'),
        ],
        pageInfo: { hasMore: false, nextCursor: null },
      }),
    });

    await refresh(db, daemon.open);

    expect(Object.fromEntries(agentRows(db).map((row) => [row['id'], row['provider']]))).toEqual({
      p1: 'codex',
      p2: 'claude',
      p3: 'other',
      p4: 'codex',
    });
  });
});

describe('a daemon that is not running', () => {
  it('is a source state: notrunning with the address, a skip, and nothing recorded as an attempt', async () => {
    const db = memoryDb();
    const daemon = daemonFrom(fixture('down'));

    const { report } = await refresh(db, daemon.open);

    expect(report).toEqual({ result: 'skipped', message: 'Paseo isn’t running on this machine.' });
    expect(sourceRow(db)).toMatchObject({
      status: 'notrunning',
      location: DEFAULT_PASEO_URL,
      last_attempt_at: null,
      last_attempt_result: null,
      consecutive_failures: 0,
    });
    expect(daemon.closes).toBe(1);
  });

  it('reads Node-level ECONNREFUSED the same way', async () => {
    const db = memoryDb();
    const daemon = daemonWith({
      connect: () => {
        throw Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
      },
    });

    expect((await refresh(db, daemon.open)).report).toMatchObject({ result: 'skipped' });
    expect(sourceRow(db)).toMatchObject({ status: 'notrunning' });
  });

  it('says the last snapshot applies once Paseo has been seen, and the join still enriches from it', async () => {
    const db = memoryDb();
    // Run 1: the daemon is up, but Codex has imported nothing yet, so nothing matches.
    await refresh(db, daemonFrom(fixture('ok')).open);
    // Codex then imports the sessions; run 2 finds the daemon gone.
    const parent = seedSession(db, 'codex', OK.parentSession);
    const child = seedSession(db, 'codex', OK.childSession);
    expect(sessionRow(db, parent)).toMatchObject({ paseo_agent_id: null });

    const { report } = await refresh(db, daemonFrom(fixture('down')).open, { now: NOW + 900_000 });

    expect(report).toEqual({
      result: 'skipped',
      message:
        'Paseo isn’t running on this machine. Names and parents come from its last snapshot.',
    });
    expect(sessionRow(db, parent)).toMatchObject({
      recorded_name: 'SENTINEL_TITLE_5e1a09',
      paseo_agent_id: OK.parentAgent,
    });
    expect(sessionRow(db, child)).toMatchObject({
      kind: 'child',
      parent_session_id: parent,
      parent_basis: 'paseo',
    });
    // The daemon being off changes no agent: the snapshot is untouched.
    expect(agentRows(db).every((row) => row['last_seen_at'] === NOW)).toBe(true);
  });

  it('turns an ok source into notrunning and keeps its last success', async () => {
    const db = memoryDb();
    db.prepare(
      `INSERT INTO source_state (source_id, status, location, last_success_at, last_attempt_at, last_attempt_result)
       VALUES ('paseo', 'ok', ?, 1234, 1234, 'succeeded')`,
    ).run(DEFAULT_PASEO_URL);

    await refresh(db, daemonFrom(fixture('down')).open);

    expect(sourceRow(db)).toMatchObject({
      status: 'notrunning',
      last_success_at: 1234,
      last_attempt_at: 1234,
      last_attempt_result: 'succeeded',
    });
  });
});

describe('a daemon that asks for a password', () => {
  it('is a source state: needspassword, a skip, and no password is supplied, read or stored', async () => {
    const db = memoryDb();
    const daemon = daemonFrom(fixture('password'));

    const { report, logs } = await refresh(db, daemon.open);

    expect(report).toEqual({
      result: 'skipped',
      message: 'Paseo is asking for a password, which this dashboard doesn’t support.',
    });
    expect(sourceRow(db)).toMatchObject({
      status: 'needspassword',
      location: DEFAULT_PASEO_URL,
      last_attempt_at: null,
      consecutive_failures: 0,
      error_code: null,
      error_detail: null,
    });
    // The opener is given the address and nothing else: there is no argument a password could travel in.
    expect(daemon.open.length).toBeLessThanOrEqual(1);
    expect(daemon.opened).toEqual([DEFAULT_PASEO_URL]);
    expect(JSON.stringify([report, logs, sourceRow(db)])).not.toMatch(/password"?\s*:\s*"/i);
    expect(daemon.closes).toBe(1);
  });

  it('is told apart by the SDK error name, whatever its message says', async () => {
    const db = memoryDb();
    const daemon = daemonWith({
      connect: () => {
        throw Object.assign(new Error('Incorrect credentials'), {
          name: 'DaemonAuthenticationError',
        });
      },
    });

    expect((await refresh(db, daemon.open)).report).toMatchObject({ result: 'skipped' });
    expect(sourceRow(db)).toMatchObject({ status: 'needspassword' });
  });

  it('still joins from the last snapshot', async () => {
    const db = memoryDb();
    await refresh(db, daemonFrom(fixture('ok')).open);
    const claude = seedSession(db, 'claude', OK.claudeSession);

    await refresh(db, daemonFrom(fixture('password')).open, { now: NOW + 900_000 });

    expect(sessionRow(db, claude)).toMatchObject({
      recorded_name: 'SENTINEL_TITLE_1b9e44',
      paseo_agent_id: OK.claudeAgent,
    });
  });
});

describe('any other failure', () => {
  it('a connect that times out is failed with connect_timeout (a daemon that is there and silent is not "not running")', async () => {
    const db = memoryDb();
    const daemon = daemonWith({
      connect: () => {
        throw connectErrors.timeout();
      },
    });

    const { report } = await refresh(db, daemon.open);

    expect(report).toMatchObject({
      result: 'failed',
      status: 'failed',
      location: DEFAULT_PASEO_URL,
      errorCode: 'connect_timeout',
    });
    expect(report).toHaveProperty('errorDetail');
    expect(daemon.closes).toBe(1);
  });

  it('an opener that cannot make a client (the SDK is missing) is failed with its code, and its message is not kept', async () => {
    const db = memoryDb();
    const open = () => {
      throw Object.assign(new Error('SENTINEL_SDK_MISSING_1'), { code: 'SDK_UNAVAILABLE' });
    };

    const { report, logs } = await refresh(db, open);

    expect(report).toMatchObject({ result: 'failed', errorCode: 'sdk_unavailable' });
    expect(JSON.stringify([report, logs])).not.toContain('SENTINEL_SDK_MISSING_1');
  });

  it('a listing that fails is failed with a code from the SDK error, and the join still runs', async () => {
    const db = memoryDb();
    await refresh(db, daemonFrom(fixture('ok')).open);
    const parent = seedSession(db, 'codex', OK.parentSession);
    const daemon = daemonWith({
      list: () => {
        throw Object.assign(new Error(`Timed out waiting for agent ${OK.parentAgent}`), {
          code: 'DAEMON_REQUEST_TIMEOUT',
        });
      },
    });

    const { report, logs } = await refresh(db, daemon.open, { now: NOW + 900_000 });

    expect(report).toMatchObject({ result: 'failed', errorCode: 'daemon_request_timeout' });
    // A timed-out listing is not asked again for the live view.
    expect(daemon.lists).toHaveLength(1);
    expect(sessionRow(db, parent)).toMatchObject({ paseo_agent_id: OK.parentAgent });
    // The SDK's message carried an agent id: it appears nowhere in what is reported or logged.
    expect(JSON.stringify([report, logs])).not.toContain(OK.parentAgent);
  });

  it('a listing that fails with no code is list_failed', async () => {
    const db = memoryDb();
    const daemon = daemonWith({
      list: () => {
        throw new Error('SENTINEL_LIST_ERROR_1');
      },
    });

    const { report, logs } = await refresh(db, daemon.open);

    expect(report).toMatchObject({ result: 'failed', errorCode: 'list_failed' });
    expect(daemon.lists).toHaveLength(2);
    expect(JSON.stringify([report, logs])).not.toContain('SENTINEL_LIST_ERROR_1');
    expect(daemon.closes).toBe(1);
  });

  it('a failed attempt leaves the stored agents as they were', async () => {
    const db = memoryDb();
    await refresh(db, daemonFrom(fixture('ok')).open);
    const before = agentRows(db);
    const daemon = daemonWith({
      list: () => {
        throw new Error('boom');
      },
    });

    await refresh(db, daemon.open, { now: NOW + 900_000 });

    expect(agentRows(db)).toEqual(before);
  });
});

describe('what is logged and reported', () => {
  it('holds counts and codes only: never a title, folder, agent id or session id', async () => {
    const db = memoryDb();
    seedSession(db, 'codex', OK.parentSession);
    seedSession(db, 'claude', OK.claudeSession);

    const runs = [
      await refresh(db, daemonFrom(fixture('ok')).open),
      await refresh(db, daemonFrom(fixture('mismatch')).open),
      await refresh(db, daemonFrom(fixture('password')).open),
      await refresh(db, daemonFrom(fixture('down')).open),
    ];

    const text = JSON.stringify(runs);
    expect(runs[0]?.logs.length).toBeGreaterThan(0);
    for (const secret of [
      'SENTINEL_',
      'a0000000-',
      'c0de0000-',
      'ca5e0000-',
      'b0000000-',
      '/fixture-repo',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(JSON.stringify(sourceRow(db))).not.toContain('SENTINEL_');
  });
});

describe('the adapter', () => {
  it('is the paseo source, and uses the documented address when none is given', () => {
    expect(createPaseoAdapter().id).toBe('paseo');
    expect(DEFAULT_PASEO_URL).toBe('ws://127.0.0.1:6767/ws');
  });
});
