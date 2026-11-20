import type { Db } from '../../db/open.ts';
import {
  oldestEventAt,
  unreadableTotals,
  unreconciledUsage,
  type EventWrite,
} from '../../db/queries/ingest.ts';
import type { UsageProvider } from '../../db/queries/usage.ts';
import type { AdapterReport } from '../types.ts';
import { SOURCE_LABELS, type LocalSourceId } from './errors.ts';

// What an import counted, and how it becomes the report the runner records. One place, so Codex and Claude Code say the same
// things in the same words: "N new sessions imported", "Partial · N unreadable", an oldest date for coverage.

export class ImportTally {
  newSessions = 0;
  eventsInserted = 0;
  eventsReplaced = 0;
  /** Events seen again and left as they were: re-imports, archive copies, replayed parents, a retried file. */
  eventsSkipped = 0;
  filesRead = 0;
  filesUnchanged = 0;

  addEvent(write: EventWrite): void {
    if (write === 'inserted') this.eventsInserted += 1;
    else if (write === 'replaced') this.eventsReplaced += 1;
    else this.eventsSkipped += 1;
  }
}

export interface ReportInput {
  source: LocalSourceId;
  db: Db;
  tally: ImportTally;
  /** Where the source was found, shown in mono (the first root that was read). */
  location: string | null;
  /** Folders or files below a readable root that could not be read this time. */
  inaccessible: number;
  adapterVersion: string;
}

const provider = (source: LocalSourceId): UsageProvider => source;

/**
 * The report for an attempt that ran: `succeeded`, or `partial` when anything could not be read. The unreadable and unsupported
 * figures come from the stored file rows, so a refresh that read nothing still reports them (Sources keeps saying
 * "Partial · 3 unreadable" until the lines are gone, not only on the refresh that met them).
 */
export function finishReport(input: ReportInput): AdapterReport {
  const totals = unreadableTotals(input.db, input.source);
  const unreadable = totals.lines + totals.files + input.inaccessible;
  const unreconciled = unreconciledUsage(input.db, input.source, input.adapterVersion);
  const partial = unreadable > 0 || totals.unsupported > 0 || unreconciled > 0;
  const noun = unreadable === 1 ? 'record' : 'records';
  const messages = [];
  if (unreadable > 0 || totals.unsupported > 0) {
    messages.push(
      `${SOURCE_LABELS[input.source]}: ${unreadable} ${noun} couldn’t be read${totals.unsupported > 0 ? ` and ${totals.unsupported} in a format that isn’t supported yet` : ''}. The rest was imported.`,
    );
  }
  if (unreconciled > 0)
    messages.push(
      `${unreconciled} previously imported usage ${unreconciled === 1 ? 'record is' : 'records are'} awaiting reconciliation. Existing totals are retained for that history.`,
    );
  return {
    result: partial ? 'partial' : 'succeeded',
    status: partial ? 'partial' : 'ok',
    imported: input.tally.newSessions,
    duplicatesSkipped: input.tally.eventsSkipped,
    unreadable,
    unsupported: totals.unsupported,
    location: input.location,
    oldestEventAt: oldestEventAt(input.db, provider(input.source)),
    adapterVersion: input.adapterVersion,
    message: partial ? messages.join(' ') : null,
  };
}
