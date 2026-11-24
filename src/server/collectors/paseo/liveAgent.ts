import { liveTime } from '../../lib/liveTime.ts';
import {
  MAX_LIVE_ID_CHARS,
  MAX_LIVE_PATH_CHARS,
  MAX_LIVE_TITLE_CHARS,
  clipped,
  fits,
} from '../../lib/liveText.ts';

// What the live feed keeps of one Paseo agent (data-and-sources › Live roster (HQ)). `readLiveAgent` builds the record field by
// field from the daemon's snapshot, so a field this file does not name is never copied, stored, logged or returned: not `lastError`,
// not a permission's `input`, `description`, `title`, `detail` or `metadata`, not `lastUsage`, not any message text. Pure.

/** The part of an agent snapshot HQ keeps. Times are epoch ms. */
export interface LiveAgent {
  id: string;
  /** The provider as Paseo names it (`codex`, `claude`, ...); `normaliseProvider` maps it. */
  provider: string;
  cwd: string | null;
  title: string | null;
  /** The project's workspace name, when Paseo gave one. */
  workspaceName: string | null;
  /** `paseo.parent-agent-id`: the Paseo id of the agent that started this one. */
  parentAgentId: string | null;
  /** The provider's own session id (`runtimeInfo.sessionId`). */
  sessionId: string | null;
  /** `initializing`, `idle`, `running`, `error` or `closed`; anything else is kept as given and read as idle. */
  status: string;
  /** Paseo explicitly reports no prompt or saved session, with no work, attention or uncertain evidence. */
  reportsEmptyThread: boolean;
  hasActiveTurn: boolean;
  /** `activeTurn.startedAt`. */
  turnStartedAt: number | null;
  backgroundWorkActive: boolean;
  /** The kind of the first pending permission request (`tool`, `plan`, `question`, ...), null when none is pending. */
  pendingPermissionKind: string | null;
  requiresAttention: boolean | undefined;
  /** `finished`, `error` or `permission`. */
  attentionReason: string | null;
  attentionAt: number | null;
  updatedAt: number;
  createdAt: number | null;
  archived: boolean;
  providerUnavailable: boolean;
}

/** A `paseo.parent-agent-id` label is kept here as in agents.ts (`PARENT_AGENT_ID_LABEL` in @getpaseo/protocol is not a dependency). */
const PARENT_LABEL = 'paseo.parent-agent-id';

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const isAbsent = (value: unknown): boolean => value === undefined || value === null;

/** A string that says something, trimmed; anything else is null. */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Epoch ms from an ISO time; null when absent, unreadable, or outside the window HQ keeps (`liveTime`: a time `Date` cannot hold would make the response fail). */
function time(value: unknown, now: number): number | null {
  if (typeof value !== 'string' || value === '') return null;
  return liveTime(Date.parse(value), now);
}

/**
 * One listed or updated agent, as kept. `entry` is `{ agent, project }` as `agents.list` and `agent_update` give it; null when it
 * has no usable id. `now` stands in for an update time the daemon did not give.
 */
export function readLiveAgent(entry: unknown, now: number): LiveAgent | null {
  const holder = record(entry);
  const agent = record(holder?.agent);
  const id = fits(text(agent?.id), MAX_LIVE_ID_CHARS);
  if (!agent || id === null) return null;
  const labels = record(agent.labels);
  const permissions = Array.isArray(agent.pendingPermissions) ? agent.pendingPermissions : [];
  const first = permissions.length > 0 ? record(permissions[0]) : null;
  const createdAt = time(agent.createdAt, now);
  const runtimeSessionId = record(agent.runtimeInfo)?.sessionId;
  const turn = record(agent.activeTurn);
  const backgroundCount = record(agent.backgroundWork)?.count;
  const status = clipped(text(agent.status), MAX_LIVE_TITLE_CHARS);
  // Missing optional fields are valid on older daemons. A present but malformed value cannot prove a thread is empty.
  const reportsEmptyThread =
    (status === 'idle' || status === 'closed' || status === 'initializing') &&
    agent.lastUserMessageAt === null &&
    agent.persistence === null &&
    (agent.runtimeInfo === undefined || runtimeSessionId === null) &&
    isAbsent(agent.activeTurn) &&
    (agent.backgroundWork === undefined || backgroundCount === 0) &&
    (agent.pendingPermissions === undefined ||
      (Array.isArray(agent.pendingPermissions) && permissions.length === 0)) &&
    (agent.requiresAttention === undefined || agent.requiresAttention === false) &&
    isAbsent(agent.attentionReason) &&
    isAbsent(agent.attentionTimestamp) &&
    (agent.providerUnavailable === undefined || agent.providerUnavailable === false);
  return {
    id,
    provider: clipped(text(agent.provider), MAX_LIVE_TITLE_CHARS) ?? '',
    cwd: fits(text(agent.cwd), MAX_LIVE_PATH_CHARS),
    title: clipped(text(agent.title), MAX_LIVE_TITLE_CHARS),
    workspaceName: clipped(text(record(holder?.project)?.workspaceName), MAX_LIVE_TITLE_CHARS),
    parentAgentId: fits(text(labels?.[PARENT_LABEL]), MAX_LIVE_ID_CHARS),
    sessionId: fits(text(runtimeSessionId), MAX_LIVE_ID_CHARS),
    status: status ?? 'idle',
    reportsEmptyThread,
    hasActiveTurn: turn !== null,
    turnStartedAt: time(turn?.startedAt, now),
    backgroundWorkActive:
      typeof backgroundCount === 'number' &&
      Number.isInteger(backgroundCount) &&
      backgroundCount > 0,
    pendingPermissionKind: permissions.length === 0 ? null : (text(first?.kind) ?? 'other'),
    requiresAttention:
      typeof agent.requiresAttention === 'boolean' ? agent.requiresAttention : undefined,
    attentionReason: text(agent.attentionReason),
    attentionAt: time(agent.attentionTimestamp, now),
    updatedAt: time(agent.updatedAt, now) ?? createdAt ?? now,
    createdAt,
    // An archive time that cannot be read still means "archived".
    archived:
      agent.archivedAt !== null && agent.archivedAt !== undefined && agent.archivedAt !== '',
    providerUnavailable: agent.providerUnavailable === true,
  };
}
