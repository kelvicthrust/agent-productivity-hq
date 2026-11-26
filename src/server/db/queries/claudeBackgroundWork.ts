import type { Db } from '../open.ts';
import { getMeta, setMeta } from './meta.ts';

const KEY = 'claude_background_work';

export function claudeBackgroundWorkPreference(db: Db) {
  return {
    read: () => getMeta(db, KEY) === '1',
    write: (enabled: boolean) => setMeta(db, KEY, enabled ? '1' : '0'),
  };
}
