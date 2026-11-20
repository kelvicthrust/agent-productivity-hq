import type { HqActivity, HqState, HqWaitReason } from '../../../shared/contracts/hq.ts';
import type { LiveAgent } from './liveAgent.ts';

// Paseo's reported state for one agent, as an HQ state (data-and-sources › Live roster (HQ) › State mapping). Pure: a function of
// the kept agent and the clock. Every result is `confidence: 'reported'`: Paseo said it, nothing is inferred from silence here.

/** A closed agent shows as finished for this long after its last update. */
export const CLOSED_FINISHED_MS = 60_000;
/** An idle agent whose turn finished shows as finished for this long after Paseo's attention time. */
export const FINISHED_ATTENTION_MS = 10 * 60_000;
/** An idle or failed agent is shown only if it was updated this recently (Paseo keeps non-archived agents indefinitely). */
export const IDLE_VISIBLE_MS = 30 * 60_000;

export interface LiveState {
  state: HqState;
  activity: HqActivity;
  waitReason: HqWaitReason | null;
  /** When the state last changed, as far as Paseo says (epoch ms). */
  since: number;
}

const waitReasonOf = (kind: string | null): HqWaitReason =>
  kind === 'question' ? 'question' : kind === 'plan' ? 'plan_approval' : 'permission';

/** The state of `agent` at `now`, or null when it is not on the roster (archived, closed long ago, idle for too long). */
export function mapLiveState(agent: LiveAgent, now: number): LiveState | null {
  if (agent.archived) return null;
  const attentionSince = agent.attentionAt ?? agent.updatedAt;

  if (agent.pendingPermissionKind !== null || agent.attentionReason === 'permission') {
    return {
      state: 'waiting',
      activity: 'none',
      waitReason: waitReasonOf(agent.pendingPermissionKind),
      since: attentionSince,
    };
  }
  if (agent.status === 'error' || agent.providerUnavailable || agent.attentionReason === 'error') {
    // Paseo keeps an old failure on an agent until it is archived, so one nobody has touched for a while leaves like an idle one.
    return now - agent.updatedAt < IDLE_VISIBLE_MS
      ? { state: 'error', activity: 'none', waitReason: null, since: attentionSince }
      : null;
  }
  if (agent.status === 'running') {
    return {
      state: 'working',
      activity: 'none',
      waitReason: null,
      since: agent.turnStartedAt ?? agent.updatedAt,
    };
  }
  if (agent.status === 'initializing') {
    return { state: 'starting', activity: 'none', waitReason: null, since: agent.updatedAt };
  }
  if (agent.status === 'closed') {
    return now - agent.updatedAt < CLOSED_FINISHED_MS
      ? { state: 'finished', activity: 'none', waitReason: null, since: agent.updatedAt }
      : null;
  }
  // Idle (and any status this code does not know, which is read the same way).
  if (
    agent.attentionReason === 'finished' &&
    agent.attentionAt !== null &&
    now - agent.attentionAt < FINISHED_ATTENTION_MS
  ) {
    return { state: 'finished', activity: 'none', waitReason: null, since: agent.attentionAt };
  }
  return now - agent.updatedAt < IDLE_VISIBLE_MS
    ? { state: 'idle', activity: 'none', waitReason: null, since: agent.updatedAt }
    : null;
}
