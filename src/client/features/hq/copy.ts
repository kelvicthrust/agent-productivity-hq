import type {
  HqActivity,
  HqAgent,
  HqFeed,
  HqProvider,
  HqWaitReason,
} from '../../../shared/contracts/hq';
import { PROVIDER_NAMES, SOURCE_NAMES } from '../../lib/copy';
import { dotJoin, int } from '../../lib/format';
import { hasActionableError, isReadyToReview, isWorking } from './sessions';

// The words HQ uses. Every state is spoken in words, never by colour or art alone. The contract carries no prompt, tool name or
// error text, so none can appear here; `activity` is a coarse category. Typographic apostrophes (’) are the product's.

export const HQ_COPY = {
  title: 'HQ',
  loading: 'Loading HQ…',
  sessions: 'Sessions',
  recentIdle: 'Recent idle',
  /** The accessible name of one session's list: its root's name, then how many agents it holds. */
  sessionList: (name: string, agents: number) =>
    `${name}: ${agents === 1 ? '1 agent' : `${int(agents)} agents`}`,
  noName: 'No name recorded',
  otherProvider: 'Other agent',
  parentAway: 'Started by an agent that isn’t listed',
  truncated: 'The roster was cut to fit, so some agents aren’t shown.',
  unavailable: 'Live agents aren’t available in this session.',
  quiet: 'A quiet one. No agents are running right now.',
  noAgents: 'No agents to show right now.',
  setupIncomplete: {
    before: 'Live agents appear once setup is finished. ',
    link: 'Go to Setup',
  },
  requestError: {
    title: 'Couldn’t load HQ',
    stale: 'Couldn’t refresh HQ. The list below is the last one it received.',
    body: 'Nothing on this computer has changed. It will keep trying.',
    retry: 'Retry',
  },
  feed: {
    starting: 'Starting…',
    notFound: 'Not found',
    denied: 'Access denied',
    failed: 'Unavailable',
    unavailable: 'Not available in this session',
    /** What to do about a Claude Code or Codex feed that cannot read its sessions (Paseo's own lines are in `FeedLine`). */
    deniedDetail: (name: string) =>
      `${name}’s data is here but couldn’t be read. Allow read access, then reload this page.`,
    failedDetail: (name: string) =>
      `${name}’s recent sessions couldn’t be read. It will keep trying.`,
  },
} as const;

export const recentIdleLabel = (count: number): string => `${HQ_COPY.recentIdle} (${int(count)})`;

/** Use the roster's opaque identity to distinguish a child with a generic or missing label. */
export function agentDisplayTitle(agent: Pick<HqAgent, 'id' | 'kind' | 'title'>): string | null {
  const title = agent.title?.trim() || null;
  if (
    agent.kind === 'child' &&
    (title === null || /^(default|general-purpose|worker)$/i.test(title))
  )
    return `${title ?? 'Subagent'} · ${agent.id.slice(-6)}`;
  return title;
}

/** "Claude Code", "Codex", "Other agent". */
export function providerName(provider: HqProvider): string {
  return provider === 'other' ? HQ_COPY.otherProvider : PROVIDER_NAMES[provider];
}

/** The name of a feed: Paseo, Claude Code or Codex (the words the Sources screen uses). */
export function feedName(feed: HqFeed): string {
  return SOURCE_NAMES[feed.id];
}

const WORKING: Record<HqActivity, string> = {
  thinking: 'Thinking',
  responding: 'Responding',
  reading: 'Reading',
  editing: 'Editing',
  command: 'Running a command',
  delegating: 'Delegating',
  planning: 'Planning',
  tool: 'Using a tool',
  none: 'Working',
};

const WAITING: Record<HqWaitReason, string> = {
  permission: 'Needs you: permission',
  question: 'Needs you: question',
  plan_approval: 'Needs you: plan approval',
};

