import type { ClaudeTokens, CodexTokens, Provider } from '../../../src/shared/domain/tokens.ts';

// The fixture world before it is written to SQLite. It follows the prototype's data.js (design D3/D4), which uses
// calendar dates and local times in America/Los_Angeles; the writer turns them into UTC epoch milliseconds.

export type Role = 'root' | 'child' | 'unknown';
export type SessionKind = 'standalone' | 'native' | 'paseo';
export type LinkClass = 'evidence' | 'suggested' | 'owner';

export interface WorldSession {
  /** 's12' (generated) or 'c3' (curated showcase record). */
  key: string;
  provider: Provider;
  /** Local calendar date and `HH:MM` of the first event. */
  date: string;
  time: string;
  model: string;
  repo: string | null;
  role: Role;
  parentKey: string | null;
  kind: SessionKind;
  paseo: { agent: string; workspace: string } | null;
  /** The prototype's shortened id, e.g. `thread 7f3a…2c91`. */
  ref: string;
  tokens: (CodexTokens | ClaudeTokens) & { total: number };
  /** How many usage events the session's tokens are split into. */
  events: number;
}

export interface WorldLink {
  sessionKey: string;
  cls: LinkClass;
  basis: string;
}

export interface WorldPr {
  repo: string;
  number: number;
  title: string;
  date: string;
  time: string;
  author: string;
  mergedBy: string;
  links: WorldLink[];
}

export interface WorldRepo {
  id: string;
  tracking: 'active' | 'stopped';
  access: 'ok' | 'inaccessible';
  accessError?: string;
}

export interface World {
  today: string;
  timezone: string;
  lookbackStart: string;
  me: string;
  codexFrom: string;
  claudeFrom: string;
  paseoFrom: string;
  repos: WorldRepo[];
  sessions: WorldSession[];
  prs: WorldPr[];
  /** Account-reported ChatGPT usage over a window (fixture), broader than this machine. */
  chatgptWindow: { start: string; end: string; total: number };
}
