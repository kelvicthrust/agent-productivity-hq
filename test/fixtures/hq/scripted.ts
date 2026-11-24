import type { HqAgent, HqFeed, HqRoster } from '../../../src/shared/contracts/hq.ts';
import type { HqService } from '../../../src/server/services/hq/service.ts';

// A scripted HQ roster: an `HqService` whose roster a test replaces between polls, so the page and the route can be exercised with
// agents on a machine that runs none. Nothing is read from this computer. The example rosters are built from a clock (epoch ms) so
// "idle for 12 min" means 12 minutes before the app's own clock.

export interface ScriptedHq extends HqService {
  /** Replaces the roster the next snapshot answers with. */
  set(next: HqRoster): void;
  /** How many snapshots have been taken, so a test can tell a poll happened. */
  readonly snapshots: number;
  /** Whether `close()` has been called. */
  readonly closed: boolean;
}

export function createScriptedHq(initial: HqRoster): ScriptedHq {
  let roster = initial;
  let snapshots = 0;
  let closed = false;
  return {
    set: (next) => {
      roster = next;
    },
    get snapshots() {
      return snapshots;
    },
    get closed() {
      return closed;
    },
    snapshot: async () => {
      snapshots += 1;
      return structuredClone(roster);
    },
    close: async () => {
      closed = true;
    },
  };
}

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** Every live feed delivering. */
export const liveFeeds = (): HqFeed[] => [
  { id: 'paseo', status: 'live' },
  { id: 'claude', status: 'live' },
  { id: 'codex', status: 'live' },
];

interface AgentSpec extends Partial<HqAgent> {
  id: string;
  provider: HqAgent['provider'];
  /** Minutes before the clock the agent started and its state last changed (default: 30 and 5). */
  startedMinutesAgo?: number;
  sinceMinutesAgo?: number;
}

/** An agent with working/editing defaults; `nowMs` is the clock the minutes are counted back from. */
export function agent(nowMs: number, spec: AgentSpec): HqAgent {
  const { startedMinutesAgo = 30, sinceMinutesAgo = 5, ...rest } = spec;
  return {
    kind: 'root',
    parentId: null,
    parentBasis: null,
    parentAway: false,
    title: null,
    repo: null,
    workspace: null,
    state: 'working',
    activity: 'editing',
    waitReason: null,
    confidence: 'reported',
    since: iso(nowMs - sinceMinutesAgo * MIN),
    lastActivityAt: iso(nowMs - Math.min(sinceMinutesAgo, 1) * MIN),
    startedAt: iso(nowMs - startedMinutesAgo * MIN),
    seenBy: { paseo: true, transcript: false },
    ...rest,
  };
}

/** Four sessions, eight agents: the example office. Sorted by `buildSessions`: the waiting session first. */
export function officeAgents(nowMs: number): HqAgent[] {
  const repo = 'kelvin/agent-productivity';
  return [
    agent(nowMs, {
      id: 'hq-build',
      provider: 'claude',
      title: 'Build the HQ page',
      repo,
      startedMinutesAgo: 40,
    }),
    agent(nowMs, {
      id: 'hq-build-review',
      provider: 'codex',
      kind: 'child',
      parentId: 'hq-build',
      parentBasis: 'paseo',
      title: 'Review the API contract',
      repo,
      activity: 'reading',
      startedMinutesAgo: 30,
    }),
    agent(nowMs, {
      id: 'hq-build-checks',
      provider: 'claude',
      kind: 'child',
      parentId: 'hq-build',
      parentBasis: 'native',
      title: 'Run the checks',
      repo,
      activity: 'command',
      startedMinutesAgo: 20,
      seenBy: { paseo: true, transcript: true },
    }),
    agent(nowMs, {
      id: 'hq-build-plan',
      provider: 'claude',
      kind: 'child',
      parentId: 'hq-build',
      parentBasis: 'native',
      title: 'Plan the roster states',
      repo,
      activity: 'thinking',
      startedMinutesAgo: 10,
      seenBy: { paseo: true, transcript: true },
    }),
    agent(nowMs, {
      id: 'hq-sync',
      provider: 'codex',
      title: 'Sync shared instructions',
      repo: 'kelvin/agent-toolkit',
      state: 'waiting',
      activity: 'none',
      waitReason: 'permission',
      startedMinutesAgo: 25,
      sinceMinutesAgo: 2,
    }),
    agent(nowMs, {
      id: 'hq-sync-compare',
      provider: 'codex',
      kind: 'child',
      parentId: 'hq-sync',
      parentBasis: 'paseo',
      title: 'Compare the two copies',
      repo: 'kelvin/agent-toolkit',
      activity: 'reading',
      startedMinutesAgo: 20,
    }),
    agent(nowMs, {
      id: 'hq-solo-claude',
      provider: 'claude',
      title: 'Fix the flaky checkout test',
      repo: 'kelvin/atlas-api',
      startedMinutesAgo: 15,
      seenBy: { paseo: false, transcript: true },
    }),
    agent(nowMs, {
      id: 'hq-solo-codex',
      provider: 'codex',
      workspace: 'scratch',
      state: 'idle',
      activity: 'none',
      startedMinutesAgo: 90,
      sinceMinutesAgo: 12,
    }),
  ];
}

