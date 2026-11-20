import { CoverageStrip } from '../../components/CoverageStrip';
import { describeCoverage } from '../../components/coverageGroups';
import { useSources } from '../../components/RefreshBanner';
import { useBootstrap } from '../../lib/bootstrap';
import { useRepos } from '../../lib/repos';
import { usageCoverage } from '../../lib/usageCoverage';

// The coverage strip under the Usage heading: which local sources were found and how they are doing, the tracked repos, and
// when the last refresh worked. It reads the same two answers as Sources & repos (/api/sources, /api/repos), so a refresh
// that finishes updates it with everything else. Nothing is drawn until both have arrived, and if either cannot be read the
// strip stays out of the way: Sources & repos is where that failure is reported.

export function UsageCoverage() {
  const sources = useSources();
  const repos = useRepos();
  const bootstrap = useBootstrap().data;
  if (!sources.data || !repos.data || !bootstrap) return null;
  const summary = describeCoverage(usageCoverage(sources.data.sources ?? [], repos.data), [], {
    today: bootstrap.today,
    timeZone: bootstrap.timezone,
  });
  return <CoverageStrip {...summary} />;
}
