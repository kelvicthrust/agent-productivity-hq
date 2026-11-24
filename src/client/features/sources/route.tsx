import { Button } from '@astryxdesign/core/Button';
import { Icon } from '../../components/Icon';
import { PageHeader } from '../../components/PageHeader';
import { PaseoQuotaCard } from '../../components/PaseoQuotaCard';
import { useRefresh } from '../../components/RefreshBanner';
import { useBootstrap } from '../../lib/bootstrap';
import { REFRESH_COPY, SOURCES_COPY } from '../../lib/copy';
import { isPaseoBrowser } from '../../lib/paseoBrowser';
import { AccountsSection } from './accounts';
import { DataKept } from './DataKept';
import { HqHooks } from './HqHooks';
import { ResetApp } from './ResetApp';
import { SourceCoverage } from './SourceCoverage';
import { LocalSources } from './LocalSources';
import { TrackedRepos } from './repos/TrackedRepos';

// Sources & repos: "On this machine" and Refresh all, then Claude Code's hooks switch for HQ, then the Accounts card (GitHub, ChatGPT and Claude) and Tracked
// repositories, followed by data retention and reset.

export function SourcesRoute() {
  const { refresh, isBusy: busy, description } = useRefresh();
  const { data: bootstrap } = useBootstrap();
  const paseoBrowser = isPaseoBrowser();
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={SOURCES_COPY.title}
        subtitle={SOURCES_COPY.subtitle}
        actions={
          // Busy is aria-disabled, as on the rows: it keeps focus, and its name changes to say what is happening.
          <Button
            label={busy ? REFRESH_COPY.refreshing : REFRESH_COPY.refreshAll}
            icon={<Icon name={busy ? 'spinner' : 'refresh'} />}
            size="sm"
            variant="secondary"
            tooltip={description}
            aria-busy={busy || undefined}
            aria-disabled={busy || undefined}
            className="max-[719px]:min-h-11 aria-disabled:cursor-default aria-disabled:opacity-70"
            onClick={() => refresh()}
          />
        }
      />
      <SourceCoverage />
      <LocalSources />
      {!paseoBrowser && <HqHooks />}
      <AccountsSection />
      {paseoBrowser && bootstrap && (
        <PaseoQuotaCard provider="claude" timeZone={bootstrap.timezone} today={bootstrap.today} />
      )}
      <TrackedRepos />
      <DataKept />
      {paseoBrowser ? (
        <a
          href="/sources"
          className="inline-flex w-fit items-center text-copy text-action underline max-[719px]:min-h-11"
        >
          Open owner settings
        </a>
      ) : (
        <ResetApp />
      )}
    </div>
  );
}
