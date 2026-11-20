import type { AdapterReport } from '../types.ts';

// How an adapter reports what went wrong with a source, so Codex and Claude Code say the same things the same way and no
// message can carry file content, a prompt or a token (P-31). Only the file system's error code is ever kept from an error.

export type FsFailureKind = 'denied' | 'notfound' | 'failed';

export interface FsFailure {
  kind: FsFailureKind;
  /** The file system's code (`EACCES`, `ENOENT` …) or `unknown`. Safe to store and log. */
  code: string;
}

const CODE = /^E[A-Z0-9]{2,}$/;

/** EACCES and EPERM are Access denied; ENOENT and ENOTDIR are Not found; anything else is a failure with its code. */
export function classifyFsError(error: unknown): FsFailure {
  const raw = (error as { code?: unknown } | null)?.code;
  const code = typeof raw === 'string' && CODE.test(raw) ? raw : 'unknown';
  if (code === 'EACCES' || code === 'EPERM') return { kind: 'denied', code };
  if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'notfound', code };
  return { kind: 'failed', code };
}

/** What Sources calls each provider in a sentence. */
export const SOURCE_LABELS = { codex: 'Codex', claude: 'Claude Code' } as const;
export type LocalSourceId = keyof typeof SOURCE_LABELS;

/** Shown under a source that is not here (the design's wording, Sources › Not found). */
export const notFoundMessage = (source: LocalSourceId): string =>
  `Nothing in ${SOURCE_LABELS[source]}’s usual locations on this machine. If you use it here, run it once, then check again.`;

/** Shown under a source whose data is here but unreadable (the design's wording, Sources › Access denied). */
export const deniedMessage = (source: LocalSourceId): string =>
  `${SOURCE_LABELS[source]}’s data is here but couldn’t be read (permission denied). Allow read access, then retry.`;

/** Shown when a read failed for any other reason; the code is kept apart in `errorCode`. */
export const failedMessage = (source: LocalSourceId): string =>
  `${SOURCE_LABELS[source]}’s history couldn’t be read. Already-imported history is unaffected. Retry.`;

/** Nothing to attempt: the source is not on this machine. Nothing is recorded, so it never counts as a failed attempt. */
export function notFoundReport(source: LocalSourceId): AdapterReport {
  return { result: 'skipped', message: notFoundMessage(source) };
}

/** A real EACCES or EPERM on the source's folder: the attempt failed, the source reads Access denied, earlier data stays. */
export function deniedReport(
  source: LocalSourceId,
  location: string | null,
  extra: { code?: string } = {},
): AdapterReport {
  return {
    result: 'failed',
    status: 'denied',
    location,
    errorCode: extra.code === 'EPERM' ? 'permission_denied' : 'access_denied',
    errorDetail: deniedMessage(source),
    message: deniedMessage(source),
  };
}

/** Any other read failure. `code` is the file system's code or a short code of the adapter's own. */
export function failedReport(
  source: LocalSourceId,
  location: string | null,
  code: string,
): AdapterReport {
  return {
    result: 'failed',
    status: 'failed',
    location,
    errorCode: code.toLowerCase(),
    errorDetail: failedMessage(source),
    message: failedMessage(source),
  };
}
