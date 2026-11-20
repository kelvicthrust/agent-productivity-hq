import type { BootstrapResponse } from '../../shared/contracts/bootstrap.ts';
import { lookbackStart, todayIn } from '../../shared/domain/periods.ts';
import { readBootstrapRows } from '../db/queries/bootstrap.ts';
import type { Db } from '../db/open.ts';

const NAMES: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  paseo: 'Paseo',
  github: 'GitHub',
  chatgpt_account: 'ChatGPT',
  claude_account: 'Claude',
};

const SENTENCE: Record<string, (name: string) => string> = {
  failed: (name) => `${name} couldn’t be refreshed.`,
  denied: (name) => `Access to ${name} was denied.`,
  needspassword: (name) => `${name} needs a password. Agent Productivity HQ doesn’t use it.`,
  inaccessible: (name) => `GitHub no longer grants access to ${name}.`,
};

/** What the app shell needs to start: setup state, the report timezone and today, the lookback, and what needs attention. */
export function buildBootstrap(
  db: Db,
  options: { nowMs: number; timezone: string },
): BootstrapResponse {
  const rows = readBootstrapRows(db);
  const today = todayIn(options.nowMs, options.timezone);
  return {
    setupComplete: rows.setupComplete,
    timezone: options.timezone,
    today,
    lookbackStart: lookbackStart(today),
    githubLogin: rows.githubLogin,
    greetingName: rows.greetingName,
    issues: rows.attention.map((item) => {
      const name = item.kind === 'repo' ? item.displayName : (NAMES[item.id] ?? item.id);
      const label = (SENTENCE[item.status] ?? ((n: string) => `${n} needs attention.`))(name);
      return { kind: item.kind, id: item.id, label };
    }),
  };
}
