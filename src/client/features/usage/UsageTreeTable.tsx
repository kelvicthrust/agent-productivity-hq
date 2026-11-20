import { useId, useRef, type ReactNode, type RefObject } from 'react';
import { SessionIdentity } from '../../components/SessionIdentity';
import { SessionLinks } from '../../components/SessionLinks';
import { TokenStack } from '../../components/TokenStack';
import { PROVIDER_NAMES, SESSION_COPY } from '../../lib/copy';
import { cx } from '../../lib/cx';
import { compact, formatStarted } from '../../lib/format';
import { USAGE_COPY } from './copy';
import { groupId, sessionId, unknownId } from './expandedSet';
import type { UsageGroup } from './queries';
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
  flatten,
  sessionToggleLabel,
  useGroupView,
  type GroupView,
  type SessionNode,
  type TreeContext,
  type TreeNode,
  type UnknownNode,
} from './treeModel';

// The Usage tree at 640px and wider: a real table of six columns, Session | Provider | Model | Started | Tokens | Linked PRs.
// Every row has six cells (no colspan), and its `display` is never overridden: below 640px this component does not render at
// all, `UsageTreeList` does (TECH T5-2).
//
// D7 column policy: the Session column takes the spare width, and the Provider, Model and Started cells never wrap, so an id
// such as `claude-sonnet-5-5` or a time such as "Nov 2, 10:52 AM" is never split. When the window is too narrow for the
// columns the table scrolls inside its own region instead of breaking a value; the region is focusable, so a keyboard can
// scroll it (WCAG 2.1.1), and shows a soft edge on each side that has more to see.

const TREE = USAGE_COPY.tree;

/** The edge cue (ported from app.css `.table-wrap`): a shadow on each side with more to scroll, drawn with background layers. */
const SCROLL_CUE = [
  'linear-gradient(to right, var(--color-surface), transparent) left center / 24px 100% no-repeat local',
  'linear-gradient(to left, var(--color-surface), transparent) right center / 24px 100% no-repeat local',
  'radial-gradient(farthest-side at 0 50%, var(--scroll-edge), transparent) left center / 10px 100% no-repeat scroll',
  'radial-gradient(farthest-side at 100% 50%, var(--scroll-edge), transparent) right center / 10px 100% no-repeat scroll',
].join(', ');

const TH =
  'whitespace-nowrap border-b border-border bg-surface px-2.5 py-2 text-left text-caption font-semibold text-ink-muted';
const TD = 'border-b border-border px-2.5 py-2.5 align-top group-hover/row:bg-row-hover';
/** The Session column keeps room for a name and its ids however narrow the rest gets. */
const FIRST = 'min-w-56';

export function UsageTreeTable({
  groups,
  ctx,
}: {
  groups: readonly UsageGroup[];
  ctx: TreeContext;
}) {
  return (
    // The card has 16px of padding; the scroller bleeds into it so the table can use the full width and its edge cue sits on
    // the card's border. When the columns do not fit this is a scrollable area, and a keyboard can only scroll an area it can
    // focus (WCAG 2.1.1; axe `scrollable-region-focusable`), so it is a labelled region with tabIndex 0. The lint rule below
    // allows tabIndex on a non-interactive element only for tabpanel, which this is deliberately not.
    <div
      role="region"
      aria-label={TREE.scrollerLabel}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      className="-mx-4 overflow-x-auto px-4"
      style={{ background: SCROLL_CUE }}
    >
      <table className="w-full border-collapse text-data">
        <caption className="sr-only">{TREE.caption}</caption>
        <thead>
          <tr>
            <th scope="col" className={cx(TH, FIRST, 'w-full')}>
              {TREE.columns.session}
            </th>
            <th scope="col" className={TH}>
              {TREE.columns.provider}
            </th>
            <th scope="col" className={TH}>
              {TREE.columns.model}
            </th>
            <th scope="col" className={TH}>
              {TREE.columns.started}
            </th>
            <th scope="col" className={cx(TH, 'text-right')}>
              {TREE.columns.tokens}
            </th>
            <th scope="col" className={TH}>
              {TREE.columns.linkedPrs}
            </th>
          </tr>
        </thead>
        {/* One tbody per repository: each reads its own sessions, only once it is open. */}
        {groups.map((group) => (
          <GroupRows key={group.key} group={group} ctx={ctx} />
        ))}
      </table>
    </div>
  );
}

