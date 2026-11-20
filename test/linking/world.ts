import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { writeSessionRefs, type SessionRefInput } from '../../src/server/db/queries/links.ts';
import { upsertPullRequests } from '../../src/server/db/queries/prs.ts';
import { upsertSession } from '../../src/server/db/queries/usage.ts';
import {
  apiNotFound,
  correlation,
  errorHandler,
  type HttpEnv,
} from '../../src/server/http/errors.ts';
import { csrfGuard, hostGuard, securityHeaders } from '../../src/server/http/guards.ts';
import { linksRoutes } from '../../src/server/http/routes/links.ts';
import { HOST, NOW, PORT, TZ, WRITE, memoryDb, memoryLogger } from '../server/helpers.ts';

export { HOST, NOW, PORT, TZ, WRITE, memoryDb };

// A small hand-built world for the linking tests: repos, merged PRs (with a head branch and commits), sessions (with an activity
// window and optional tokens) and the identifiers a session showed. Everything is invented; no byte of it is a real record.

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** A merge on Tuesday 2026-11-03 at 10:00 in Los Angeles, inside the test clock's week. */
export const MERGED = Date.parse('2026-11-03T18:00:00Z');

export const REPO = 'kelvin/app';

export function addRepo(
  db: DatabaseSync,
  id: string,
  options: { tracking?: 'active' | 'stopped' } = {},
): void {
  db.prepare(
    `INSERT INTO repo (id, display_name, tracking_state, access_state, added_at, backfill_complete)
     VALUES (?, ?, ?, 'ok', 0, 1)`,
  ).run(id, id, options.tracking ?? 'active');
}

export interface PrOptions {
  repo?: string;
  mergedAt?: number;
  headRef?: string | null;
  commits?: string[];
  mergeCommitSha?: string | null;
  author?: string | null;
}

export const prNode = (number: number, repo = REPO): string => `PR_${repo}#${number}`;

export function addPr(db: DatabaseSync, number: number, options: PrOptions = {}): string {
  const repo = options.repo ?? REPO;
  upsertPullRequests(db, [
    {
      nodeId: prNode(number, repo),
      repoId: repo,
      number,
      title: `PR ${number}`,
      url: `https://github.com/${repo}/pull/${number}`,
      authorLogin: options.author === undefined ? 'kelvin' : options.author,
      mergedByLogin: 'kelvin',
      mergedAt: options.mergedAt ?? MERGED,
      headRef: options.headRef === undefined ? `feature/${number}` : options.headRef,
      baseRef: 'main',
      mergeCommitSha: options.mergeCommitSha === undefined ? null : options.mergeCommitSha,
      commits: options.commits ?? [],
      commitsComplete: true,
    },
  ]);
  return prNode(number, repo);
}

export interface SessionOptions {
  /** Epoch ms of the last event; the session started an hour earlier unless `startedAt` says otherwise. */
  lastEventAt: number;
  startedAt?: number;
  repo?: string | null;
  branch?: string | null;
  provider?: 'codex' | 'claude';
  tokens?: number;
}

let sessionSeq = 0;

export function addSession(db: DatabaseSync, options: SessionOptions): number {
  const provider = options.provider ?? 'claude';
  const startedAt = options.startedAt ?? options.lastEventAt - HOUR;
  const key = `${provider}-s${++sessionSeq}`;
  const id = upsertSession(db, {
    provider,
    providerSessionId: key,
    kind: 'root',
    repoId: options.repo === undefined ? REPO : options.repo,
    gitBranch: options.branch === undefined ? null : options.branch,
    startedAt,
    startedBasis: 'source_start',
    firstEventAt: startedAt,
    lastEventAt: options.lastEventAt,
    lastModel: provider === 'codex' ? 'gpt-5-codex' : 'claude-opus-5-5',
  });
  if (options.tokens !== undefined) {
    db.prepare(
      `INSERT INTO usage_event (provider, dedupe_key, session_id, occurred_at, model, input_tokens, provider_total)
       VALUES (?, ?, ?, ?, 'm', ?, ?)`,
    ).run(provider, `${key}:e1`, id, options.lastEventAt, options.tokens, options.tokens);
  }
  return id;
}

/** What the session showed: PR references, commit ids and branches, stored the way the scan stores them. */
export function showRefs(
  db: DatabaseSync,
  sessionId: number,
  refs: { prs?: string[]; commits?: string[]; branches?: string[] },
  observedAt = MERGED - HOUR,
): void {
  const input: SessionRefInput[] = [
    ...(refs.prs ?? []).map((value) => ({ kind: 'pr_url' as const, value, observedAt })),
    ...(refs.commits ?? []).map((value) => ({ kind: 'commit' as const, value, observedAt })),
    ...(refs.branches ?? []).map((value) => ({ kind: 'branch' as const, value, observedAt })),
  ];
  const result = writeSessionRefs(db, sessionId, input);
  if (result.rejected > 0) throw new Error('the test world gave the store a non-identifier');
}

export const rows = (db: DatabaseSync, sql: string): Record<string, unknown>[] =>
  db.prepare(sql).all() as Record<string, unknown>[];

/** The computed links as `prNumber/session → class:basis`, for compact assertions. */
export function computed(db: DatabaseSync): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows(
    db,
    'SELECT pr_node_id, session_id, class, basis FROM pr_session_link ORDER BY pr_node_id, session_id',
  )) {
    out[`${String(row['pr_node_id'])}/${String(row['session_id'])}`] =
      `${String(row['class'])}:${String(row['basis'])}`;
  }
  return out;
}

export function decisions(db: DatabaseSync): Record<string, unknown>[] {
  return rows(
    db,
    'SELECT pr_node_id, session_id, decision, prior_class, prior_basis, decided_at FROM owner_link_decision ORDER BY pr_node_id, session_id',
  );
}

/** The links routes behind the product's guards, so they are tested without the rest of createApp. */
export function linksApp(db: DatabaseSync, now: () => number = () => NOW) {
  const { logger } = memoryLogger();
  const app = new Hono<HttpEnv>();
  app.use('*', correlation());
  app.use('*', securityHeaders());
  app.use('*', hostGuard(PORT, logger));
  app.use('*', csrfGuard(logger));
  app.onError(errorHandler(logger));
  app.route('/', linksRoutes({ db, now, timezone: TZ }));
  app.all('/api/*', apiNotFound);
  app.notFound(apiNotFound);
  return app;
}

export type LinksApp = ReturnType<typeof linksApp>;

const url = (path: string): string => `http://127.0.0.1:${PORT}${path}`;

export async function getJson(app: LinksApp, path: string) {
  const res = await app.request(url(path), { headers: HOST });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
}

export async function send(
  app: LinksApp,
  method: 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  headers: Record<string, string> = WRITE,
) {
  const res = await app.request(url(path), {
    method,
    headers,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
}
