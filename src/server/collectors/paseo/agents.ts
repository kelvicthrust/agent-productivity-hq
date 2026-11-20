import type { PaseoAgentInput, PaseoProvider } from '../../db/queries/paseo.ts';

// What the Paseo collector reads from the daemon, and how one listed agent becomes the row `upsertPaseoAgents` stores
// (data-and-sources › Paseo enrichment). Everything here is a pure function of what `agents.list` answered, so it is tested
// without a daemon; the SDK itself is only touched in open.ts.
//
// The types below are the part of @getpaseo/client's `agents.list` this collector reads. They are written out, not imported, so
// that tests can pass a fake client and so the collector says which fields it depends on. The SDK's own `PaseoClient` must stay
// assignable to `PaseoClientLike`: open.ts returns it as one, and the typecheck is what keeps the two in step.

/** The part of one `agents.list` entry the collector reads. */
export interface PaseoListEntry {
  agent: {
    id: string;
    /** The provider the agent runs, e.g. `codex` or `claude`. */
    provider: string;
    title?: string | null | undefined;
    cwd?: string | null | undefined;
    workspaceId?: string | undefined;
    /** A delegated agent carries its parent's id under `paseo.parent-agent-id`. */
    labels?: Record<string, string> | undefined;
    /** `sessionId` is the provider's own session id, once the agent has started one. */
    runtimeInfo?: { sessionId: string | null } | undefined;
    /** An ISO time, or null/absent while the agent is not archived. */
    archivedAt?: string | null | undefined;
  };
  project?: { workspaceName?: string | null | undefined } | null | undefined;
}

export interface PaseoListOptions {
  includeBackground: true;
  filter: { includeBackground: true; includeArchived: boolean };
  page: { limit: number; cursor?: string };
}

export interface PaseoListResult {
  entries: PaseoListEntry[];
  pageInfo: { hasMore: boolean; nextCursor: string | null };
}

/** The slice of the SDK's client the collector uses: connect, list, close. */
export interface PaseoClientLike {
  connect(): Promise<void>;
  close(): Promise<void>;
  agents: { list(options: PaseoListOptions): Promise<PaseoListResult> };
}

/** `PARENT_AGENT_ID_LABEL` in @getpaseo/protocol/agent-labels (not a direct dependency, so the string is kept here, as E3 does). */
const PARENT_LABEL = 'paseo.parent-agent-id';

/**
 * `codex` and `claude` are the two providers a stored session can come from; every other provider is `other` and can never be
 * joined. Matches E3's mapping, so the experiment and the collector agree on what a Codex or Claude agent is.
 */
export function normaliseProvider(provider: string): PaseoProvider {
  const name = provider.split('/')[0]?.trim().toLowerCase() ?? '';
  if (name.startsWith('codex')) return 'codex';
  if (name.startsWith('claude')) return 'claude';
  return 'other';
}

/** A string that says something, trimmed; anything else is null. */
function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** Epoch ms from the daemon's ISO time. An archive time that cannot be read still means "archived", so it is read as `fallback`. */
function archivedAt(value: string | null | undefined, fallback: number): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * One listed agent as stored. Parentage and names come from Paseo only: the title, the parent label and the workspace name are
 * copied as given, never guessed from a folder or a time. `background` is false because the SDK gives no per-agent background
 * flag (`includeBackground` only widens the listing), so the collector does not claim one. `lastUsage` (cost) is not read.
 */
export function toAgentInput(entry: PaseoListEntry, now: number): PaseoAgentInput {
  const { agent, project } = entry;
  return {
    id: agent.id,
    title: text(agent.title),
    provider: normaliseProvider(agent.provider),
    providerSessionId: text(agent.runtimeInfo?.sessionId),
    parentAgentId: text(agent.labels?.[PARENT_LABEL]),
    workspaceId: text(agent.workspaceId),
    workspaceLabel: text(project?.workspaceName),
    cwd: text(agent.cwd),
    background: false,
    archivedAt: archivedAt(agent.archivedAt, now),
  };
}

const PAGE_SIZE = 200;
/** Enough for 20,000 agents. A listing that never ends (a cursor that never runs out) is cut here and reported as partial. */
const MAX_PAGES = 100;

export interface Listing {
  agents: PaseoAgentInput[];
  /** True when the daemon still had more to give when the page limit was reached. */
  truncated: boolean;
}

/**
 * Every agent the daemon lists, background ones included and archived ones too when asked, one page at a time. An agent listed
 * twice (live and archived views overlap) is kept once, the last copy winning.
 */
export async function listAgents(
  client: PaseoClientLike,
  includeArchived: boolean,
  now: number,
): Promise<Listing> {
  const byId = new Map<string, PaseoAgentInput>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; ; page++) {
    if (page === MAX_PAGES) {
      truncated = true;
      break;
    }
    const result = await client.agents.list({
      includeBackground: true,
      filter: { includeBackground: true, includeArchived },
      page: { limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
    });
    for (const entry of result.entries) byId.set(entry.agent.id, toAgentInput(entry, now));
    const next = result.pageInfo.nextCursor;
    // A cursor seen before would list the same page again for ever.
    if (!result.pageInfo.hasMore || next === null || next === '' || cursors.has(next)) break;
    cursors.add(next);
    cursor = next;
  }
  return { agents: [...byId.values()], truncated };
}
