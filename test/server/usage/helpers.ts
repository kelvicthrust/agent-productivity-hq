import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { expect } from 'vitest';
import type { z } from 'zod';
import {
  apiNotFound,
  correlation,
  errorHandler,
  type HttpEnv,
} from '../../../src/server/http/errors.ts';
import { csrfGuard, hostGuard, securityHeaders } from '../../../src/server/http/guards.ts';
import { usageRoutes } from '../../../src/server/http/routes/usage.ts';
import {
  UsageCategoriesResponse,
  UsageGroupsResponse,
  UsageRootsResponse,
} from '../../../src/shared/contracts/usage.ts';
import { HOST, NOW, PORT, TZ, memoryDb, memoryLogger } from '../helpers.ts';

export { NOW, TZ, memoryDb };

/** The Usage routes alone behind the product's guards, so they are tested without the rest of createApp. */
export function usageApp(db: DatabaseSync) {
  const { logger } = memoryLogger();
  const app = new Hono<HttpEnv>();
  app.use('*', correlation());
  app.use('*', securityHeaders());
  app.use('*', hostGuard(PORT, logger));
  app.use('*', csrfGuard(logger));
  app.onError(errorHandler(logger));
  app.route('/', usageRoutes({ db, now: () => NOW, timezone: TZ }));
  app.all('/api/*', apiNotFound);
  app.notFound(apiNotFound);
  return app;
}

export type UsageApp = ReturnType<typeof usageApp>;

export async function get(app: UsageApp, path: string) {
  const res = await app.request(`http://127.0.0.1:${PORT}${path}`, { headers: HOST });
  const body = (await res.json()) as unknown;
  return { status: res.status, headers: res.headers, body };
}

/** GET and expect 200 with a body the contract accepts and carries no key the contract does not know. */
async function getParsed<T extends z.ZodType>(app: UsageApp, path: string, schema: T) {
  const { status, body } = await get(app, path);
  expect(status, JSON.stringify(body)).toBe(200);
  const parsed = schema.parse(body);
  expect(parsed).toEqual(body);
  return parsed as z.infer<T>;
}

export const categories = (app: UsageApp, query = '') =>
  getParsed(app, `/api/usage/categories${query}`, UsageCategoriesResponse);
export const groups = (app: UsageApp, query = '') =>
  getParsed(app, `/api/usage/groups${query}`, UsageGroupsResponse);
export const roots = (app: UsageApp, key: string, query = '') =>
  getParsed(app, `/api/usage/groups/${encodeURIComponent(key)}/roots${query}`, UsageRootsResponse);

// ---- a small hand-built world ----------------------------------------------------------------------------------------

/** Local calendar date and `HH:MM` to UTC epoch ms in the test zone. */
export const at = (date: string, time = '10:00'): number =>
  Temporal.PlainDateTime.from(`${date}T${time}`).toZonedDateTime(TZ).epochMilliseconds;

export interface RepoOptions {
  tracking?: 'active' | 'stopped';
  access?: 'ok' | 'inaccessible' | 'unknown';
  backfill?: boolean;
}

