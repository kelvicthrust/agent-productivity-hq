import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { boot, type ListenFn } from '../../src/server/boot.ts';
import type { PaseoListEntry } from '../../src/server/collectors/paseo/index.ts';
import { makeHome } from '../integration/import/helpers.ts';
import { connectErrors, daemonWith } from '../collectors/paseo/helpers.ts';
import { HOST, NOW, TZ, WRITE, call, memoryLogger, tempConfig } from './helpers.ts';

// Paseo through the real boot (G8_5, G8_6): the process is given this machine (a temp HOME holding the INVENTED Codex and Claude Code
// fixture folders) and a fake daemon, and a refresh runs the stages in order: the two local adapters import the sessions, then Paseo
// names and parents them. Nothing here opens a socket or reads a real Paseo: the daemon is a function that answers like the SDK.
//
// The fixture sessions (see test/fixtures/codex and claude):
//   codex  cccccccc…0c  root, no name              claude 1111…01  root, has its own title (and a native subagent)
//   codex  aaaaaaaa…0a  root, no name              claude 2222…02  root, no name
//   codex  bbbbbbbb…0b  native child of …0a        claude 3333…03  root, has its own title

const SESSION = {
  codexParent: 'cccccccc-3333-4333-8333-00000000000c',
  codexNative: 'aaaaaaaa-1111-4111-8111-00000000000a',
  codexNativeChild: 'bbbbbbbb-2222-4222-8222-00000000000b',
  claudeChild: '22222222-bbbb-4bbb-8bbb-000000000002',
  claudeTitled: '33333333-cccc-4ccc-8ccc-000000000003',
} as const;

const AGENT = {
  parent: 'a-parent',
  child: 'a-child',
  titled: 'a-titled',
  nativeChild: 'a-native-child',
  orphanChild: 'a-orphan-child',
  unmatched: 'a-unmatched',
} as const;

const PARENT_LABEL = 'paseo.parent-agent-id';

const entry = (
  id: string,
  provider: 'codex' | 'claude',
  sessionId: string | null,
  extra: { title?: string; parent?: string; workspace?: string } = {},
): PaseoListEntry => ({
  agent: {
    id,
    provider,
    title: extra.title ?? null,
    workspaceId: 'w-1',
    labels: extra.parent ? { [PARENT_LABEL]: extra.parent } : {},
    runtimeInfo: { sessionId },
    archivedAt: null,
  },
  project: { workspaceName: extra.workspace ?? null },
});

/** The daemon, as Paseo would list it: one parent, a delegated child, one agent over a session that has its own title, and so on. */
const AGENTS: PaseoListEntry[] = [
  entry(AGENT.parent, 'codex', SESSION.codexParent, {
    title: 'SENTINEL_PASEO_parent',
    workspace: 'Paseo workspace',
  }),
  entry(AGENT.child, 'claude', SESSION.claudeChild, {
    title: 'SENTINEL_PASEO_child',
    parent: AGENT.parent,
  }),
  // the session already has the provider's own title: Paseo's never replaces it
  entry(AGENT.titled, 'claude', SESSION.claudeTitled, { title: 'SENTINEL_PASEO_other' }),
  // the session is a native subagent: Paseo's parent never replaces the native one
  entry(AGENT.nativeChild, 'codex', SESSION.codexNativeChild, { parent: AGENT.parent }),
  // a session whose parent agent is not listed: its relationship is Unknown, never a guessed edge
  entry(AGENT.orphanChild, 'codex', SESSION.codexNative, { parent: 'a-not-listed' }),
  // an agent no session matches: counted in Sources, adds nothing to any total
  entry(AGENT.unmatched, 'claude', 'deadbeef-0000-4000-8000-000000000000', {
    title: 'SENTINEL_PASEO_x',
  }),
];

type Mode = 'ok' | 'down' | 'password';

function daemon() {
  const state = { mode: 'ok' as Mode, entries: AGENTS };
  const fake = daemonWith({
    connect: () => {
      if (state.mode === 'down') throw connectErrors.refused();
      if (state.mode === 'password') throw connectErrors.password();
    },
    list: () => ({ entries: state.entries, pageInfo: { hasMore: false, nextCursor: null } }),
  });
  return { state, fake };
}

const listen: ListenFn = async () => ({ close: (callback) => callback?.() });

async function bootOver(home: string, options: { paseo?: ReturnType<typeof daemon> } = {}) {
  const { logger, entries } = memoryLogger('debug');
  const server = await boot(tempConfig(), {
    logger,
    listen,
    now: () => NOW,
    timezone: TZ,
    scheduler: false,
    local: { env: {}, home },
    ...(options.paseo ? { paseo: { open: options.paseo.fake.open } } : {}),
  });
  return { server, logs: entries };
}
type Booted = Awaited<ReturnType<typeof bootOver>>;

