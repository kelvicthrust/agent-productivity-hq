import { Button } from '@astryxdesign/core/Button';
import type { ReactNode } from 'react';
import type { SourceStatus } from '../../../shared/contracts/sources';
import { formatDayLong } from '../../../shared/domain/periods';
import { Icon } from '../../components/Icon';
import { useRefresh, useServerRun, useSources } from '../../components/RefreshBanner';
import { StatusTag } from '../../components/StatusTag';
import { useBootstrap } from '../../lib/bootstrap';
import { REFRESH_COPY, SOURCES_COPY, STATUS_TEXT } from '../../lib/copy';
import { formatWhen, upperFirst } from '../../lib/format';
import { sourceRefreshFailed, sourceTag } from '../../lib/sourceStatus';

// "On this machine": one row for each local source (Codex, Claude Code, Paseo) with what it found, when it last worked and
// the button that checks again. The same attempt line the failed-refresh banner shows ("failed" the first time in a row,
// "failed again" after) comes from `REFRESH_COPY.failedAttempt`, so the two never disagree.

/** What the primary button is called, and whether it is the row's one prominent action. */
function actionFor(source: SourceStatus): { label: string; primary: boolean } {
  if (source.status === 'denied' || source.status === 'failed' || source.status === 'needspassword')
    return { label: REFRESH_COPY.retry, primary: true };
  if (source.status === 'notfound' || source.status === 'notrunning')
    return { label: REFRESH_COPY.checkAgain, primary: false };
  return { label: REFRESH_COPY.refresh, primary: false };
}

function Detail({ children, tone }: { children: ReactNode; tone?: 'error' }) {
  return <span className={tone === 'error' ? 'text-danger' : undefined}>{children}</span>;
}