function GroupRows({ group, ctx }: { group: UsageGroup; ctx: TreeContext }) {
  const view = useGroupView(group, ctx);
  const toggle = useRef<HTMLButtonElement>(null);
  const { sessions } = view;
  return (
    <tbody className="last:[&>tr:last-child>td]:border-b-0">
      <tr className="group/row">
        <Cell first fill>
          <div className="flex items-start gap-1.5">
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
          </div>
        </Cell>
        <Blank n={3} fill />
        <Cell fill className="text-right">
          <TokenStack totals={view.tokens} providers={ctx.providers} />
        </Cell>
        <Blank n={1} fill />
      </tr>
      {view.open && sessions.status !== 'ready' && (
        <tr>
          <Cell first>
            <div className="pl-6">
              <GroupStatus sessions={sessions} />
            </div>
          </Cell>
          <Blank n={5} />
        </tr>
      )}
      {flatten(view.nodes).map((node) => (
        <NodeRow key={nodeKey(node)} node={node} view={view} ctx={ctx} groupToggle={toggle} />
      ))}
    </tbody>
  );
}

const nodeKey = (node: TreeNode): string =>
  node.kind === 'session' ? `s${node.session.id}` : node.kind;

function NodeRow({
  node,
  view,
  ctx,
  groupToggle,
}: {
  node: TreeNode;
  view: GroupView;
  ctx: TreeContext;
  groupToggle: RefObject<HTMLButtonElement | null>;
}) {
  if (node.kind === 'session') return <SessionRow node={node} ctx={ctx} />;
  if (node.kind === 'unknown') return <UnknownRow node={node} ctx={ctx} />;
  return (
    <tr>
      <Cell first>
        <div className="pl-6">
          <ShowMore remaining={node.remaining} sessions={view.sessions} groupToggle={groupToggle} />
        </div>
      </Cell>
      <Blank n={5} />
    </tr>
  );
}

function SessionRow({ node, ctx }: { node: SessionNode; ctx: TreeContext }) {
  const { session } = node;
  return (
    <tr className="group/row" data-session-id={session.id}>
      <Cell first>
        <div className={cx('flex items-start gap-1.5', node.level === 2 ? 'pl-6' : 'pl-[52px]')}>
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
          {/* The columns say provider, model and time, so the identity does not repeat them. */}
          <SessionIdentity
            session={session}
            details={node.details}
            showMeta={false}
            timeZone={ctx.timeZone}
          />
        </div>
      </Cell>
      <Cell nowrap>{PROVIDER_NAMES[session.provider]}</Cell>
      <Cell nowrap className="font-mono text-mono">
        {session.model ?? '—'}
      </Cell>
      <Cell nowrap>
        <Started session={session} timeZone={ctx.timeZone} />
      </Cell>
      <Cell className="text-right tabular-nums">{compact(session.tokens)}</Cell>
      <Cell>
        <SessionLinks session={session} timeZone={ctx.timeZone} />
      </Cell>
    </tr>
  );
}

function Started({ session, timeZone }: { session: SessionNode['session']; timeZone: string }) {
  const noteId = useId();
  const firstEvent = session.startedBasis === 'first_event';
  return (
    <>
      <time dateTime={session.startedAt} aria-describedby={firstEvent ? noteId : undefined}>
        {formatStarted(session.startedAt, timeZone)}
      </time>
      {firstEvent && (
        <span id={noteId} className="sr-only">
          {SESSION_COPY.firstEventNote}
        </span>
      )}
    </>
  );
}

function UnknownRow({ node, ctx }: { node: UnknownNode; ctx: TreeContext }) {
  return (
    <tr className="group/row">
      <Cell first fill muted>
        <div className="flex items-start gap-1.5 pl-6">
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
      </Cell>
      <Blank n={5} fill />
    </tr>
  );
}

// ---- cells -------------------------------------------------------------------------------------------------------------

function Cell({
  children,
  first,
  fill,
  muted,
  nowrap,
  className,
}: {
  children?: ReactNode;
  /** The Session column. */
  first?: boolean;
  /** The sunken fill of a group row. */
  fill?: boolean;
  muted?: boolean;
  /** A data cell whose value never wraps (Provider, Model, Started). */
  nowrap?: boolean;
  className?: string;
}) {
  return (
    <td
      className={cx(
        TD,
        first && FIRST,
        fill && 'bg-canvas',
        muted && 'text-ink-muted',
        nowrap && 'whitespace-nowrap',
        className,
      )}
    >
      {children}
    </td>
  );
}

/** Empty cells that keep every row at six, so the columns stay aligned (no colspan). */
function Blank({ n, fill }: { n: number; fill?: boolean }) {
  return Array.from({ length: n }, (_, index) => <Cell key={index} fill={fill ?? false} />);
}