/** "12 min", "2 h 5 min", "3 d": how long ago, coarse on purpose. Under a minute reads "under a minute". */
export function elapsed(sinceMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - sinceMs) / 60_000));
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d`;
}

/**
 * What an agent is doing, in words: "Editing", "Needs you: permission", "May be waiting for you" (a waiting state that was
 * inferred from silence, not reported), "Idle for 12 min". `nowMs` is the clock the idle time is measured against.
 */
export function stateWords(
  agent: Pick<
    HqAgent,
    | 'state'
    | 'activity'
    | 'waitReason'
    | 'confidence'
    | 'since'
    | 'reviewPending'
    | 'backgroundWorkActive'
  >,
  nowMs: number,
): string {
  if (agent.state === 'idle' || agent.state === 'finished') {
    const followUp = dotJoin([
      isReadyToReview(agent) && 'Ready to review',
      agent.backgroundWorkActive && 'Background work running',
    ]);
    if (followUp) return followUp;
  }
  switch (agent.state) {
    case 'starting':
      return 'Starting';
    case 'working':
      return WORKING[agent.activity];
    case 'waiting':
      if (agent.confidence === 'inferred') return 'May be waiting for you';
      return agent.waitReason ? WAITING[agent.waitReason] : 'Needs you';
    case 'idle':
      return `Idle for ${elapsed(Date.parse(agent.since), nowMs)}`;
    case 'error':
      return 'Something went wrong';
    case 'finished':
      return 'Finished';
  }
}

/** The line under an agent's name: provider, then where it works. */
export function agentMeta(
  agent: Pick<HqAgent, 'provider' | 'repo' | 'workspace' | 'parentAway' | 'title'>,
) {
  return dotJoin([
    providerName(agent.provider),
    agent.repo ?? (agent.workspace === agent.title ? null : agent.workspace),
    agent.parentAway && HQ_COPY.parentAway,
  ]);
}

/**
 * "3 working · 1 needs you": counts of what is happening, zeros left out. A waiting agent that was only inferred "may need you".
 * Empty when nobody is on the roster.
 */
type SummaryAgent = Pick<
  HqAgent,
  'state' | 'confidence' | 'reviewPending' | 'backgroundWorkActive' | 'confirmedEmpty'
>;

export function summaryLine(agents: readonly SummaryAgent[]): string {
  const count = (predicate: (agent: SummaryAgent) => boolean) => agents.filter(predicate).length;
  const parts: [number, string][] = [
    [count(isWorking), 'working'],
    [count((a) => a.state === 'waiting' && a.confidence === 'reported'), 'needs you'],
    [count((a) => a.state === 'waiting' && a.confidence === 'inferred'), 'may need you'],
    [count(isReadyToReview), 'ready to review'],
    [count(hasActionableError), 'with an error'],
  ];
  return dotJoin(parts.map(([n, label]) => n > 0 && `${int(n)} ${label}`));
}

/** What the quiet state's drawing says on its own sign and note (decorative: the footnote `HQ_COPY.quiet` is the statement). */
export const AFK_COPY = {
  sign: 'AFK',
  /** One word a line, on the sticky note. */
  note: ['back', 'soon'],
} as const;

/** The scene's own words (the roster stays the full account; see `stateWords`). */
export const SCENE_COPY = {
  heading: 'HQ, today',
  solo: 'solo',
  /** On the sign of a room of one whose parent is not on the roster (the roster's longer line is `HQ_COPY.parentAway`). */
  parentAway: 'parent away',
  captain: (helpers: number) => `captain + ${int(helpers)}`,
  idle: (since: string) => `idle ${since}`,
  bench: (helpers: number) => `+${int(helpers)}`,
} as const;

const SCENE_WORKING: Record<HqActivity, string> = {
  thinking: 'thinking',
  responding: 'replying',
  reading: 'reading',
  editing: 'editing',
  command: 'running',
  delegating: 'delegating',
  planning: 'planning',
  tool: 'using a tool',
  none: 'working',
};

/**
 * The short state under a character in the scene: lowercase, a word or two, so six fit along one floor. A waiting state that was only
 * inferred ends in a question mark, as the roster says it "may be waiting".
 */
export function sceneCaption(
  agent: Pick<
    HqAgent,
    'state' | 'activity' | 'confidence' | 'reviewPending' | 'backgroundWorkActive'
  >,
): string {
  if (isReadyToReview(agent)) return 'review';
  if ((agent.state === 'idle' || agent.state === 'finished') && agent.backgroundWorkActive) {
    return 'working';
  }
  switch (agent.state) {
    case 'starting':
      return 'starting';
    case 'working':
      return SCENE_WORKING[agent.activity];
    case 'waiting':
      return agent.confidence === 'inferred' ? 'needs you?' : 'needs you';
    case 'idle':
      return 'idle';
    case 'error':
      return 'error';
    case 'finished':
      return 'done';
  }
}
