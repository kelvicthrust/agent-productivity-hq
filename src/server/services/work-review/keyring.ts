import type { Keyring } from '../../collectors/github/ports.ts';
import type { Db } from '../../db/open.ts';
import { getMeta, setMeta } from '../../db/queries/meta.ts';

// An installation that has never started Work Review sign-in can open Overview and reset all HQ
// data without prompting for access to Keychain. The marker carries no account identity or tokens.
export function workReviewKeyring(db: Db, native: Keyring): Keyring {
  const marker = 'work_review_keychain_used';
  const used = () => getMeta(db, marker) === '1';
  return {
    get: (service, account) => (used() ? native.get(service, account) : null),
    set(service, account, secret) {
      // Mark first so a successfully stored native entry can always be found after interruption.
      if (!used()) setMeta(db, marker, '1');
      native.set(service, account, secret);
    },
    delete(service, account) {
      if (!used()) return false;
      const existed = native.delete(service, account);
      setMeta(db, marker, '0');
      return existed;
    },
  };
}
