/**
 * Routes described in docs/tech/local-api.md and in src/shared/contracts/routes.ts that the server does not serve yet.
 * The contract test compares this list with what the running app really serves, in both directions: building a route
 * without removing it here fails, and removing a route here that is not served fails. It is empty from M10 on: every route in the
 * document is served.
 *
 * Served in M2: GET /api/health, GET /api/bootstrap. Served in M4: GET /api/repos (the list only; the repo filter needs it),
 * GET /api/usage/categories, /groups and /groups/{groupKey}/roots, GET /api/sources, POST /api/refresh and GET /api/refresh/{runId}.
 * Served in M6: the GitHub account routes (connect, poll, disconnect, the App's client ID), the repo writes (add, stop, re-check),
 * GET /api/prs (the list) and GET /api/year.
 * Served in M7: GET /api/overview, /api/series, /api/records and /api/models.
 * Served in M8: GET /api/prs/{prId} and PUT and DELETE /api/prs/{prId}/links/{sessionId} (the PR evidence and the owner's decisions).
 * Served in M9: the ChatGPT connect, poll and disconnect (the same account routes as GitHub's) and the Claude plan-usage capture
 * (GET /api/accounts/claude/usage-capture/preview and PUT /api/accounts/claude/usage-capture).
 * Served in M10: POST /api/setup/discover and POST /api/setup/complete (first-launch Setup).
 */
export const PENDING_ROUTES: readonly string[] = [];
