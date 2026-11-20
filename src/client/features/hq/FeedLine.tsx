import { Link } from 'react-router';
import type { HqFeed } from '../../../shared/contracts/hq';
import { StatusTag, type StatusKind } from '../../components/StatusTag';
import { SOURCES_COPY, STATUS_TEXT } from '../../lib/copy';
import { HQ_COPY, feedName } from './copy';

// One line about a feed that is not delivering: its name, its state as a tag (icon and words), and what to do about it. A live
// feed has no line. Paseo's two unusable states reuse the words the Sources screen uses for them (lib/copy), and so does a Claude
// Code or Codex feed that finds nothing on this machine.

interface Words {
  kind: StatusKind;
  tag: string;
  detail?: string;
}

function wordsFor(feed: HqFeed): Words | null {
  switch (feed.status) {
    case 'live':
    case 'setup_incomplete': // the page's own line, with its link
      return null;
    case 'notrunning':
      return {
        kind: 'notfound',
        tag: STATUS_TEXT.notRunning,
        detail: SOURCES_COPY.local.paseoNotRunning,
      };
    case 'needspassword':
      return {
        kind: 'denied',
        tag: STATUS_TEXT.needsPassword,
        detail: SOURCES_COPY.local.paseoPassword,
      };
    case 'starting':
      return { kind: 'checking', tag: HQ_COPY.feed.starting };
    case 'notfound':
      return {
        kind: 'notfound',
        tag: HQ_COPY.feed.notFound,
        ...(feed.id === 'paseo' ? {} : { detail: SOURCES_COPY.local.notFound }),
      };
    case 'denied':
      return {
        kind: 'denied',
        tag: HQ_COPY.feed.denied,
        ...(feed.id === 'paseo' ? {} : { detail: HQ_COPY.feed.deniedDetail(feedName(feed)) }),
      };
    case 'failed':
      return {
        kind: 'failed',
        tag: HQ_COPY.feed.failed,
        ...(feed.id === 'paseo' ? {} : { detail: HQ_COPY.feed.failedDetail(feedName(feed)) }),
      };
    case 'unavailable':
      return { kind: 'none', tag: HQ_COPY.feed.unavailable };
  }
}

export function FeedLine({ feed }: { feed: HqFeed }) {
  const words = wordsFor(feed);
  if (!words) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-ink-muted">
      <b className="font-bold text-ink">{feedName(feed)}</b>
      <StatusTag kind={words.kind}>{words.tag}</StatusTag>
      {words.detail && <span className="min-w-0">{words.detail}</span>}
    </p>
  );
}

/** Setup has not been finished, so no feed has started: one line with the way forward. */
export function SetupLine() {
  const copy = HQ_COPY.setupIncomplete;
  return (
    <p className="text-copy text-ink-muted">
      {copy.before}
      <Link to="/setup" className="font-semibold">
        {copy.link}
      </Link>
    </p>
  );
}
