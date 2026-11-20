import { join } from 'node:path';
import type { PaseoAgentListResult } from '@getpaseo/client';
import { UsageError } from './lib/args.ts';
import { defineExperiment, runIfMain } from './lib/cli.ts';
import { safeText } from './lib/redact.ts';
import type { ExperimentContext } from './lib/types.ts';

// E3 · Paseo daemon listing (TECH › Feasibility experiments, data-and-sources › Paseo enrichment).
//
// The daemon is reached through `PaseoSource`, an injectable: the real one wraps @getpaseo/client (the SDK opens its own
// socket, which the lib cannot guard, so it is only used when no --paseo-fixture is given and only for a loopback
// address); the self-test uses a fake that answers from a fixture file and opens no connection. Both go through the same
// `toView`, so the fixture exercises the same field mapping the daemon's answers do.
//
// Nothing about an agent is printed or recorded except counts: not its title, folder, id, session id or labels.

const DEFAULT_URL = 'ws://127.0.0.1:6767/ws';
/** `PARENT_AGENT_ID_LABEL` in @getpaseo/protocol/agent-labels: a delegated agent carries its parent's id in this label. */
const PARENT_LABEL = 'paseo.parent-agent-id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A Codex rollout is named `rollout-<time>-<thread id>.jsonl`; the id is the last uuid in the name. */
const CODEX_FILE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The part of one `agents.list` entry this experiment reads. The SDK's own entry type must be assignable to it. */
interface EntryShape {
  agent: {
    id: string;
    provider: string;
    workspaceId?: string | undefined;
    labels?: Record<string, string> | undefined;
    runtimeInfo?: { sessionId: string | null } | undefined;
    archivedAt?: string | null | undefined;
  };
  project?: { workspaceName?: string | null | undefined } | null | undefined;
}

export interface AgentView {
  id: string;
  kind: 'codex' | 'claude' | 'other';
  sessionId: string | null;
  parentId: string | null;
  workspaceId: string | null;
  hasWorkspaceLabel: boolean;
  archived: boolean;
}

export function toView(entry: EntryShape): AgentView {
  const { agent, project } = entry;
  const provider = agent.provider.split('/')[0]?.toLowerCase() ?? '';
  return {
    id: agent.id,
    kind: provider.startsWith('codex')
      ? 'codex'
      : provider.startsWith('claude')
        ? 'claude'
        : 'other',
    sessionId: agent.runtimeInfo?.sessionId ?? null,
    parentId: agent.labels?.[PARENT_LABEL] ?? null,
    workspaceId: agent.workspaceId ?? null,
    hasWorkspaceLabel: (project?.workspaceName ?? '').trim().length > 0,
    archived: Boolean(agent.archivedAt),
  };
}

export interface PaseoSource {
  /** Agents with background ones included; archived ones too when asked. Rejects when the daemon refuses. */
  listAgents(includeArchived: boolean): Promise<AgentView[]>;
  close(): Promise<void>;
}

type Opened = { kind: 'open'; source: PaseoSource } | { kind: 'down' } | { kind: 'password' };

async function openDaemon(url: string): Promise<Opened> {
  const { createPaseoClient } = await import('@getpaseo/client');
  const client = createPaseoClient({ url, reconnect: { enabled: false }, connectTimeoutMs: 8_000 });
  try {
    await client.connect();
  } catch (error) {
    await client.close().catch(() => undefined);
    const needsPassword =
      (error instanceof Error && error.name === 'DaemonAuthenticationError') ||
      (error instanceof Error && /password/i.test(error.message));
    return needsPassword ? { kind: 'password' } : { kind: 'down' };
  }
  return {
    kind: 'open',
    source: {
      async listAgents(includeArchived) {
        const views: AgentView[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 20; page++) {
          const result: PaseoAgentListResult = await client.agents.list({
            includeBackground: true,
            filter: { includeBackground: true, includeArchived },
            page: { limit: 200, ...(cursor ? { cursor } : {}) },
          });
          views.push(...result.entries.map(toView));
          const next = result.pageInfo.nextCursor;
          if (!result.pageInfo.hasMore || !next) break;
          cursor = next;
        }
        return views;
      },
      close: () => client.close(),
    },
  };
}