export function addRepo(db: DatabaseSync, id: string, options: RepoOptions = {}): void {
  db.prepare(
    `INSERT INTO repo (id, display_name, tracking_state, access_state, added_at, backfill_complete)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    id,
    options.tracking ?? 'active',
    options.access ?? 'ok',
    at('2025-11-05'),
    options.backfill === false ? 0 : 1,
  );
}

export interface SessionOptions {
  id: number;
  provider?: 'codex' | 'claude';
  kind?: 'root' | 'child' | 'unknown';
  parent?: number | null;
  basis?: 'native' | 'paseo' | null;
  repo?: string | null;
  name?: string | null;
  nameSource?: 'provider_title' | 'paseo' | null;
  agent?: string | null;
  workspace?: string | null;
  psid?: string;
  startedAt: number;
  startedBasis?: 'source_start' | 'first_event';
  model?: string;
}

/** Inserts a session. Its first and last event times are filled in by `addEvent`. */
export function addSession(db: DatabaseSync, options: SessionOptions): number {
  const provider = options.provider ?? 'codex';
  if (options.agent) {
    db.prepare(
      'INSERT OR IGNORE INTO paseo_agent (id, title, first_seen_at, last_seen_at) VALUES (?, ?, 0, 0)',
    ).run(options.agent, options.agent);
  }
  db.prepare(
    `INSERT INTO session (id, provider, provider_session_id, kind, parent_session_id, parent_basis, native_kind, recorded_name,
       name_source, repo_id, paseo_agent_id, workspace_label, started_at, started_basis, last_model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    options.id,
    provider,
    options.psid ?? `${provider}-session-${String(options.id).padStart(4, '0')}-abcdef`,
    options.kind ?? 'root',
    options.parent ?? null,
    options.basis ?? null,
    options.basis === 'paseo' ? 'paseo' : options.basis === 'native' ? 'subagent' : null,
    options.name ?? null,
    options.nameSource ?? null,
    options.repo ?? null,
    options.agent ?? null,
    options.workspace ?? null,
    options.startedAt,
    options.startedBasis ?? 'source_start',
    options.model ?? (provider === 'codex' ? 'gpt-5-codex' : 'claude-opus-5-5'),
  );
  return options.id;
}

let eventSeq = 0;

export interface EventOptions {
  session: number;
  at: number;
  input?: number;
  cached?: number;
  cacheWrite?: number;
  cacheRead?: number;
  output?: number;
  reasoning?: number;
}

/**
 * Inserts one usage event for a session and sets the session's event window. The provider total follows the owner rule:
 * Codex input + output (cached input and reasoning are subsets), Claude the sum of four separate categories.
 */
export function addEvent(db: DatabaseSync, options: EventOptions): void {
  const row = db.prepare('SELECT provider FROM session WHERE id = ?').get(options.session) as
    { provider: 'codex' | 'claude' } | undefined;
  if (!row) throw new Error(`no session ${options.session}`);
  const input = options.input ?? 0;
  const output = options.output ?? 0;
  const cacheWrite = options.cacheWrite ?? 0;
  const cacheRead = options.cacheRead ?? 0;
  const total = row.provider === 'codex' ? input + output : input + cacheWrite + cacheRead + output;
  db.prepare(
    `INSERT INTO usage_event (provider, dedupe_key, session_id, occurred_at, model, input_tokens, cached_input_tokens,
       cache_write_tokens, cache_read_tokens, output_tokens, reasoning_tokens, provider_total)
     VALUES (?, ?, ?, ?, 'm', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.provider,
    `k${++eventSeq}`,
    options.session,
    options.at,
    input,
    options.cached ?? 0,
    cacheWrite,
    cacheRead,
    output,
    options.reasoning ?? 0,
    total,
  );
  db.prepare(
    `UPDATE session SET first_event_at = MIN(COALESCE(first_event_at, ?1), ?1), last_event_at = MAX(COALESCE(last_event_at, ?1), ?1) WHERE id = ?2`,
  ).run(options.at, options.session);
}

/** A session with one event worth `tokens` (Codex: all of it as input). */
export function addActiveSession(db: DatabaseSync, options: SessionOptions, tokens = 100): number {
  const id = addSession(db, options);
  addEvent(db, { session: id, at: options.startedAt + 60_000, input: tokens });
  return id;
}

export const prNode = (repo: string, number: number): string => `PR_${repo}#${number}`;

export function addPr(db: DatabaseSync, repo: string, number: number, mergedAt: number): string {
  const node = prNode(repo, number);
  db.prepare(
    `INSERT INTO pull_request (node_id, repo_id, number, title, url, merged_at)
     VALUES (?, ?, ?, 't', 'https://github.com/x/y/pull/1', ?)`,
  ).run(node, repo, number, mergedAt);
  return node;
}

export function addLink(
  db: DatabaseSync,
  pr: string,
  session: number,
  cls: 'evidence' | 'suggested',
): void {
  db.prepare(
    "INSERT INTO pr_session_link (pr_node_id, session_id, class, basis, computed_at) VALUES (?, ?, ?, 'x', 0)",
  ).run(pr, session, cls);
}

export function addDecision(
  db: DatabaseSync,
  pr: string,
  session: number,
  decision: 'confirmed' | 'rejected' | 'dismissed',
): void {
  db.prepare(
    'INSERT INTO owner_link_decision (pr_node_id, session_id, decision, decided_at) VALUES (?, ?, ?, 0)',
  ).run(pr, session, decision);
}

export function addSource(
  db: DatabaseSync,
  id: 'codex' | 'claude' | 'paseo',
  options: {
    status?: string;
    oldest?: number | null;
    success?: number | null;
    result?: string | null;
    extra?: Record<string, unknown>;
    unreadable?: number;
  } = {},
): void {
  db.prepare(
    `INSERT INTO source_state (source_id, status, oldest_event_at, last_success_at, last_attempt_result, unreadable_count, extra_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    options.status ?? 'ok',
    options.oldest === undefined ? at('2026-01-01') : options.oldest,
    options.success === undefined ? NOW : options.success,
    options.result === undefined ? 'succeeded' : options.result,
    options.unreadable ?? 0,
    JSON.stringify(options.extra ?? {}),
  );
}
