import { useQuery } from '@tanstack/react-query';
import { BootstrapResponse } from '../../shared/contracts/bootstrap';
import { apiGet } from './api';
import { queryKeys } from './queryClient';

/** What the shell needs to start: today in the report timezone, the lookback, setup state and what needs attention. */
export function useBootstrap() {
  return useQuery({
    queryKey: queryKeys.bootstrap,
    queryFn: ({ signal }) => apiGet('/api/bootstrap', BootstrapResponse, { signal }),
  });
}

/** The number of things that need attention, or null while it is not known (loading or the app was not reachable). */
export function useIssueCount(): number | null {
  const { data } = useBootstrap();
  return data ? data.issues.length : null;
}
