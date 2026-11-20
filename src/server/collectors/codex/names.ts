import { isRecord } from '../chatgpt/parse.ts';
import type { RpcSession } from '../chatgpt/rpc.ts';
import type { Db } from '../../db/open.ts';
import {
  applyCodexThreadNames,
  type CodexThreadName,
  type ThreadNameResult,
} from '../../db/queries/accounts.ts';

// Codex session names (data-and-sources › Codex local rollouts › Titles and kinds). The rollout files carry no title, so the names
// come from the app-server's `thread/list`, asked on the same child the ChatGPT read uses.
//
// What is kept: a thread's id (it is the Codex session id) and its `name`. Nothing else of a thread is read. `preview` is the
// first user message, which is conversation text, so it is never copied out of the answer, never logged and never stored (P-31);
// the parser below does not name the field at all, so there is nothing to forget to drop.
//
// Names are applied by `applyCodexThreadNames` (db/queries/accounts.ts): the provider's name replaces a name Paseo gave, and the
// Paseo join never takes it back. A thread whose id is no stored session is skipped, and a thread with no name leaves its session
// as it is.

/** The most threads one `thread/list` page is asked for. */
export const THREAD_PAGE_SIZE = 100;
/** The most pages read for one of the two lists (live, archived): 5,000 threads each, far beyond a personal history. */
export const MAX_THREAD_PAGES = 50;

interface ThreadPage {
  threads: CodexThreadName[];
  nextCursor: string | null;
}

/** From `thread/list`'s result: the id and name of each thread, and the cursor for the next page (null at the end). */
export function parseThreadPage(result: unknown): ThreadPage | null {
  if (!isRecord(result)) return null;
  const data = result['data'];
  if (!Array.isArray(data)) return null;
  const threads: CodexThreadName[] = [];
  for (const thread of data) {
    if (!isRecord(thread)) continue;
    const id = thread['id'];
    const name = thread['name'];
    // A thread nobody named has nothing to store; it is not carried further.
    if (typeof id === 'string' && id !== '' && typeof name === 'string' && name !== '') {
      threads.push({ threadId: id, name });
    }
  }
  const cursor = result['nextCursor'];
  return { threads, nextCursor: typeof cursor === 'string' && cursor !== '' ? cursor : null };
}

export interface ThreadNames {
  /** The named threads read, live ones first. */
  threads: CodexThreadName[];
  /** False when a page was not answered or a list was longer than the page cap: the names read are still valid. */
  complete: boolean;
}

/**
 * Reads every thread's name: the live list and the archived one, each paged until the app-server says there is no more. A page
 * that is not answered ends that list (and says so with `complete: false`); the names read before it are kept.
 */
export async function readThreadNames(session: RpcSession): Promise<ThreadNames> {
  const threads: CodexThreadName[] = [];
  let complete = true;
  for (const archived of [false, true]) {
    let cursor: string | null = null;
    const seen = new Set<string>();
    let answered = true;
    for (let page = 0; ; page++) {
      if (page >= MAX_THREAD_PAGES) {
        complete = false;
        break;
      }
      const reply = await session.call('thread/list', {
        ...(cursor === null ? {} : { cursor }),
        limit: THREAD_PAGE_SIZE,
        sourceKinds: [],
        archived,
      });
      const parsed = reply.kind === 'result' ? parseThreadPage(reply.result) : null;
      if (parsed === null) {
        complete = false;
        answered = false;
        break;
      }
      threads.push(...parsed.threads);
      // A cursor the app-server repeats would never end: stop rather than read the same page again.
      if (parsed.nextCursor === null || seen.has(parsed.nextCursor)) break;
      seen.add(parsed.nextCursor);
      cursor = parsed.nextCursor;
    }
    // A list that was not answered means the child is not answering; the other list would only wait out another timeout.
    if (!answered) break;
  }
  return { threads, complete };
}

/** Writes the names to their sessions, in one transaction. Only a thread name is stored: no preview, no id but the session's own. */
export function applyThreadNames(db: Db, names: ThreadNames): ThreadNameResult {
  return applyCodexThreadNames(db, names.threads);
}
