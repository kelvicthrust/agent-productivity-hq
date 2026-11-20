import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  RefreshRun,
  SetupDiscoverResponse,
  type SourceStatus,
} from '../../shared/contracts/sources';
import { apiSend } from './api';
import { invalidateServerState, queryKeys } from './queryClient';
import { sourceTag } from './sourceStatus';

// Server state for first-launch Setup (TECH › J1 Set up coverage; local-api › POST /api/setup/discover and /complete).
// The Setup screen and the shell (which sends a first launch to /setup) both need it, and features may not import one another,
// so the requests and hooks live here.
//
// What the screen may rely on:
//   - Discovery only LOOKS: it checks the documented default folders and override variables, the Paseo daemon and whether `codex`
//     is on the PATH, answers what it found, and imports nothing. It writes no usage and never asks for a path (P-39, P-40, P-43).
//     The words for what it found are the ones Sources already uses, plus "Looking…" while the request is in flight.
//   - Finish ("Complete") marks setup done and starts the first full refresh; it is allowed with nothing connected and nothing
//     tracked (P-40, P-44). The answer is the run that was started, so the page can land on Overview, which shows skeletons and
//     the sources' "Importing…" until that run ends.
//   - Nothing is optimistic. The shell sends the owner to /setup while the server says setup is not complete, so Finish waits
//     until the server has answered AND the bootstrap has been read again: landing on Overview before that would bounce the owner
//     straight back to Setup.

export type Discovery = z.infer<typeof SetupDiscoverResponse>;
export type FirstRun = z.infer<typeof RefreshRun>;

export const SETUP_PATH_DISCOVER = '/api/setup/discover';
export const SETUP_PATH_COMPLETE = '/api/setup/complete';

export const discoverSetup = (): Promise<Discovery> =>
  apiSend('POST', SETUP_PATH_DISCOVER, SetupDiscoverResponse, {});

export const completeSetup = (): Promise<FirstRun> =>
  apiSend('POST', SETUP_PATH_COMPLETE, RefreshRun, {});

export const resetSetup = (): Promise<void> =>
  apiSend('POST', '/api/setup/reset', null, { confirmed: true });

/** Reads the sources, the issue count and every number again. */
const refresh = (client: ReturnType<typeof useQueryClient>): Promise<void> =>
  invalidateServerState(client).catch(() => undefined);

/**
 * Looks at this computer again. Nothing is shown as found before the server answers (`isPending` is the "Looking…" state). What
 * discovery recorded on the sources' rows changes the sources and the issue count, so they are read again, but not awaited: the
 * rows on the page come from this answer.
 */
export function useSetupDiscovery() {
  const client = useQueryClient();
  return useMutation<Discovery, unknown, void>({
    mutationFn: discoverSetup,
    onSuccess: () => void refresh(client),
  });
}

/**
 * Finishes setup. The mutation settles only after the bootstrap has been read again, so when the caller navigates to Overview
 * the shell already knows setup is complete. A refusal (the server could not save it) changes nothing and setup stays open.
 */
export function useCompleteSetup() {
  const client = useQueryClient();
  return useMutation<FirstRun, unknown, void>({
    mutationFn: completeSetup,
    // Setup draws no app-bar chip or Refresh button, so nothing on the page watches the bootstrap, and invalidating a query that has no
    // watcher only marks it stale: the shell would then mount with the old answer (setup not complete) and send the owner straight
    // back. Reading it again here, watched or not, is what makes "settles after the bootstrap is read again" true.
    onSuccess: async () => {
      await refresh(client);
      await client
        .refetchQueries({ queryKey: queryKeys.bootstrap, type: 'all' })
        .catch(() => undefined);
    },
  });
}

/** Partly readable history counts as Found at discovery. The row explains what can be imported. */
export function discoveryTag(status: SourceStatus['status'] | undefined, refreshFailed = false) {
  return sourceTag(status === 'partial' ? 'ok' : status, undefined, refreshFailed);
}