async function json<T>(booted: Booted, path: string): Promise<T> {
  const response = await call(booted.server.app as never, path, { headers: HOST });
  return (await response.json()) as T;
}

/** Starts a refresh as the Refresh button does and waits for the run to end. */
async function refresh(
  booted: Booted,
  sources?: readonly string[],
): Promise<{ id: number; state: string }> {
  const started = await call(booted.server.app as never, '/api/refresh', {
    method: 'POST',
    headers: WRITE,
    body: JSON.stringify(sources ? { sources } : {}),
  });
  expect(started.status).toBe(202);
  const { id } = (await started.json()) as { id: number };
  for (let waited = 0; waited < 10_000; waited += 10) {
    const run = await json<{ id: number; state: string }>(booted, `/api/refresh/${id}`);
    if (run.state !== 'running' && run.state !== 'queued') return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the run did not end');
}

interface SessionRow {
  id: number;
  providerSessionRef: string;
  kind: string;
  relationshipLabel?: string;
  nameLead: string;
  named: boolean;
  nameSource?: string | null;
  tokens: number;
  parentId?: number | null;
  paseo?: { agentId?: string; workspace?: string | null } | null;
  children?: SessionRow[];
}
interface Roots {
  roots?: SessionRow[];
  orphans?: SessionRow[];
  unknownRelationship?: SessionRow[];
}

/** The shortened id the tree shows as "Session ID:" ('thread cccc…000c', 'session 2222…0002'). */
const refOf = (providerSessionId: string): string =>
  `${providerSessionId.startsWith('cccccccc') || providerSessionId.startsWith('aaaaaaaa') || providerSessionId.startsWith('bbbbbbbb') ? 'thread' : 'session'} ${providerSessionId.slice(0, 4)}…${providerSessionId.slice(-4)}`;

const RANGE = '?start=2026-09-01&end=2026-11-04';

/** Every session in the Usage tree, flat, by the provider's own session id (a subagent's id has a ':' in it). */
async function tree(booted: Booted): Promise<Map<string, SessionRow>> {
  const groups = await json<{ groups: { key: string }[] }>(booted, `/api/usage/groups${RANGE}`);
  const all = new Map<string, SessionRow>();
  const add = (row: SessionRow) => {
    all.set(row.providerSessionRef, row);
    row.children?.forEach(add);
  };
  for (const group of groups.groups) {
    const roots = await json<Roots>(
      booted,
      `/api/usage/groups/${encodeURIComponent(group.key)}/roots${RANGE}&limit=100`,
    );
    for (const list of [roots.roots, roots.orphans, roots.unknownRelationship]) list?.forEach(add);
  }
  return all;
}

/** Every usage event by the provider's own ids: the two local adapters import side by side, so a row id depends on who finished first. */
const events = (booted: Booted) =>
  booted.server
    .db!.prepare(
      `SELECT e.provider, e.dedupe_key, s.provider_session_id, e.occurred_at, e.model, e.input_tokens, e.cached_input_tokens,
              e.cache_write_tokens, e.cache_read_tokens, e.output_tokens, e.reasoning_tokens, e.provider_total
         FROM usage_event e JOIN session s ON s.id = e.session_id ORDER BY e.provider, e.dedupe_key`,
    )
    .all();

/** The tree as the owner reads it, free of row ids: who is called what, under whom, and with how many tokens. */
const shape = (sessions: Map<string, SessionRow>) =>
  [...sessions.values()]
    .map((row) => ({
      ref: row.providerSessionRef,
      kind: row.kind,
      relationshipLabel: row.relationshipLabel,
      nameLead: row.nameLead,
      nameSource: row.nameSource ?? null,
      tokens: row.tokens,
      parent:
        row.parentId === null || row.parentId === undefined
          ? null
          : [...sessions.values()].find((p) => p.id === row.parentId)?.providerSessionRef,
    }))
    .sort((a, b) => a.ref.localeCompare(b.ref));

const sessionOf = (booted: Booted, providerSessionId: string) =>
  booted.server
    .db!.prepare(
      `SELECT id, kind, parent_session_id, parent_basis, native_kind, recorded_name, name_source, paseo_agent_id
         FROM session WHERE provider_session_id = ?`,
    )
    .get(providerSessionId) as Record<string, unknown>;

interface Source {
  id: string;
  status: string;
  message: string | null;
  lastSuccessAt: number | null;
  lastAttemptResult: string | null;
  consecutiveFailures: number;
}
const paseoSource = async (booted: Booted): Promise<Source | undefined> =>
  (await json<{ sources: Source[] }>(booted, '/api/sources')).sources.find((s) => s.id === 'paseo');

describe('a refresh runs Paseo after the local sources and enriches the tree', () => {
  it('names and parents the sessions from the daemon and changes no token', async () => {
    // the same machine twice: once with no Paseo at all, once with a daemon
    const plain = await bootOver(makeHome());
    await refresh(plain);
    const before = events(plain);
    const plainTree = await tree(plain);
    await plain.server.shutdown();
    expect(before.length).toBeGreaterThan(0);

    const paseo = daemon();
    const booted = await bootOver(makeHome(), { paseo });
    const run = await refresh(booted);
    expect(run.state).toBe('succeeded');

    // Paseo is stage two: one connection, closed again, background agents asked for
    expect([paseo.fake.connects, paseo.fake.closes]).toEqual([1, 1]);
    expect(paseo.fake.lists[0]).toMatchObject({ includeBackground: true });

    // nothing was added and nothing moved: every usage event is what it was without Paseo (P-22)
    expect(events(booted)).toEqual(before);

    const sessions = await tree(booted);
    const row = (id: string) => sessions.get(refOf(id))!;
    // a name from Paseo only where the provider recorded none, said once, with its source
    expect(row(SESSION.codexParent)).toMatchObject({
      nameLead: 'SENTINEL_PASEO_parent',
      named: true,
      nameSource: 'paseo',
      paseo: { agentId: AGENT.parent, workspace: 'Paseo workspace' },
    });
    expect(row(SESSION.claudeChild)).toMatchObject({
      nameLead: 'SENTINEL_PASEO_child',
      nameSource: 'paseo',
      kind: 'child',
      relationshipLabel: 'Paseo child agent',
    });
    expect(row(SESSION.claudeTitled)).toMatchObject({
      nameSource: 'provider_title',
      nameLead: plainTree.get(refOf(SESSION.claudeTitled))!.nameLead,
    });
    // the delegated child sits under its parent in the tree
    const parent = sessions.get(refOf(SESSION.codexParent))!;
    expect(parent.children?.map((child) => child.providerSessionRef)).toEqual([
      refOf(SESSION.claudeChild),
    ]);
    expect(sessionOf(booted, SESSION.claudeChild)).toMatchObject({
      parent_session_id: parent.id,
      parent_basis: 'paseo',
    });
    // a native subagent keeps its native parent whatever Paseo says (P-23)
    expect(sessionOf(booted, SESSION.codexNativeChild)).toMatchObject({ parent_basis: 'native' });
    // a parent agent that is not listed gives no edge: the relationship is Unknown
    expect(sessionOf(booted, SESSION.codexNative)).toMatchObject({
      kind: 'unknown',
      parent_session_id: null,
    });
    expect(row(SESSION.codexNative).relationshipLabel).toBe('Unknown relationship');

    // Sources says what Paseo found, with the agent no session matched counted and adding nothing
    const source = await paseoSource(booted);
    expect(source).toMatchObject({ status: 'ok', lastAttemptResult: 'succeeded' });
    expect(source!.message).toContain('Paseo agent metadata from Nov 4, 2026.');
    expect(source!.message).toContain(
      '6 agents seen: 5 matched to a session, 1 not matched (they add no usage).',
    );
    expect(source!.message).toContain('One session’s parent agent isn’t one of your sessions');
    // no title or agent id the daemon gave is in anything it logged
    expect(JSON.stringify(booted.logs)).not.toMatch(/SENTINEL_PASEO|a-parent|a-child/);
    await booted.server.shutdown();
  });
});

describe('a daemon that is off or asks for a password is a state, and the last snapshot stays', () => {
  it('keeps the names and parents when the daemon goes away, and says so', async () => {
    const paseo = daemon();
    const booted = await bootOver(makeHome(), { paseo });
    await refresh(booted);
    const enriched = shape(await tree(booted));
    const totals = events(booted);

    paseo.state.mode = 'down';
    const run = await refresh(booted);
    // the run is not a failure: a daemon that is not running is Paseo's own state
    expect(run.state).not.toBe('failed');
    expect(await paseoSource(booted)).toMatchObject({
      status: 'notrunning',
      consecutiveFailures: 0,
    });
    expect(shape(await tree(booted))).toEqual(enriched);
    expect(events(booted)).toEqual(totals);

    // the daemon comes back and the source is ok again
    paseo.state.mode = 'ok';
    await refresh(booted);
    expect(await paseoSource(booted)).toMatchObject({ status: 'ok', consecutiveFailures: 0 });
    await booted.server.shutdown();
  });

  it('says it needs a password, never asks for one, and still uses the last snapshot', async () => {
    const paseo = daemon();
    const booted = await bootOver(makeHome(), { paseo });
    await refresh(booted);
    const enriched = shape(await tree(booted));

    paseo.state.mode = 'password';
    const run = await refresh(booted);
    expect(run.state).not.toBe('failed');
    expect(await paseoSource(booted)).toMatchObject({
      status: 'needspassword',
      consecutiveFailures: 0,
    });
    expect(shape(await tree(booted))).toEqual(enriched);
    // one connection a refresh and no other way in: nothing was sent but the listing request
    expect(paseo.fake.lists.every((list) => list.includeBackground === true)).toBe(true);
    await booted.server.shutdown();
  });

  it('a daemon that was never reachable leaves the tree as the local sources made it', async () => {
    const paseo = daemon();
    paseo.state.mode = 'down';
    const plain = await bootOver(makeHome());
    await refresh(plain);
    const without = shape(await tree(plain));
    await plain.server.shutdown();

    const booted = await bootOver(makeHome(), { paseo });
    const run = await refresh(booted);
    expect(run.state).not.toBe('failed');
    expect(await paseoSource(booted)).toMatchObject({ status: 'notrunning' });
    expect(shape(await tree(booted))).toEqual(without);
    await booted.server.shutdown();
  });
});

describe('a transcript that is read again does not undo what Paseo recorded', () => {
  it('keeps the Paseo parent of a session when its own transcript grows and the daemon is off', async () => {
    const home = makeHome();
    const paseo = daemon();
    const booted = await bootOver(home, { paseo });
    await refresh(booted);
    const before = sessionOf(booted, SESSION.claudeChild);
    expect(before).toMatchObject({ parent_basis: 'paseo', kind: 'child' });

    // the session writes another line, so the Claude Code adapter reads it again; the daemon is off for this refresh
    appendFileSync(
      join(
        home,
        '.claude/projects/-fixture-SENTINEL_CWD_a1b2c3-app/22222222-bbbb-4bbb-8bbb-000000000002.jsonl',
      ),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-10-12T15:00:00.000Z',
        sessionId: SESSION.claudeChild,
        message: { role: 'user', content: 'SENTINEL_PROMPT_body' },
      }) + '\n',
    );
    paseo.state.mode = 'down';
    await refresh(booted);
    expect(sessionOf(booted, SESSION.claudeChild)).toEqual(before);
    await booted.server.shutdown();
  });
});

