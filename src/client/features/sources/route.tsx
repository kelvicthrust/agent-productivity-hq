import { Button } from '@astryxdesign/core/Button';
import { Icon } from '../../components/Icon';
import { PageHeader } from '../../components/PageHeader';
import { useRefresh } from '../../components/RefreshBanner';
import { REFRESH_COPY, SOURCES_COPY } from '../../lib/copy';
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
  const { refresh, isBusy: busy } = useRefresh();
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
            tooltip={REFRESH_COPY.allDescription}
            aria-busy={busy || undefined}
            aria-disabled={busy || undefined}
            className="max-[719px]:min-h-11 aria-disabled:cursor-default aria-disabled:opacity-70"
            onClick={() => refresh()}
          />
        }
      />
      <SourceCoverage />
      <LocalSources />
      <HqHooks />
      <AccountsSection />
      <TrackedRepos />
      <DataKept />
      <ResetApp />
    </div>
  );
}
