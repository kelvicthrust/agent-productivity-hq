import { useRef, type RefObject } from 'react';
import { SessionIdentity } from '../../components/SessionIdentity';
import { SessionLinks } from '../../components/SessionLinks';
import { TokenStack } from '../../components/TokenStack';
import { compact } from '../../lib/format';
import { USAGE_COPY } from './copy';
import { groupId, sessionId, unknownId } from './expandedSet';
import type { GroupSessions, UsageGroup } from './queries';
import {
  GroupLabel,
  GroupStatus,
  RowToggle,
  SessionBuddy,
  ShowMore,
  ToggleSpacer,
  groupToggleLabel,
} from './treeParts';
import {
  sessionToggleLabel,
  useGroupView,
  type SessionNode,
  type TreeContext,
  type TreeNode,
  type UnknownNode,
} from './treeModel';

// The Usage tree below 640px: nested lists, drawn instead of the table (TECH T5-2; the same decision as Delivery). The
// prototype turned the table's own rows into cards by overriding `display`, which the design itself flags as possibly
// dropping table semantics for assistive technology. A list has no such caveat, and no hidden duplicate cells: a card
// states provider, model and Started once, in its identity block, because there is nowhere else they could come from.
//
//   group    one line: name, "N roots · N sessions", then the stacked token totals; the fill spans the whole row (D7)
//   session  a card: its identity (name, relationship line, "Session ID:", then provider · model · Started) across the
//            full width, then Tokens and Linked PRs on one labelled line
//   others   "show more" and the unknown-relationship header keep one line

const TREE = USAGE_COPY.tree;

export function UsageTreeList({
  groups,
  ctx,
}: {
  groups: readonly UsageGroup[];
  ctx: TreeContext;
}) {
  return (
    <ul aria-label={TREE.listLabel} className="flex flex-col">
      {groups.map((group) => (
        <GroupItem key={group.key} group={group} ctx={ctx} />
      ))}
    </ul>
  );
}

function GroupItem({ group, ctx }: { group: UsageGroup; ctx: TreeContext }) {
  const view = useGroupView(group, ctx);
  const toggle = useRef<HTMLButtonElement>(null);
  return (
    <li className="border-b border-border py-2 first:pt-0 last:border-b-0 last:pb-0">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-1.5 rounded-sm bg-canvas px-2 py-2">
        {view.expandable ? (
          <RowToggle
            buttonRef={toggle}
            open={view.open}
            label={groupToggleLabel(view)}
            onToggle={() => ctx.expanded.toggle(groupId(view.key))}
          />
        ) : (
          <ToggleSpacer />
        )}
        <GroupLabel view={view} />
        <TokenStack totals={view.tokens} providers={ctx.providers} />
      </div>
      {view.open &&
        (view.sessions.status === 'ready' ? (
          <NodeList nodes={view.nodes} sessions={view.sessions} ctx={ctx} groupToggle={toggle} />
        ) : (
          <div className="px-2 py-2">
            <GroupStatus sessions={view.sessions} />
          </div>
        ))}
    </li>
  );
}

function NodeList({
  nodes,
  sessions,
  ctx,
  groupToggle,
  nested,
}: {
  nodes: readonly TreeNode[];
  sessions: GroupSessions;
  ctx: TreeContext;
  groupToggle: RefObject<HTMLButtonElement | null>;
  /** A list of children or of unknown-relationship sessions, drawn one step in. */
  nested?: boolean;
}) {
  return (
    <ul className={nested ? 'pl-3.5' : undefined}>
      {nodes.map((node) => {
        if (node.kind === 'session') {
          return (
            <SessionItem key={node.session.id} node={node} {...{ sessions, ctx, groupToggle }} />
          );
        }
        if (node.kind === 'unknown') {
          return <UnknownItem key="unknown" node={node} {...{ sessions, ctx, groupToggle }} />;
        }
        return (
          <li key="more" className="py-1">
            <ShowMore remaining={node.remaining} sessions={sessions} groupToggle={groupToggle} />
          </li>
        );
      })}
    </ul>
  );
}

function SessionItem({
  node,
  sessions,
  ctx,
  groupToggle,
}: {
  node: SessionNode;
  sessions: GroupSessions;
  ctx: TreeContext;
  groupToggle: RefObject<HTMLButtonElement | null>;
}) {
  const { session } = node;
  return (
    <li>
      <div data-session-id={session.id} className="flex flex-col gap-1 border-b border-border py-2">
        <div className="flex items-start gap-1.5">
          {node.childCount > 0 ? (
            <RowToggle
              open={node.open}
              label={sessionToggleLabel(node)}
              onToggle={() => ctx.expanded.toggle(sessionId(session.id))}
            />
          ) : (
            <ToggleSpacer />
          )}
          <SessionBuddy node={node} />
          <SessionIdentity session={session} details={node.details} timeZone={ctx.timeZone} />
        </div>
        {/* Tokens and Linked PRs on one labelled line (prototype: a grid of `auto minmax(0, 1fr)`). Tokens keep their own
            column; the Linked PRs column takes the rest and wraps inside itself when its PRs do not fit, so the line
            never breaks apart on a narrow phone. */}
        <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1">
          <div className="flex items-baseline gap-1">
            <dt className="text-caption text-ink-muted">{TREE.tokens}</dt>
            <dd className="m-0 text-data tabular-nums">{compact(session.tokens)}</dd>
          </div>
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            <dt className="text-caption text-ink-muted">{TREE.linkedPrs}</dt>
            <dd className="m-0 min-w-0">
              <SessionLinks session={session} timeZone={ctx.timeZone} />
            </dd>
          </div>
        </dl>
      </div>
      {node.children.length > 0 && (
        <NodeList nodes={node.children} nested {...{ sessions, ctx, groupToggle }} />
      )}
    </li>
  );
}

function UnknownItem({
  node,
  sessions,
  ctx,
  groupToggle,
}: {
  node: UnknownNode;
  sessions: GroupSessions;
  ctx: TreeContext;
  groupToggle: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <li>
      <div className="flex items-start gap-1.5 border-b border-border py-2">
        <RowToggle
          open={node.open}
          label={node.open ? TREE.hideUnknown : TREE.showUnknown}
          onToggle={() => ctx.expanded.toggle(unknownId(node.groupKey))}
        />
        <span className="flex min-w-0 flex-col gap-px">
          <span className="text-label font-semibold text-ink [overflow-wrap:anywhere]">
            {TREE.unknownHeading(node.count)}
          </span>
          <span className="text-caption text-ink-muted">{TREE.unknownNote}</span>
        </span>
      </div>
      {node.sessions.length > 0 && (
        <NodeList nodes={node.sessions} nested {...{ sessions, ctx, groupToggle }} />
      )}
    </li>
  );
}
