import { inTransaction, type Db } from '../open.ts';
import { getMeta, setMeta } from './meta.ts';

// First-launch setup state (TECH › J1 Set up coverage; local-api › POST /api/setup/complete). Two app_meta keys, nothing new in the
// schema: `setup_completed_at` (epoch ms, as the seeded world also writes it) and `report_timezone`, which setup stores and boot
// re-reads. This file is the only place SQL for it lives; the setup service decides what to do with the answer.

const COMPLETED_AT = 'setup_completed_at';
const TIMEZONE = 'report_timezone';

export interface SetupState {
  /** True once Finish has been pressed (or the world was seeded as finished). Skipping every step still counts. */
  complete: boolean;
  /** When setup finished (epoch ms), or null when it has not, or when the stored value is not a time (a seeded world wrote one). */
  completedAt: number | null;
}

export function readSetupState(db: Db): SetupState {
  const stored = getMeta(db, COMPLETED_AT);
  if (stored === null) return { complete: false, completedAt: null };
  const at = Number(stored);
  return { complete: true, completedAt: Number.isSafeInteger(at) && at > 0 ? at : null };
}

export interface CompleteSetupInput {
  /** The app clock now, epoch ms. */
  at: number;
  /** The machine's IANA zone: reports are bucketed in it (TECH › Critical logic). */
  timezone: string;
}

/**
 * Marks setup done and stores the report timezone, in one transaction: either both are written or neither is. Setup is allowed with
 * zero sources and zero repos (P-40, P-44), so nothing else is required.
 *
 * Only the first completion moves the date. A repeat (a second tab, a double click) changes nothing and says so, so the caller
 * starts the first refresh run once and not again; the timezone is still brought up to date, because it is the machine's own.
 */
export function completeSetup(db: Db, input: CompleteSetupInput): { firstTime: boolean } {
  return inTransaction(db, () => {
    const firstTime = getMeta(db, COMPLETED_AT) === null;
    if (firstTime) setMeta(db, COMPLETED_AT, String(input.at));
    setMeta(db, TIMEZONE, input.timezone);
    return { firstTime };
  });
}