/** The example office: all feeds live, four sessions, eight agents. */
export function officeRoster(nowMs: number): HqRoster {
  return {
    generatedAt: iso(nowMs),
    feeds: liveFeeds(),
    agents: officeAgents(nowMs),
    truncated: false,
  };
}

/** All feeds live and nobody running. */
export function emptyRoster(nowMs: number): HqRoster {
  return { generatedAt: iso(nowMs), feeds: liveFeeds(), agents: [], truncated: false };
}

/** The same focused and recent sessions for the browser and Paseo views. */
export function idleReviewRoster(nowMs: number): HqRoster {
  return {
    ...emptyRoster(nowMs),
    agents: [
      agent(nowMs, {
        id: 'review',
        provider: 'codex',
        title: 'Review shipped work',
        state: 'finished',
        activity: 'none',
        sinceMinutesAgo: 45,
        lastActivityAt: iso(nowMs - 45 * MIN),
        reviewPending: true,
      }),
      agent(nowMs, {
        id: 'background',
        provider: 'claude',
        title: 'Background checks',
        state: 'idle',
        activity: 'none',
        backgroundWorkActive: true,
      }),
      agent(nowMs, {
        id: 'older',
        provider: 'codex',
        title: 'Older imported thread',
        state: 'idle',
        activity: 'none',
        lastActivityAt: iso(nowMs - 12 * MIN),
      }),
      agent(nowMs, {
        id: 'recent',
        provider: 'claude',
        title: 'Recently acknowledged',
        state: 'idle',
        activity: 'none',
        lastActivityAt: iso(nowMs - 3 * MIN),
      }),
      agent(nowMs, {
        id: 'empty',
        provider: 'codex',
        title: 'Opened by accident',
        state: 'idle',
        activity: 'none',
        confirmedEmpty: true,
      }),
    ],
  };
}

/** Paseo not running; the transcript feeds still see one agent. */
export function paseoDownRoster(nowMs: number): HqRoster {
  return {
    generatedAt: iso(nowMs),
    feeds: [
      { id: 'paseo', status: 'notrunning' },
      { id: 'claude', status: 'live' },
      { id: 'codex', status: 'live' },
    ],
    agents: [
      agent(nowMs, {
        id: 'hq-solo-claude',
        provider: 'claude',
        title: 'Fix the flaky checkout test',
        repo: 'kelvin/atlas-api',
        confidence: 'inferred',
        seenBy: { paseo: false, transcript: true },
      }),
    ],
    truncated: false,
  };
}

export type HqScenario = 'office' | 'empty' | 'paseo-down' | 'idle-review';

/** The example roster named by an e2e world's `hq` option. */
export function rosterFor(scenario: HqScenario, nowMs: number): HqRoster {
  switch (scenario) {
    case 'office':
      return officeRoster(nowMs);
    case 'empty':
      return emptyRoster(nowMs);
    case 'paseo-down':
      return paseoDownRoster(nowMs);
    case 'idle-review':
      return idleReviewRoster(nowMs);
  }
}
