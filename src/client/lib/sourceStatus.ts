import type { SourceStatus } from '../../shared/contracts/sources';
import { STATUS_TEXT } from './copy';

/** A skipped or discovery-only source still has an availability state, without a new failed refresh. */
export function sourceRefreshFailed(source: SourceStatus): boolean {
  return (
    source.lastAttemptResult === 'failed' &&
    Boolean(source.lastAttemptAt) &&
    source.status !== 'notfound' &&
    source.status !== 'notrunning' &&
    source.status !== 'needspassword'
  );
}

export function sourceTag(
  status: SourceStatus['status'] | undefined,
  unreadable?: number,
  failedAttempt = true,
) {
  switch (status) {
    case 'ok':
      return { kind: 'ok', text: STATUS_TEXT.found } as const;
    case 'partial':
      return {
        kind: 'partial',
        text: unreadable ? STATUS_TEXT.partialUnreadable(unreadable) : STATUS_TEXT.partial,
      } as const;
    case 'failed':
      return {
        kind: 'failed',
        text: failedAttempt ? STATUS_TEXT.refreshFailed : STATUS_TEXT.unavailable,
      } as const;
    case 'denied':
      return { kind: 'denied', text: STATUS_TEXT.accessDenied } as const;
    case 'needspassword':
      return { kind: 'denied', text: STATUS_TEXT.needsPassword } as const;
    case 'notrunning':
      return { kind: 'notfound', text: STATUS_TEXT.notRunning } as const;
    case 'notfound':
      return { kind: 'notfound', text: STATUS_TEXT.notFound } as const;
    case 'checking':
    case undefined:
      return { kind: 'checking', text: STATUS_TEXT.looking } as const;
  }
}
