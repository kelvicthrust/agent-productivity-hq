import type { Db } from '../../db/open.ts';
import { getMeta, setMeta } from '../../db/queries/meta.ts';

// What the last look at Codex found, kept so the ChatGPT card can be answered from stored rows and never has to start `codex` to
// say who is signed in (Sources polls its status; a program per poll would be wrong). The reads and the sign-in write it; services
// /accounts.ts reads it. It is one word and a time in `app_meta`: no e-mail address, plan, account id or sentence from the
// provider.

export type Observed =
  /** Codex is signed in with ChatGPT and the account was read. */
  | 'ok'
  /** Codex answered and has no account. */
  | 'signed_out'
  /** Codex has an account that reports no usage here (an API key, Bedrock, ...). */
  | 'unsupported'
  /** There is no `codex` on this machine. */
  | 'no_codex'
  /** Codex answered with something that sounds like an expired or refused sign-in. */
  | 'reconnect'
  /** The last read did not complete (no answer, the child ended, an error). The last report stays. */
  | 'failed';

const STATE_KEY = 'chatgpt_observed';
const AT_KEY = 'chatgpt_observed_at';
const STATES: readonly Observed[] = [
  'ok',
  'signed_out',
  'unsupported',
  'no_codex',
  'reconnect',
  'failed',
];

export function recordObserved(db: Db, state: Observed, at: number): void {
  setMeta(db, STATE_KEY, state);
  setMeta(db, AT_KEY, String(at));
}

/** The last observation and when it was made (epoch ms), or null when Codex has never been looked at. */
export function readObserved(db: Db): { state: Observed; at: number } | null {
  const state = STATES.find((known) => known === getMeta(db, STATE_KEY));
  if (state === undefined) return null;
  const at = Number(getMeta(db, AT_KEY));
  return { state, at: Number.isSafeInteger(at) && at > 0 ? at : 0 };
}