describe('the last snapshot also applies to a session a later run imports', () => {
  it('a run of Claude Code alone, which never asks Paseo, still names and parents a session the stored snapshot knows', async () => {
    const home = makeHome();
    const paseo = daemon();
    const NEW = '44444444-dddd-4ddd-8ddd-000000000004';
    paseo.state.entries = [
      ...AGENTS,
      entry('a-late', 'claude', NEW, { title: 'SENTINEL_PASEO_late', parent: AGENT.parent }),
    ];
    const booted = await bootOver(home, { paseo });
    await refresh(booted);
    // the agent is stored, and no session matches it yet
    expect(
      booted.server.db!.prepare("SELECT COUNT(*) AS n FROM paseo_agent WHERE id = 'a-late'").get(),
    ).toEqual({ n: 1 });
    expect(sessionOf(booted, NEW)).toBeUndefined();

    // the session appears on disk afterwards (the same invented transcript under another id and other message ids)
    const dir = join(home, '.claude/projects/-fixture-SENTINEL_CWD_d4e5f6-lib');
    const original = readFileSync(join(dir, '33333333-cccc-4ccc-8ccc-000000000003.jsonl'), 'utf8');
    writeFileSync(
      join(dir, `${NEW}.jsonl`),
      original
        .replaceAll('33333333-cccc-4ccc-8ccc-000000000003', NEW)
        .replaceAll('msg_fixture', 'msg_late')
        .replaceAll('req_fixture', 'req_late'),
    );
    const connects = paseo.fake.connects;
    const run = await refresh(booted, ['claude']);
    expect(run.state).toBe('succeeded');
    // Paseo was not asked this time ...
    expect(paseo.fake.connects).toBe(connects);
    // ... and the session is still enriched, from what was stored
    expect(sessionOf(booted, NEW)).toMatchObject({
      paseo_agent_id: 'a-late',
      kind: 'child',
      parent_basis: 'paseo',
    });
    await booted.server.shutdown();
  });
});