function SourceRow({
  source,
  today,
  timeZone,
  entry,
}: {
  source: SourceStatus;
  today: string;
  timeZone: string;
  /** This source's part of the run the server has going, if any. */
  entry: RunEntry | undefined;
}) {
  const { refresh, isRefreshing, isBusy: tabBusy } = useRefresh();
  const inServerRun = entry?.state === 'queued' || entry?.state === 'running';
  const busy = isRefreshing(source.id) || inServerRun;
  // The first full import says how far it has got (one sentence from the run: "Importing 42 of 380 files"). Visible text only:
  // the status tag announces that the source is refreshing and when it stops; a figure that changes every second would not be read.
  const progress = entry?.state === 'running' && entry.message ? entry.message : null;
  const isBusy = tabBusy || inServerRun;
  const refreshFailed = sourceRefreshFailed(source);
  const tag = busy
    ? { kind: 'checking' as const, text: STATUS_TEXT.refreshing }
    : sourceTag(source.status, source.unreadable, refreshFailed);
  const action = actionFor(source);
  const when = (instant: string): string => formatWhen(instant, { timeZone, today });

  const paseoUnavailable = source.status === 'notrunning' || source.status === 'needspassword';
  const retained = source.hasRetainedData === true;
  const lastSuccess = source.lastSuccessAt ? upperFirst(when(source.lastSuccessAt)) : '—';
  let attempt: string | null = null;
  if (source.lastAttemptAt && source.lastAttemptResult) {
    const time = when(source.lastAttemptAt);
    switch (source.lastAttemptResult) {
      case 'failed':
        attempt = REFRESH_COPY.failedAttempt(source.consecutiveFailures ?? 1, time);
        break;
      case 'partial':
        attempt = `${REFRESH_COPY.attemptPartial} ${time}`;
        break;
      case 'succeeded':
        attempt = `${REFRESH_COPY.attemptSucceeded} ${time}`;
        break;
    }
  }

  return (
    <li className="grid grid-cols-[minmax(160px,220px)_minmax(0,1fr)_auto] items-start gap-x-6 gap-y-2 border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0 max-[719px]:grid-cols-1">
      <div className="flex flex-col gap-1">
        <b className="text-copy font-bold text-ink">{source.name}</b>
        {/* Polite: "Refreshing…" arriving and leaving is announced where it happens. */}
        <span aria-live="polite">
          <StatusTag kind={tag.kind}>{tag.text}</StatusTag>
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-1 text-caption text-ink-muted">
        {source.status === 'notfound' ? (
          <Detail>{SOURCES_COPY.local.notFound}</Detail>
        ) : paseoUnavailable ? (
          <Detail>
            {source.status === 'needspassword'
              ? SOURCES_COPY.local.paseoPassword
              : SOURCES_COPY.local.paseoNotRunning}
            {retained ? ` ${SOURCES_COPY.local.paseoSnapshot}` : ''}
          </Detail>
        ) : source.location ? (
          <Detail>
            {SOURCES_COPY.local.location}{' '}
            {/* A path has no spaces to break at: on a narrow window it wraps anywhere instead of widening the page. */}
            <span className="font-mono text-ink [overflow-wrap:anywhere]">{source.location}</span> ·{' '}
            {SOURCES_COPY.local.foundAutomatically}
          </Detail>
        ) : null}
        {progress && <Detail>{progress}</Detail>}
        {retained && source.oldestDate && (
          <Detail>
            {SOURCES_COPY.local.historyFrom(formatDayLong(source.oldestDate), source.sessions)}
          </Detail>
        )}
        <Detail>
          {REFRESH_COPY.lastSuccess(lastSuccess)}
          {attempt && ` · ${REFRESH_COPY.latestAttempt(attempt)}`}
        </Detail>
        {source.message && (
          <Detail tone={refreshFailed ? 'error' : undefined}>{source.message}</Detail>
        )}
        {source.retentionNote && <Detail>{source.retentionNote}</Detail>}
      </div>
      <div className="flex flex-wrap justify-end gap-2 max-[719px]:justify-start">
        {/* aria-disabled rather than `disabled`, as in the banner: the button keeps focus while the run goes. A Retry says
            "Retrying…" for as long as a run covers its source, however the run was started (this button, the banner's Retry
            or Refresh all); the other actions keep their label, because the status tag already says "Refreshing…". */}
        <Button
          label={busy && action.primary ? REFRESH_COPY.retrying : action.label}
          icon={<Icon name="refresh" />}
          size="sm"
          variant={action.primary ? 'primary' : 'secondary'}
          aria-busy={busy || undefined}
          aria-disabled={isBusy || undefined}
          className="max-[719px]:min-h-11 aria-disabled:cursor-default aria-disabled:opacity-70"
          onClick={() => refresh([source.id])}
        />
      </div>
    </li>
  );
}

type RunEntry = NonNullable<ReturnType<typeof useServerRun>>['sources'][string];

export function LocalSources() {
  const sources = useSources();
  const serverRun = useServerRun();
  const bootstrap = useBootstrap().data;
  // The GitHub sync has a row of its own (banner, Retry, issue count) but is listed under GitHub, not under this machine.
  const rows = (sources.data?.sources ?? []).filter((source) => source.id !== 'github');
  return (
    <section
      aria-labelledby="src-local-title"
      className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4 shadow-card"
    >
      <div className="min-w-0">
        <h2 id="src-local-title" className="font-display text-title-section text-ink">
          {SOURCES_COPY.local.title}
        </h2>
        <p className="mt-0.5 text-caption text-ink-muted">{SOURCES_COPY.local.scope}</p>
      </div>
      {sources.isError ? (
        <p role="alert" className="text-copy text-danger">
          {COPY.loadFailed}
        </p>
      ) : !sources.data || !bootstrap ? (
        <p role="status" className="text-copy text-ink-muted">
          {COPY.loading}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-copy text-ink-muted">{COPY.nothingChecked}</p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((source) => (
            <SourceRow
              key={source.id}
              source={source}
              today={bootstrap.today}
              timeZone={bootstrap.timezone}
              entry={serverRun?.sources[source.id]}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

// Words the design has no line for: the section before its first answer, a failed read, and a machine nothing has checked yet.
const COPY = {
  loading: 'Looking at your sources…',
  loadFailed: 'Couldn’t load your sources. Reload the page to try again.',
  nothingChecked:
    'Nothing has been checked yet. Use Refresh all to look for records on this machine.',
} as const;
