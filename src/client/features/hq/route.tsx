import type { HqFeed } from '../../../shared/contracts/hq';
import { PageHeader } from '../../components/PageHeader';
import { useHq } from '../../lib/hq';
import { useNow } from '../../lib/useNow';
import { HQ_COPY, summaryLine } from './copy';
import { FeedLine, SetupLine } from './FeedLine';
import { HooksFirstRun } from './HooksFirstRun';
import { RecentIdle, Roster } from './Roster';
import { HqScene } from './HqScene';
import { HqLoading, HqNotice, HqQuiet, HqRequestError, HqUnavailable } from './states';
import { groupSessions } from './sessions';

// HQ: the coding agents running on this machine right now, grouped into sessions (an orchestrator and the agents it spawned).
// View-only: nothing here controls an agent, and a waiting agent is shown, never notified.
//
// State ownership (TECH): the roster is TanStack Query's (queries.ts, polled every 2 s while the tab is visible); the feature keeps
// no persisted state of its own. The roster list is the accessible account of the scene.

const allUnavailable = (feeds: readonly HqFeed[]) =>
  feeds.every((feed) => feed.status === 'unavailable');

// A quiet machine is one where at least one feed is delivering and says nobody is running, and no feed has a problem (DESIGN.md › HQ ›
// Honest states). Which states are "no problem" follows the Sources screen:
//   - `live` delivers; `unavailable` is a source that is not on in this process (nothing to go wrong).
//   - `notfound` is a provider with no data on this machine: Sources shows it as a muted "Not found" with a plain "Check again", never as a
//     failed refresh, so a machine without Codex can still be quiet. (Paseo is never `notfound`: it is `notrunning`.)
//   - `starting` is not yet known: nothing is claimed while a feed is still starting.
//   - `notrunning`, `needspassword`, `denied`, `failed` and `setup_incomplete` are problems: each has its own line (or the Setup line)
//     and none of them lets the page say the machine is quiet, because the feed that cannot look may be hiding an agent.
// "Not available" is only for a process where no feed exists at all.
const NO_PROBLEM: ReadonlySet<HqFeed['status']> = new Set(['live', 'unavailable', 'notfound']);
const isQuiet = (feeds: readonly HqFeed[]) =>
  feeds.some((feed) => feed.status === 'live') &&
  feeds.every((feed) => NO_PROBLEM.has(feed.status));

export function HqRoute() {
  const { data, isError, refetch } = useHq();
  const nowMs = useNow();

  const agents = data?.agents ?? [];
  const { focus, recentIdle } = groupSessions(agents);
  const feeds = data?.feeds ?? [];
  const nothingLive = data !== undefined && allUnavailable(feeds);
  const setupIncomplete = feeds.some((feed) => feed.status === 'setup_incomplete');

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={HQ_COPY.title} subtitle={summaryLine(agents) || undefined} />
      {/* The hooks switch lives on Sources; the first time HQ is opened with it off, it is offered once, in a dialog. It means something
          only where a feeder exists (where none does, the page already says so), and never on a roster that failed to load or in setup. */}
      <HooksFirstRun
        state={data?.exactPrompts ?? 'unavailable'}
        ready={data !== undefined && !isError && !nothingLive && !setupIncomplete}
      />
      {isError && <HqRequestError stale={data !== undefined} onRetry={() => void refetch()} />}
      {data === undefined ? (
        !isError && <HqLoading />
      ) : (
        <>
          {setupIncomplete && <SetupLine />}
          {!nothingLive &&
            feeds.some((feed) => feed.status !== 'live' && feed.status !== 'setup_incomplete') && (
              <div className="flex flex-col gap-1.5">
                {feeds.map((feed) => (
                  <FeedLine key={feed.id} feed={feed} />
                ))}
              </div>
            )}
          {data.truncated && <HqNotice tone="info">{HQ_COPY.truncated}</HqNotice>}
          {/* The illustrated scene is decorative (aria-hidden); the roster below stays the accessible account. */}
          {focus.length > 0 ? (
            <>
              <HqScene sessions={focus} nowMs={nowMs} />
              <Roster sessions={focus} nowMs={nowMs} />
            </>
          ) : nothingLive ? (
            <HqUnavailable />
          ) : !isError && isQuiet(feeds) ? (
            <HqQuiet />
          ) : (
            !setupIncomplete && <p className="text-copy text-ink-muted">{HQ_COPY.noAgents}</p>
          )}
          {recentIdle.length > 0 && <RecentIdle sessions={recentIdle} nowMs={nowMs} />}
        </>
      )}
    </div>
  );
}
