import { useId, useState } from 'react';
import { describeCoverage } from '../../components/coverageGroups';
import { Icon } from '../../components/Icon';
import { useSources } from '../../components/RefreshBanner';
import { statusAppearance } from '../../components/StatusTag';
import { useBootstrap } from '../../lib/bootstrap';
import { formatWhen, upperFirst } from '../../lib/format';
import { useRepos } from '../../lib/repos';
import { sourceRefreshFailed } from '../../lib/sourceStatus';
import { lastSourceSuccess, latestSourceAttempt, usageCoverage } from '../../lib/usageCoverage';

export function SourceCoverage() {
  const [open, setOpen] = useState(false);
  const id = useId();
  const sources = useSources();
  const repos = useRepos();
  const bootstrap = useBootstrap().data;
  const data = sources.data;
  const summary =
    data && repos.data && bootstrap
      ? describeCoverage(
          { ...usageCoverage(data.sources ?? [], repos.data), accounts: data.accounts ?? [] },
          data.chatgptCoverage ? [{ account: 'chatgpt', ...data.chatgptCoverage }] : [],
          { today: bootstrap.today, timeZone: bootstrap.timezone },
        )
      : null;
  const statuses = data?.sources ?? [];
  const lastFailed = latestSourceAttempt(statuses.filter(sourceRefreshFailed));
  const lastSuccess = lastSourceSuccess(statuses);
  const laterFailure =
    lastFailed && (!lastSuccess || Date.parse(lastFailed) > Date.parse(lastSuccess)) && bootstrap
      ? formatWhen(lastFailed, { today: bootstrap.today, timeZone: bootstrap.timezone })
      : null;
  const attention = summary?.groups.some((group) =>
    group.items.some((item) =>
      ['warn', 'failed', 'denied', 'stale', 'partial', 'reconnect'].includes(item.state),
    ),
  );
  return (
    <section
      aria-label="Source coverage"
      className="min-w-0 rounded-md border border-border bg-surface p-4 shadow-card"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="hidden font-display text-title-section text-ink min-[720px]:block">
          Source coverage
        </h2>
        <button
          type="button"
          aria-controls={id}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-h-11 w-full items-center gap-2 text-left min-[720px]:hidden"
        >
          <span className="grow font-display text-title-section text-ink">Source coverage</span>
          {attention && <span className="text-caption text-warning">Needs attention</span>}
          <Icon name={open ? 'chevronDown' : 'chevronRight'} />
        </button>
        {summary && (
          <div className="flex flex-wrap gap-x-3 text-caption text-ink-muted">
            <span>{summary.refreshed ?? 'No successful refresh yet'}</span>
            {laterFailure && <span>Last failed attempt {laterFailure}</span>}
          </div>
        )}
      </header>
      <div
        id={id}
        className={`${open ? 'grid' : 'hidden'} mt-3 gap-4 border-t border-border pt-3 min-[720px]:grid min-[720px]:grid-cols-3`}
      >
        {!summary ? (
          <p role="status" className="col-span-full text-copy text-ink-muted">
            {sources.isError || repos.isError
              ? 'Couldn’t load source coverage.'
              : 'Loading source coverage…'}
          </p>
        ) : (
          summary.groups.map((group) => {
            const label = group.id === 'machine' ? 'On this machine' : group.label;
            return (
              <div key={group.id} role="group" aria-label={label} className="min-w-0">
                <h3 className="mb-2 text-label font-semibold text-ink-muted">{label}</h3>
                <dl className="grid gap-2">
                  {group.items.map((item) => {
                    const { icon, toneClass } = statusAppearance(item.state);
                    const text = item.text.startsWith('since ')
                      ? 'History ' + item.text
                      : upperFirst(item.text);
                    return (
                      <div key={item.name} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
                        <dt className="col-span-2 grid grid-cols-subgrid items-center text-copy font-semibold text-ink">
                          <span className={toneClass}>
                            <Icon name={icon} />
                          </span>
                          {item.name}
                        </dt>
                        <dd className="col-start-2 text-copy text-ink-muted">{text}</dd>
                      </div>
                    );
                  })}
                </dl>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