interface FixtureFile {
  connect: 'ok' | 'refused' | 'password';
  archivedListing?: 'supported' | 'unsupported';
  agents?: EntryShape[];
  archived?: EntryShape[];
}

function openFixture(raw: FixtureFile): Opened {
  if (raw.connect === 'refused') return { kind: 'down' };
  if (raw.connect === 'password') return { kind: 'password' };
  return {
    kind: 'open',
    source: {
      listAgents(includeArchived) {
        if (!includeArchived) return Promise.resolve((raw.agents ?? []).map(toView));
        if (raw.archivedListing === 'unsupported')
          return Promise.reject(new Error('archived listing is not supported'));
        return Promise.resolve([...(raw.agents ?? []), ...(raw.archived ?? [])].map(toView));
      },
      close: () => Promise.resolve(),
    },
  };
}

const splitList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Session ids that exist on disk, read from file names only. Contents are never opened. */
function readDiskIds(ctx: ExperimentContext): { codex: Set<string>; claude: Set<string> } {
  const codexHomes = ctx.args.all('codex-home');
  const codexRoots = codexHomes.length
    ? codexHomes
    : splitList(ctx.env['CODEX_HOME']).length
      ? splitList(ctx.env['CODEX_HOME'])
      : [join(ctx.home, '.codex')];
  const claudeFlags = ctx.args.all('claude-config');
  const claudeRoots = claudeFlags.length
    ? claudeFlags
    : splitList(ctx.env['CLAUDE_CONFIG_DIR']).length
      ? splitList(ctx.env['CLAUDE_CONFIG_DIR'])
      : [join(ctx.home, '.config', 'claude'), join(ctx.home, '.claude')];

  const codex = new Set<string>();
  const claude = new Set<string>();
  for (const home of codexRoots) {
    for (const folder of ['sessions', 'archived_sessions']) {
      const root = ctx.willRead('Codex session file names (not contents)', join(home, folder));
      for (const file of ctx.fs.walk(root, { match: /\.jsonl(?:\.zst)?$/ }).files) {
        const id = file.match(CODEX_FILE)?.[1];
        if (id) codex.add(id.toLowerCase());
      }
    }
  }
  for (const config of claudeRoots) {
    const root = ctx.willRead(
      'Claude Code session file names (not contents)',
      join(config, 'projects'),
    );
    for (const file of ctx.fs.walk(root, { match: /\.jsonl$/ }).files) {
      const name = file.slice(file.lastIndexOf('/') + 1, -'.jsonl'.length);
      if (UUID.test(name)) claude.add(name.toLowerCase());
    }
  }
  return { codex, claude };
}

function loopbackUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError('--paseo-url must be a ws:// address such as ws://127.0.0.1:6767/ws');
  }
  if (parsed.protocol !== 'ws:' || !LOOPBACK.has(parsed.hostname))
    throw new UsageError(
      '--paseo-url must be a ws:// address on this machine (127.0.0.1, localhost or [::1]).',
    );
  return url;
}

