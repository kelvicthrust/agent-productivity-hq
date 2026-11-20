import { useSources } from '../../../components/RefreshBanner';
import { ApiRequestError } from '../../../lib/api';
import type { Account } from '../../../lib/accounts';

// Where the accounts section reads. The two cards are server state: `GET /api/sources` `accounts` (the one query the whole Sources
// page shares). Every write in lib/accounts reads it again once the server has answered, so nothing here keeps a copy and nothing
// shows as done before the server says so.

/** The ChatGPT and Claude cards, from the sources query the page already holds. GitHub has its own section. */
export function useAccounts() {
  const sources = useSources();
  const find = (id: Account['id']): Account | undefined =>
    sources.data?.accounts?.find((account) => account.id === id);
  return { sources, chatgpt: find('chatgpt'), claude: find('claude') };
}

/** What a failed call says, in words; a call that never reached the app gets the plain fallback. */
export function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiRequestError && error.message !== '' ? error.message : fallback;
}
