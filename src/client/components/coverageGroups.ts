import type { AccountReport } from '../../shared/contracts/accounts';
import type { OverviewResponse } from '../../shared/contracts/overview';
import type { AccountStatus, SourceStatus } from '../../shared/contracts/sources';
import { formatDayLong, formatRange } from '../../shared/domain/periods';
import { COVERAGE_COPY } from '../lib/copy';
import { formatWhen, type WhenOptions } from '../lib/format';
import { sourceRefreshFailed, sourceTag } from '../lib/sourceStatus';
import { lastSourceSuccess, latestSourceAttempt } from '../lib/usageCoverage';
import type { StatusKind } from './StatusTag';

// What the coverage strip says, built from the overview's `coverage` block (ported from app.js coverageStrip). The strip
// carries state only: an icon and a few words per source. The one prose explanation of a failed refresh is the banner's.

export interface CoverageItem {
  /** Picks the icon and its colour; the words in `text` carry the same state. */
  state: StatusKind;
  name: string;
  text: string;
}

export interface CoverageGroup {
  id: 'machine' | 'delivery' | 'accounts';
  label: string;
  items: CoverageItem[];
}

export interface CoverageSummary {
  groups: CoverageGroup[];
  /** Null before any successful collection. */
  refreshed: string | null;
  /** Include the latest completed attempt when its timestamp differs from the success shown. */
  attempted: string | null;
}

type CoverageData = OverviewResponse['coverage'];

const SOURCE_ORDER: readonly SourceStatus['id'][] = ['codex', 'claude', 'paseo'];
const ACCOUNT_ORDER: readonly AccountStatus['id'][] = ['chatgpt', 'claude'];

function sourceItem(source: SourceStatus): CoverageItem {
  const { name } = source;
  const tag = sourceTag(source.status, source.unreadable, sourceRefreshFailed(source));
  return {
    state: source.status === 'notrunning' && source.hasRetainedData ? 'stale' : tag.kind,
    name,
    text:
      source.status === 'ok' && source.oldestDate
        ? COVERAGE_COPY.since(formatDayLong(source.oldestDate))
        : tag.text.toLowerCase(),
  };
}

function deliveryItem(
  github: CoverageData['github'],
  source: SourceStatus | undefined,
): CoverageItem {
  const tracked = github?.tracked ?? 0;
  const inaccessible = github?.inaccessible ?? 0;
  const failed = source !== undefined && sourceRefreshFailed(source);
  const trackedText = COVERAGE_COPY.reposTracked(tracked, inaccessible);
  return {
    state: failed ? 'failed' : tracked > 0 ? (inaccessible > 0 ? 'partial' : 'ok') : 'notfound',
    name: COVERAGE_COPY.github,
    text: failed ? `${trackedText} · ${COVERAGE_COPY.refreshFailed}` : trackedText,
  };
}

type CoverageReport = Pick<AccountReport, 'account' | 'unit' | 'bucketSpan' | 'stale'>;

function accountItem(account: AccountStatus, report: CoverageReport | undefined): CoverageItem {
  const name = account.id === 'claude' ? 'Claude plan limits' : account.name;
  const text = COVERAGE_COPY;
  if (account.status === 'reconnect') return { state: 'stale', name, text: text.reconnectNeeded };
  if (account.id === 'claude') {
    const check = account.planLimits;
    report = check?.report ?? report;
    if (check && check.state !== 'unchecked' && check.state !== 'ok') {
      return { name, state: 'warn', text: account.statusText || 'Last check unsuccessful' };
    }
    if (!report && (check?.state === 'unchecked' || account.status === 'notconnected'))
      return { name, state: 'none', text: 'Not checked yet' };
    if (!report && check?.state === 'ok')
      return { name, state: 'none', text: 'No current windows' };
  }
  // The server returns whatever report is stored, connected or not: a report for an account that is not connected is history, not
  // a ticked source, and the Overview card says Not connected. (Claude's status is its plan check, which a saved snapshot answers.)
  if (
    account.id !== 'claude' &&
    (account.status === 'notconnected' || account.status === 'needsapp')
  ) {
    return { state: 'notfound', name, text: text.notConnected };
  }
  // A live sign-in state (pending, failed, unavailable) outranks a stored report for ChatGPT, as it does on the Overview card;
  // without a report it is what there is to say for either account.
  const live =
    account.status === 'failed' ||
    account.status === 'unavailable' ||
    account.status === 'connecting';
  if (live && (!report || account.id !== 'claude')) {
    return {
      name,
      state: account.status === 'failed' ? 'failed' : 'info',
      text: account.statusText ?? account.status,
    };
  }
  if (!report) {
    // An account that is connected but has no report yet is not "not connected": Sources and the account card say Connected.
    return account.status === 'connected' || account.status === 'existing'
      ? { state: 'ok', name, text: text.noReportYet }
      : { state: 'notfound', name, text: text.notConnected };
  }
  const state = report.stale ? 'stale' : 'ok';
  const suffix = report.stale ? ' · last known' : '';
  if (report.unit === 'percent') return { state, name, text: text.percentOnly + suffix };
  const span = report.bucketSpan;
  const window = span?.start && span.end ? formatRange(span.start, span.end) : null;
  return { state, name, text: text.tokensOnly(window) + suffix };
}

/**
 * The strip's groups and refresh line from `OverviewResponse.coverage` and the overview's account reports. Sources keep
 * the design's order (Codex, Claude Code, Paseo) whatever order the API returns; a source the API did not return is
 * not drawn. `options.today` and `options.timeZone` are the report date and zone from bootstrap.
 */
export function describeCoverage(
  coverage: CoverageData,
  reports: readonly CoverageReport[] = [],
  options: WhenOptions = {},
): CoverageSummary {
  const sources = SOURCE_ORDER.flatMap((id) => coverage.sources?.filter((s) => s.id === id) ?? []);
  const accounts = ACCOUNT_ORDER.flatMap(
    (id) => coverage.accounts?.filter((a) => a.id === id) ?? [],
  );
  const groups: CoverageGroup[] = [
    { id: 'machine', label: COVERAGE_COPY.groups.machine, items: sources.map(sourceItem) },
    {
      id: 'delivery',
      label: COVERAGE_COPY.groups.delivery,
      items: [
        deliveryItem(
          coverage.github,
          coverage.sources?.find((s) => s.id === 'github'),
        ),
      ],
    },
    {
      id: 'accounts',
      label: COVERAGE_COPY.groups.accounts,
      items: accounts.map((a) =>
        accountItem(
          a,
          reports.find((r) => r.account === a.id),
        ),
      ),
    },
  ];
  const lastSuccess = lastSourceSuccess(coverage.sources ?? []);
  const lastAttempt = latestSourceAttempt(coverage.sources ?? []);
  return {
    groups: groups.filter((group) => group.items.length > 0),
    refreshed: lastSuccess
      ? `${COVERAGE_COPY.lastSuccessfulRefresh} ${formatWhen(lastSuccess, options)}`
      : null,
    attempted:
      lastAttempt && lastAttempt !== lastSuccess
        ? `Latest attempt ${formatWhen(lastAttempt, options)}`
        : null,
  };
}