export const experiment = defineExperiment({
  meta: {
    id: 'E3',
    script: 'scripts/experiments/e3-paseo.ts',
    title: 'Paseo daemon listing',
    question:
      "Does the Paseo daemon list agents without a password, and does each agent's runtimeInfo.sessionId equal the Codex or Claude session id on disk?",
    criteria: [
      {
        id: 'list-without-password',
        text: '`agents.list({includeBackground: true})` succeeds without a password.',
      },
      {
        id: 'session-id-matches-codex',
        text: '`runtimeInfo.sessionId` equals the on-disk session id for one Codex agent.',
      },
      {
        id: 'session-id-matches-claude',
        text: '`runtimeInfo.sessionId` equals the on-disk session id for one Claude agent.',
      },
      { id: 'parent-edges-present', text: 'Parent edges are present.' },
      { id: 'workspace-labels-present', text: 'Workspace labels are present.' },
      { id: 'archived-listing-recorded', text: 'Archived listing support is recorded.' },
    ],
    reads: [
      'The Paseo agent list from the daemon at ws://127.0.0.1:6767/ws (or --paseo-url, loopback only), through @getpaseo/client with no password: per agent only its provider, runtimeInfo.sessionId, parent label, workspace id and workspace label, and whether it is archived',
      'File names, never contents, of Codex sessions under ~/.codex/sessions and ~/.codex/archived_sessions (or each entry of $CODEX_HOME, or --codex-home)',
      'File names, never contents, of Claude Code sessions under ~/.config/claude/projects and ~/.claude/projects (or each entry of $CLAUDE_CONFIG_DIR, or --claude-config)',
    ],
    prints: [
      'Which folders it will read and which daemon address it will contact, then counts: agents listed per provider, how many carry a session id, how many match a session on disk, parent edges, workspace labels and archived agents, and the verdicts. Never an agent title, folder, id, session id or label',
    ],
    writes: ['docs/implementation/experiments/E3.md (the findings)'],
    network: ['127.0.0.1:6767'],
    spawns: [],
    example: 'node scripts/experiments/e3-paseo.ts',
    selftest: [
      {
        name: 'a daemon with matching Codex and Claude agents, a parent edge, workspace labels and archived listing',
        args: [
          '--paseo-fixture',
          '{fixtures}/paseo/daemon-ok.json',
          '--codex-home',
          '{fixtures}/paseo/disk/codex',
          '--claude-config',
          '{fixtures}/paseo/disk/claude',
        ],
        expect: {
          exit: 0,
          verdicts: {
            'list-without-password': 'pass',
            'session-id-matches-codex': 'pass',
            'session-id-matches-claude': 'pass',
            'parent-edges-present': 'pass',
            'workspace-labels-present': 'pass',
            'archived-listing-recorded': 'pass',
          },
          stdoutIncludes: ['Agents listed: 4'],
        },
      },
      {
        name: 'session ids that are not on disk, a parent that is not listed, no workspace labels, no archived listing',
        args: [
          '--paseo-fixture',
          '{fixtures}/paseo/daemon-mismatch.json',
          '--codex-home',
          '{fixtures}/paseo/disk/codex',
          '--claude-config',
          '{fixtures}/paseo/disk/claude',
        ],
        expect: {
          exit: 1,
          verdicts: {
            'list-without-password': 'pass',
            'session-id-matches-codex': 'fail',
            'session-id-matches-claude': 'fail',
            'parent-edges-present': 'fail',
            'workspace-labels-present': 'fail',
            'archived-listing-recorded': 'pass',
          },
        },
      },
      {
        name: 'a daemon that asks for a password',
        args: [
          '--paseo-fixture',
          '{fixtures}/paseo/daemon-password.json',
          '--codex-home',
          '{fixtures}/paseo/disk/codex',
          '--claude-config',
          '{fixtures}/paseo/disk/claude',
        ],
        expect: {
          exit: 1,
          verdicts: {
            'list-without-password': 'fail',
            'session-id-matches-codex': 'not-run',
            'session-id-matches-claude': 'not-run',
            'parent-edges-present': 'not-run',
            'workspace-labels-present': 'not-run',
            'archived-listing-recorded': 'not-run',
          },
        },
      },
      {
        name: 'no daemon running',
        args: [
          '--paseo-fixture',
          '{fixtures}/paseo/daemon-down.json',
          '--codex-home',
          '{fixtures}/paseo/disk/codex',
          '--claude-config',
          '{fixtures}/paseo/disk/claude',
        ],
        expect: {
          exit: 0,
          verdicts: {
            'list-without-password': 'not-run',
            'session-id-matches-codex': 'not-run',
            'session-id-matches-claude': 'not-run',
            'parent-edges-present': 'not-run',
            'workspace-labels-present': 'not-run',
            'archived-listing-recorded': 'not-run',
          },
        },
      },
      {
        name: 'no Codex sessions on disk to compare with',
        args: [
          '--paseo-fixture',
          '{fixtures}/paseo/daemon-ok.json',
          '--codex-home',
          '{tmp}/no-codex',
          '--claude-config',
          '{fixtures}/paseo/disk/claude',
        ],
        expect: {
          exit: 0,
          verdicts: {
            'list-without-password': 'pass',
            'session-id-matches-codex': 'not-run',
            'session-id-matches-claude': 'pass',
            'parent-edges-present': 'pass',
            'workspace-labels-present': 'pass',
            'archived-listing-recorded': 'pass',
          },
        },
      },
      {
        name: 'a daemon address that is not on this machine',
        args: [
          '--paseo-url',
          'ws://192.0.2.7:6767/ws',
          '--codex-home',
          '{fixtures}/paseo/disk/codex',
        ],
        expect: { exit: 2, verdicts: {} },
      },
    ],
  },

  async run(ctx) {
    const fixturePath = ctx.args.get('paseo-fixture');
    const url = loopbackUrl(ctx.args.get('paseo-url') ?? DEFAULT_URL);

    const disk = readDiskIds(ctx);
    let opened: Opened;
    if (fixturePath) {
      const path = ctx.willRead('Paseo daemon answers (fixture file, no connection)', fixturePath);
      opened = openFixture(
        JSON.parse(ctx.fs.readText(path, { maxBytes: 256 * 1024 })) as FixtureFile,
      );
    } else {
      ctx.out.line(`Will contact: ${new URL(url).host} (the Paseo daemon, without a password)`);
      ctx.findings.note(
        "The daemon is reached through the SDK's own loopback connection, so it does not appear under hosts contacted below.",
      );
      opened = await openDaemon(url);
    }
    ctx.findings.fact('Source', 'daemon answers came from a fixture', Boolean(fixturePath));
    ctx.findings.fact('Source', 'session files on disk (codex)', disk.codex.size);
    ctx.findings.fact('Source', 'session files on disk (claude)', disk.claude.size);

    if (opened.kind === 'password') {
      ctx.findings.criterion(
        'list-without-password',
        'fail',
        'The daemon asks for a password, which normal setup does not support (P-41).',
      );
      ctx.out.line('The daemon asked for a password.');
      return;
    }
    if (opened.kind === 'down') {
      ctx.findings.criterion(
        'list-without-password',
        'not-run',
        'No Paseo daemon accepted a connection, so nothing about its listing was evaluated.',
      );
      ctx.out.line('No Paseo daemon answered.');
      return;
    }

    const { source } = opened;
    try {
      let agents: AgentView[];
      try {
        agents = await source.listAgents(false);
      } catch {
        ctx.findings.criterion(
          'list-without-password',
          'fail',
          'The daemon connected but agents.list answered with an error.',
        );
        return;
      }
      ctx.findings.criterion(
        'list-without-password',
        'pass',
        safeText`agents.list answered with ${agents.length} agents and no password.`,
      );
      const count = (kind: AgentView['kind']) => agents.filter((a) => a.kind === kind).length;
      ctx.out.line(
        safeText`Agents listed: ${agents.length} (codex ${count('codex')}, claude ${count('claude')}, other ${count('other')}).`,
      );
      ctx.findings.fact('Listing', 'agents listed', agents.length);
      ctx.findings.fact('Listing', 'codex agents', count('codex'));
      ctx.findings.fact('Listing', 'claude agents', count('claude'));
      ctx.findings.fact('Listing', 'other agents', count('other'));

      for (const kind of ['codex', 'claude'] as const) {
        const id = `session-id-matches-${kind}`;
        const ofKind = agents.filter((a) => a.kind === kind);
        const withSession = ofKind.filter((a) => a.sessionId);
        const onDisk = disk[kind];
        const matched = withSession.filter((a) =>
          onDisk.has((a.sessionId ?? '').toLowerCase()),
        ).length;
        ctx.findings.fact('Session ids', `${kind} agents with a session id`, withSession.length);
        ctx.findings.fact('Session ids', `${kind} agents matching a session on disk`, matched);
        if (ofKind.length === 0)
          ctx.findings.criterion(id, 'not-run', safeText`No ${kind} agent was listed.`);
        else if (onDisk.size === 0)
          ctx.findings.criterion(
            id,
            'not-run',
            safeText`No ${kind} session files were found on disk to compare with.`,
          );
        else if (matched > 0)
          ctx.findings.criterion(
            id,
            'pass',
            safeText`${kind} agents matching a session on disk: ${matched} of ${ofKind.length}.`,
          );
        else
          ctx.findings.criterion(
            id,
            'fail',
            safeText`None of ${ofKind.length} ${kind} agents (${withSession.length} with a session id) matches a session on disk, so their names and parentage would show as unmapped.`,
          );
      }

      const ids = new Set(agents.map((a) => a.id));
      const edges = agents.filter((a) => a.parentId);
      const resolved = edges.filter((a) => a.parentId && ids.has(a.parentId)).length;
      ctx.findings.fact('Parents', 'agents with a parent label', edges.length);
      ctx.findings.fact('Parents', 'parent edges whose parent is listed', resolved);
      if (agents.length === 0)
        ctx.findings.criterion('parent-edges-present', 'not-run', 'No agent was listed.');
      else if (edges.length === 0)
        ctx.findings.criterion(
          'parent-edges-present',
          'not-run',
          'No agent carried a parent label; delegate work to a child agent in Paseo and run this again.',
        );
      else if (resolved > 0)
        ctx.findings.criterion(
          'parent-edges-present',
          'pass',
          safeText`Parent edges: ${edges.length}, with the parent listed: ${resolved}.`,
        );
      else
        ctx.findings.criterion(
          'parent-edges-present',
          'fail',
          safeText`${edges.length} agents name a parent, but no parent is in the listing, so the relationship would show as unknown.`,
        );

      const withWorkspace = agents.filter((a) => a.workspaceId);
      const labelled = agents.filter((a) => a.hasWorkspaceLabel).length;
      ctx.findings.fact('Workspaces', 'agents with a workspace id', withWorkspace.length);
      ctx.findings.fact('Workspaces', 'agents with a workspace label', labelled);
      if (agents.length === 0)
        ctx.findings.criterion('workspace-labels-present', 'not-run', 'No agent was listed.');
      else if (labelled > 0)
        ctx.findings.criterion(
          'workspace-labels-present',
          'pass',
          safeText`Agents carrying a workspace label: ${labelled} of ${agents.length}.`,
        );
      else
        ctx.findings.criterion(
          'workspace-labels-present',
          'fail',
          safeText`No agent carried a workspace label (${withWorkspace.length} have a workspace id).`,
        );

      try {
        const withArchived = await source.listAgents(true);
        const archived = withArchived.filter((a) => a.archived).length;
        ctx.findings.fact('Archived', 'archived listing supported', true);
        ctx.findings.fact('Archived', 'agents with archived included', withArchived.length);
        ctx.findings.fact('Archived', 'archived agents returned', archived);
        ctx.findings.criterion(
          'archived-listing-recorded',
          'pass',
          safeText`Archived listing is supported; archived agents returned: ${archived}.`,
        );
      } catch {
        ctx.findings.fact('Archived', 'archived listing supported', false);
        ctx.findings.criterion(
          'archived-listing-recorded',
          'pass',
          'Archived listing is not supported by this daemon; coverage starts at the first snapshot.',
        );
      }
    } finally {
      await source.close().catch(() => undefined);
    }
  },
});

runIfMain(import.meta, experiment);
