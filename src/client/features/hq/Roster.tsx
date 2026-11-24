import { useId, useState } from 'react';
import { Buddy, type BuddyKind, type BuddyMood } from '../../components/Buddy';
import { statusAppearance, type StatusKind } from '../../components/StatusTag';
import { Icon } from '../../components/Icon';
import type { HqAgent } from '../../../shared/contracts/hq';
import { SESSION_COPY } from '../../lib/copy';
import { cx } from '../../lib/cx';
import { HQ_COPY, agentMeta, recentIdleLabel, stateWords } from './copy';
import type { AgentNode, Session } from './sessions';

// The roster: the accessible account of who is running, as real nested lists. One card per session; inside it the root first, its
// spawned agents indented beneath it. Rows are not interactive, and nothing on the page is a live region: a roster that changes
// every few seconds would be read out over and over (TECH: no aria-live on polling updates).

const BUDDY_KIND: Record<HqAgent['provider'], BuddyKind> = {
  codex: 'codex',
  claude: 'claude',
  other: 'unknown',
};

const MOOD: Record<HqAgent['state'], BuddyMood> = {
  starting: 'awake',
  working: 'awake',
  waiting: 'awake',
  idle: 'sleep',
  error: 'dizzy',
  finished: 'sleep',
};

/** A state that needs the owner or went wrong also gets an icon beside its words; the words carry the meaning. */
const MARK: Partial<Record<HqAgent['state'], StatusKind>> = {
  waiting: 'warn',
  error: 'error',
};

function State({ agent, nowMs }: { agent: HqAgent; nowMs: number }) {
  const kind = MARK[agent.state];
  const appearance = kind ? statusAppearance(kind) : null;
  return (
    <span
      className={cx(
        'inline-flex items-center gap-[5px] text-caption',
        appearance ? `${appearance.toneClass} font-semibold` : 'text-ink-muted',
        agent.state === 'working' && 'text-ink',
      )}
    >
      {appearance && <Icon name={appearance.icon} />}
      <span>{stateWords(agent, nowMs)}</span>
    </span>
  );
}

// Real nesting stays at any depth (a screen reader hears every level), but the drawn indent stops after this many levels: a chain
// can be many agents deep, and an indent that grows without bound pushes the rows off a phone's width.
const MAX_INDENTED_LEVELS = 3;

function Row({ node, nowMs, depth = 0 }: { node: AgentNode; nowMs: number; depth?: number }) {
  const { agent } = node;
  return (
    <li className="min-w-0">
      <div className="flex min-w-0 items-start gap-3 py-2">
        <Buddy
          kind={BUDDY_KIND[agent.provider]}
          mood={agent.backgroundWorkActive && agent.state !== 'error' ? 'awake' : MOOD[agent.state]}
          size={28}
          className="mt-0.5"
        />
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
          <div className="min-w-0">
            <p className="text-copy font-semibold text-ink [overflow-wrap:anywhere]">
              {agent.title ?? SESSION_COPY.noNameRecorded}
            </p>
            <p className="text-caption text-ink-muted [overflow-wrap:anywhere]">
              {agentMeta(agent)}
            </p>
          </div>
          <State agent={agent} nowMs={nowMs} />
        </div>
      </div>
      {node.children.length > 0 && (
        <ul
          className={
            depth < MAX_INDENTED_LEVELS
              ? 'ml-3.5 border-l border-border pl-4 max-[719px]:pl-3'
              : undefined
          }
        >
          {node.children.map((child) => (
            <Row key={child.agent.id} node={child} nowMs={nowMs} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

function SessionCard({ session, nowMs }: { session: Session; nowMs: number }) {
  const name = session.root.agent.title ?? SESSION_COPY.noNameRecorded;
  return (
    <li
      className={cx(
        'min-w-0 rounded-md border px-4 py-2 shadow-card',
        session.waiting ? 'border-warning bg-warning-surface' : 'border-border bg-surface',
      )}
    >
      <ul aria-label={HQ_COPY.sessionList(name, session.size)}>
        <Row node={session.root} nowMs={nowMs} />
      </ul>
    </li>
  );
}

interface RosterProps {
  sessions: readonly Session[];
  nowMs: number;
}

export function Roster({
  sessions,
  nowMs,
  label = HQ_COPY.sessions,
}: RosterProps & { label?: string }) {
  return (
    <ul aria-label={label} className="flex flex-col gap-3">
      {sessions.map((session) => (
        <SessionCard key={session.id} session={session} nowMs={nowMs} />
      ))}
    </ul>
  );
}

export function RecentIdle({ sessions, nowMs }: RosterProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="min-w-0 rounded-md border border-border bg-surface shadow-card">
      <button
        type="button"
        aria-controls={id}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-11 w-full items-center gap-2 rounded-md px-4 text-left text-copy font-semibold text-ink"
      >
        <Icon name={open ? 'chevronDown' : 'chevronRight'} className="text-ink-muted" />
        {recentIdleLabel(sessions.length)}
      </button>
      <div id={id} hidden={!open} className="px-3 pb-3">
        {open && <Roster sessions={sessions} nowMs={nowMs} label={HQ_COPY.recentIdle} />}
      </div>
    </div>
  );
}
