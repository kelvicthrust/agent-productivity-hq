import type { HqAgent } from '../../../shared/contracts/hq';

// The roster's shape for the page: one session per root agent (an orchestrator, a solo agent, or an agent whose parent is not on
// the roster), each holding the agents it spawned. Pure, so the ordering and the nesting are tested without a browser.

export interface AgentNode {
  agent: HqAgent;
  children: AgentNode[];
}

export interface Session {
  /** The root's id: stable across polls. */
  id: string;
  root: AgentNode;
  /** Every agent in the session, the root included. */
  size: number;
  /** Some agent in it is waiting: it is marked and listed first. */
  waiting: boolean;
}

const time = (instant: string | null) => (instant === null ? 0 : Date.parse(instant));

/** Oldest first, so a new agent joins the end and the order does not move between polls. */
function byStart(a: HqAgent, b: HqAgent): number {
  return (
    time(a.startedAt ?? a.since) - time(b.startedAt ?? b.since) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function count(node: AgentNode): number {
  return 1 + node.children.reduce((sum, child) => sum + count(child), 0);
}

function hasWaiting(node: AgentNode): boolean {
  return node.agent.state === 'waiting' || node.children.some(hasWaiting);
}

/**
 * Sessions in display order: those with a waiting agent first, then those with a working one, then the rest; newest root first
 * within each. An agent joins its parent only when the parent is on the roster; any other agent starts a session of its own
 * (`parentAway` says why). A parent cycle cannot hide anyone: the agents left over become roots.
 */
export function buildSessions(agents: readonly HqAgent[]): Session[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const childrenOf = new Map<string, HqAgent[]>();
  const roots: HqAgent[] = [];
  for (const agent of agents) {
    const parent = agent.parentId !== null && agent.parentId !== agent.id ? agent.parentId : null;
    if (parent !== null && byId.has(parent)) {
      childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), agent]);
    } else {
      roots.push(agent);
    }
  }

  const seen = new Set<string>();
  const grow = (agent: HqAgent): AgentNode => {
    seen.add(agent.id);
    const children = (childrenOf.get(agent.id) ?? [])
      .filter((child) => !seen.has(child.id))
      .sort(byStart)
      .map(grow);
    return { agent, children };
  };
  const sessions = roots.map(grow);
  // Agents in a parent cycle are reachable from no root.
  for (const agent of agents) if (!seen.has(agent.id)) sessions.push(grow(agent));

  const rank = (session: Session) =>
    session.waiting ? 0 : containsState(session.root, 'working') ? 1 : 2;
  return sessions
    .map((root) => ({
      id: root.agent.id,
      root,
      size: count(root),
      waiting: hasWaiting(root),
    }))
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        time(b.root.agent.startedAt ?? b.root.agent.since) -
          time(a.root.agent.startedAt ?? a.root.agent.since) ||
        (a.id < b.id ? -1 : 1),
    );
}

function containsState(node: AgentNode, state: HqAgent['state']): boolean {
  return node.agent.state === state || node.children.some((child) => containsState(child, state));
}
