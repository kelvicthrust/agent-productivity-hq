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
import { modelsRoutes } from '../../../src/server/http/routes/models.ts';
import { overviewRoutes } from '../../../src/server/http/routes/overview.ts';
import { prsRoutes } from '../../../src/server/http/routes/prs.ts';
import { recordsRoutes } from '../../../src/server/http/routes/records.ts';
import { seriesRoutes } from '../../../src/server/http/routes/series.ts';
import { usageRoutes } from '../../../src/server/http/routes/usage.ts';
import { yearRoutes } from '../../../src/server/http/routes/year.ts';
import { OverviewResponse } from '../../../src/shared/contracts/overview.ts';
import { RecordsResponse } from '../../../src/shared/contracts/prs.ts';
import { SeriesResponse } from '../../../src/shared/contracts/series.ts';
import { ModelsResponse } from '../../../src/shared/contracts/usage.ts';
import { HOST, NOW, PORT, TZ, memoryDb, memoryLogger } from '../helpers.ts';
import { addEvent } from '../usage/helpers.ts';

export { HOST, NOW, PORT, TZ, memoryDb };
// The hand-built world of the Usage tests (repos, sessions, events, PRs, links, sources): one set of builders for every surface.
export {
  addDecision,
  addEvent,
  addLink,
  addPr,
  addRepo,
  addSession,
  addSource,
  at,
  prNode,
} from '../usage/helpers.ts';

/**
 * An event for a named model (the shared builder gives every event the model `m`). It is the newest row, so it is renamed in place.
 */
export function addModelEvent(
  db: DatabaseSync,
  model: string,
  options: Parameters<typeof addEvent>[1],
): void {
  addEvent(db, options);
  db.prepare('UPDATE usage_event SET model = ? WHERE id = (SELECT MAX(id) FROM usage_event)').run(
    model,
  );
}

/**
 * The review routes (and the Usage and Delivery routes, which the parity tests compare them with) behind the product's guards, so they are
 * tested without the rest of createApp. The clock defaults to the fixed test time (Wednesday 2026-11-04 12:00 in Los Angeles) and
 * the report timezone to Los Angeles.
 */
export function metricsApp(
  db: DatabaseSync,
  options: { now?: () => number; timezone?: string } = {},
) {
  const { logger } = memoryLogger();
  const app = new Hono<HttpEnv>();
  app.use('*', correlation());
  app.use('*', securityHeaders());
  app.use('*', hostGuard(PORT, logger));
  app.use('*', csrfGuard(logger));
  app.onError(errorHandler(logger));
  const deps = { db, now: options.now ?? (() => NOW), timezone: options.timezone ?? TZ };
  app.route('/', overviewRoutes(deps));
  app.route('/', seriesRoutes(deps));
  app.route('/', recordsRoutes(deps));
  app.route('/', modelsRoutes(deps));
  app.route('/', usageRoutes(deps));
  app.route('/', prsRoutes(deps));
  app.route('/', yearRoutes(deps));
  app.all('/api/*', apiNotFound);
  app.notFound(apiNotFound);
  return app;
}

export type MetricsApp = ReturnType<typeof metricsApp>;

export async function get(app: MetricsApp, path: string) {
  const res = await app.request(`http://127.0.0.1:${PORT}${path}`, { headers: HOST });
  const body = (await res.json()) as unknown;
  return { status: res.status, headers: res.headers, body };
}

/** GET and expect 200 with a body the contract accepts and carries no key the contract does not know. */
async function getParsed<T extends z.ZodType>(app: MetricsApp, path: string, schema: T) {
  const { status, body } = await get(app, path);
  expect(status, JSON.stringify(body)).toBe(200);
  const parsed = schema.parse(body);
  expect(parsed).toEqual(body);
  return parsed as z.infer<T>;
}

export const overview = (app: MetricsApp, query = '') =>
  getParsed(app, `/api/overview${query}`, OverviewResponse);
export const series = (app: MetricsApp, query = '') =>
  getParsed(app, `/api/series${query}`, SeriesResponse);
export const records = (app: MetricsApp, query = '') =>
  getParsed(app, `/api/records${query}`, RecordsResponse);
export const models = (app: MetricsApp, query = '') =>
  getParsed(app, `/api/models${query}`, ModelsResponse);

/** Sets the connected GitHub login, which the `mine` author filter compares with the PR author. */
export function connectAs(db: DatabaseSync, login: string): void {
  db.prepare(
    "INSERT INTO app_meta (key, value) VALUES ('github_login', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(login);
}

/** A merged PR with an author (the usage helpers' `addPr` has none, and `mine` keeps only PRs the connected login wrote). */
export function addMergedPr(
  db: DatabaseSync,
  repo: string,
  number: number,
  mergedAt: number,
  author: string | null = 'kelvin',
  title = `PR ${number}`,
): string {
  const node = `PR_${repo}#${number}`;
  db.prepare(
    `INSERT INTO pull_request (node_id, repo_id, number, title, url, author_login, merged_by_login, merged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    node,
    repo,
    number,
    title,
    `https://github.com/${repo}/pull/${number}`,
    author,
    author,
    mergedAt,
  );
  return node;
}
