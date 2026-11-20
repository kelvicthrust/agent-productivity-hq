import type { Provider } from '../../../shared/contracts/common';
import type { Session } from '../../../shared/contracts/usage';
import { relationshipOf } from '../../components/SessionIdentity';
import type { TokenTotals } from '../../components/TokenStack';
import type { Filters } from '../../lib/filters';
import { count, dotJoin } from '../../lib/format';
import { USAGE_COPY } from './copy';
import { groupId, sessionId, unknownId, type ExpandedSet } from './expandedSet';
import { useGroupSessions, type GroupSessions, type UsageGroup } from './queries';

// What the Usage tree shows, decided once for both renderers. `UsageTreeTable` flattens these nodes into table rows and
// `UsageTreeList` nests them into lists, so the table and the phone cards cannot disagree about which rows exist.

/** What both renderers need to draw any group. */
export interface TreeContext {
  filters: Filters;
  /** The providers in scope: a token total is shown for each of them and never added to the other. */
  providers: readonly Provider[];
  /** Providers whose coverage has no figures for the period: their totals read "—", not a covered 0. */
  uncovered: ReadonlySet<Provider>;
  /** The report timezone, for the Started time. */
  timeZone: string;
  expanded: ExpandedSet;
}

export type TreeNode = SessionNode | MoreNode | UnknownNode;

export interface SessionNode {
  kind: 'session';
  session: Session;
  /** 2 for a root or an orphan, 3 for a child (the group row is level 1). */
  level: 2 | 3;
  /** More for the relationship line under the name: "2 children", "parent outside current filters". */
  details: string[];
  /** How many children the row has to show or hide. Zero means it has no toggle. */
  childCount: number;
  open: boolean;
  /** The children, only while the row is open. */
  children: TreeNode[];
}

/** "Show 15 more roots": the roots the group has beyond the pages loaded so far. */
export interface MoreNode {
  kind: 'more';
  remaining: number;
}

/** The header of the sessions whose parent was never recorded, with those sessions while it is open. */
export interface UnknownNode {
  kind: 'unknown';
  groupKey: string;
  count: number;
  open: boolean;
  sessions: TreeNode[];
}

const leaf = (session: Session, level: 2 | 3, details: string[] = []): SessionNode => ({
  kind: 'session',
  session,
  level,
  details,
  childCount: 0,
  open: false,
  children: [],
});

/** The rows of one open group, in the design's order: roots (with their children), "show more", orphans, unknown. */
export function layoutGroup(
  groupKey: string,
  sessions: Pick<GroupSessions, 'roots' | 'orphans' | 'unknown' | 'remaining'>,
  expanded: ExpandedSet,
): TreeNode[] {
  const nodes: TreeNode[] = sessions.roots.map((root) => {
    const kids = root.children ?? [];
    const open = kids.length > 0 && expanded.has(sessionId(root.id));
    return {
      kind: 'session',
      session: root,
      level: 2,
      details: kids.length > 0 ? [count(kids.length, 'child', 'children')] : [],
      childCount: kids.length,
      open,
      children: open ? kids.map((kid) => leaf(kid, 3)) : [],
    };
  });
  if (sessions.remaining > 0) nodes.push({ kind: 'more', remaining: sessions.remaining });
  for (const orphan of sessions.orphans) {
    nodes.push(leaf(orphan, 2, [USAGE_COPY.tree.parentOutside]));
  }
  if (sessions.unknown.length > 0) {
    const open = expanded.has(unknownId(groupKey));
    nodes.push({
      kind: 'unknown',
      groupKey,
      count: sessions.unknown.length,
      open,
      sessions: open ? sessions.unknown.map((session) => leaf(session, 3)) : [],
    });
  }
  return nodes;
}

/** The nodes in reading order with nesting removed: the rows of the table. */
export function flatten(nodes: readonly TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) =>
    node.kind === 'session'
      ? [node, ...flatten(node.children)]
      : node.kind === 'unknown'
        ? [node, ...flatten(node.sessions)]
        : [node],
  );
}

export interface GroupView {
  group: UsageGroup;
  key: string;
  label: string;
  /** "2 roots · 8 sessions · repo recorded, not on your tracked list" */
  summary: string;
  tokens: TokenTotals;
  /** A group with no sessions has nothing to open. */
  expandable: boolean;
  open: boolean;
  sessions: GroupSessions;
  /** Empty while the group is closed or its sessions have not arrived. */
  nodes: TreeNode[];
}

/** One group's row and, once it is open, its sessions. Reads the group's roots only while it is open. */
export function useGroupView(group: UsageGroup, ctx: TreeContext): GroupView {
  const key = group.key ?? '';
  const expandable = (group.sessions ?? 0) > 0;
  const open = expandable && ctx.expanded.has(groupId(key));
  const sessions = useGroupSessions(key, ctx.filters, open);
  const tokens: TokenTotals = {};
  for (const provider of ctx.providers) {
    tokens[provider] = ctx.uncovered.has(provider) ? null : (group.tokens?.[provider] ?? 0);
  }
  return {
    group,
    key,
    label: group.label ?? key,
    summary: dotJoin([
      count(group.roots ?? 0, 'root'),
      count(group.sessions ?? 0, 'session'),
      group.note,
    ]),
    tokens,
    expandable,
    open,
    sessions,
    nodes: open && sessions.status === 'ready' ? layoutGroup(key, sessions, ctx.expanded) : [],
  };
}

/** The name a session leads with, which its toggle repeats: the recorded name, else its relationship. */
export function leadOf(session: Session): string {
  return session.named && session.nameLead !== '' ? session.nameLead : relationshipOf(session);
}

/** The name of a session's toggle: its name and its technical id, and what pressing it does. */
export function sessionToggleLabel(node: SessionNode): string {
  const name = `${leadOf(node.session)}, ${node.session.providerSessionRef}`;
  return node.open
    ? USAGE_COPY.tree.hideChildren(node.childCount, name)
    : USAGE_COPY.tree.showChildren(node.childCount, name);
}
