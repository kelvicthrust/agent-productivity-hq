import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from '../../../src/server/db/open.ts';
import { recordComputedLinksSuccess } from '../../../src/server/db/queries/link-health.ts';
import { addDays } from '../../../src/shared/domain/periods.ts';
import {
  codexSubsetsHold,
  type ClaudeTokens,
  type CodexTokens,
} from '../../../src/shared/domain/tokens.ts';
import { isCodex, shares, splitInteger } from './events.ts';
import { BASIS_TEXT } from './typical.ts';
import { rng } from './rng.ts';
import type { World, WorldSession } from './types.ts';

export type Scenario = 'typical' | 'refresh-failed' | 'no-repos' | 'account-only' | 'empty';
export const SCENARIOS: readonly Scenario[] = [
  'typical',
  'refresh-failed',
  'no-repos',
  'account-only',
  'empty',
];

export interface WriteOptions {
  scenario: Scenario;
  /** The fixed clock, epoch ms. "Today, 9:42 AM" in the prototype. */
  now: number;
}

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');
const MIN = 60_000;

/** Local calendar date and `HH:MM` to UTC epoch ms in `timeZone`. */
const localMs = (date: string, time: string, timeZone: string): number =>
  Temporal.PlainDateTime.from(`${date}T${time}`).toZonedDateTime(timeZone).epochMilliseconds;
const dayStart = (date: string, timeZone: string) => localMs(date, '00:00', timeZone);

interface EventRow {
  dedupeKey: string;
  at: number;
  input: number;
  cached: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  reasoning: number;
  total: number;
}

/** Splits a session's tokens into its events. Per-category sums equal the session's, so provider totals match exactly. */
function eventsFor(
  session: WorldSession,
  startMs: number,
  dayEndMs: number,
  psid: string,
  index: number,
): EventRow[] {
  const r = rng(0x9e3779b1 ^ (index + 1));
  const n = session.events;
  const c = shares(n, r);
  const room = Math.max(1000, Math.floor((dayEndMs - 60_000 - startMs) / n));
  const at = (k: number) => startMs + k * Math.min(room, 30_000 + Math.floor(r() * 210_000));

  if (isCodex(session)) {
    const t = session.tokens as CodexTokens & { total: number };
    const input = splitInteger(t.input, c);
    const cached = splitInteger(t.cachedInput, c);
    const output = splitInteger(t.output, c);
    const reasoning = splitInteger(t.reasoning, c);
    let cum = 0;
    return input.map((_, k) => {
      const row = {
        input: input[k]!,
        cached: cached[k]!,
        output: output[k]!,
        reasoning: reasoning[k]!,
      };
      if (
        !codexSubsetsHold({
          input: row.input,
          cachedInput: row.cached,
          output: row.output,
          reasoning: row.reasoning,
        })
      ) {
        throw new Error(`Seed: event ${k} of ${session.key} breaks the Codex subset rules`);
      }
      const total = row.input + row.output;
      cum += total;
      return { dedupeKey: `${psid}:${cum}`, at: at(k), ...row, cacheWrite: 0, cacheRead: 0, total };
    });
  }
  const t = session.tokens as ClaudeTokens & { total: number };
  const input = splitInteger(t.inputUncached, c);
  const write = splitInteger(t.cacheWrite, c);
  const read = splitInteger(t.cacheRead, c);
  const output = splitInteger(t.output, c);
  return input.map((_, k) => ({
    dedupeKey: `msg_${sha1(`${psid}:${k}`).slice(0, 20)}:req_${sha1(`${psid}:r${k}`).slice(0, 16)}`,
    at: at(k),
    input: input[k]!,
    cached: 0,
    cacheWrite: write[k]!,
    cacheRead: read[k]!,
    output: output[k]!,
    reasoning: 0,
    total: input[k]! + write[k]! + read[k]! + output[k]!,
  }));
}

const sessionId = (ref: string, key: string): string => {
  const m = /^\w+ (\w{4})…(\w{4})/.exec(ref);
  const filler = sha1(`session:${key}`).slice(0, 24);
  return m ? `${m[1]}${filler}${m[2]}` : sha1(key).slice(0, 32);
};

/** Writes `world` into a migrated database, in one transaction. */
export function writeWorld(
  db: DatabaseSync,
  world: World,
  options: WriteOptions,
): Record<string, number> {
  const { scenario, now } = options;
  const tz = world.timezone;
  const empty = scenario === 'empty';
  const sessionsIn =
    empty || scenario === 'account-only'
      ? []
      : world.sessions.filter(
          (s) =>
            !(scenario === 'refresh-failed' && s.provider === 'codex' && s.date === world.today),
        );
  const keep = new Set(sessionsIn.map((s) => s.key));
  const repos = empty || scenario === 'no-repos' ? [] : world.repos;
  const repoIds = new Set(repos.map((r) => r.id));
  const prs = world.prs.filter((p) => repoIds.has(p.repo));

  return inTransaction(db, () => {
    const run = (sql: string, ...args: (string | number | null)[]) => db.prepare(sql).run(...args);
    const added = dayStart(world.lookbackStart, tz);

    // ---- repos
    for (const repo of repos) {
      const inaccessible = repo.access === 'inaccessible';
      run(
        `INSERT INTO repo (id, github_node_id, display_name, tracking_state, access_state, access_error, added_at, stopped_at,
           backfill_complete, last_sync_started_at, last_sync_success_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
        repo.id,
        `R_${sha1(repo.id).slice(0, 12)}`,
        repo.id,
        repo.tracking,
        repo.access,
        repo.accessError ?? null,
        added,
        now - 2 * MIN,
        inaccessible ? dayStart('2026-08-12', tz) : now,
      );
    }

    // ---- sessions and events (parents come first in the list, so their ids exist)
    const ids = new Map<string, number>();
    const agentOf = new Map<string, string>();
    const times = new Map<string, { first: number; last: number }>();
    const insertAgent = db.prepare(
      `INSERT INTO paseo_agent (id, title, provider, provider_session_id, parent_agent_id, workspace_id, workspace_label, cwd,
         background, archived_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?)`,
    );
    const insertSession = db.prepare(
      `INSERT INTO session (id, provider, provider_session_id, kind, parent_session_id, parent_basis, native_kind, recorded_name,
         name_source, repo_id, repo_basis, paseo_agent_id, workspace_label, started_at, started_basis, first_event_at, last_event_at, last_model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEvent = db.prepare(
      `INSERT INTO usage_event (provider, dedupe_key, session_id, occurred_at, model, input_tokens, cached_input_tokens,
         cache_write_tokens, cache_read_tokens, output_tokens, reasoning_tokens, provider_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let eventCount = 0;
    const firstSeen: Record<string, number> = {};

    sessionsIn.forEach((s, index) => {
      const id = index + 1;
      ids.set(s.key, id);
      const psid = sessionId(s.ref, s.key);
      const start = localMs(s.date, s.time, tz);
      const events = eventsFor(s, start, dayStart(addDays(s.date, 1), tz), psid, index);
      const first = events[0]!.at;
      const last = events[events.length - 1]!.at;
      times.set(s.key, { first, last });
      firstSeen[s.provider] = Math.min(firstSeen[s.provider] ?? Infinity, first);

      const parentId = s.parentKey && keep.has(s.parentKey) ? (ids.get(s.parentKey) ?? null) : null;
      // A child whose parent was not collected has an unknown relationship, never a guessed one.
      const kind = s.role === 'child' && parentId === null ? 'unknown' : s.role;
      const paseoParent = s.parentKey ? agentOf.get(s.parentKey) : undefined;
      let agentId: string | null = null;
      if (s.paseo) {
        agentId = `pa-${s.key}`;
        agentOf.set(s.key, agentId);
        insertAgent.run(
          agentId,
          s.paseo.agent,
          s.provider,
          psid,
          kind === 'child' ? (paseoParent ?? null) : null,
          `ws-${sha1(s.paseo.workspace).slice(0, 8)}`,
          s.paseo.workspace,
          first,
          last,
        );
        firstSeen['paseo'] = Math.min(firstSeen['paseo'] ?? Infinity, first);
      }
      const childBasis = kind === 'child' ? (s.kind === 'paseo' ? 'paseo' : 'native') : null;
      const nativeKind =
        kind === 'root'
          ? null
          : s.kind === 'paseo'
            ? 'paseo'
            : s.provider === 'claude'
              ? 'claude_subagent'
              : 'codex_subagent';
      const sourceStart = s.provider === 'codex' || kind === 'root';
      insertSession.run(
        id,
        s.provider,
        psid,
        kind,
        parentId,
        childBasis,
        nativeKind,
        s.paseo?.agent ?? null,
        s.paseo ? 'paseo' : null,
        s.repo,
        s.repo ? 'git_remote' : null,
        agentId,
        s.paseo?.workspace ?? null,
        sourceStart ? first - MIN : first,
        sourceStart ? 'source_start' : 'first_event',
        first,
        last,
        s.model,
      );
      for (const e of events) {
        insertEvent.run(
          s.provider,
          e.dedupeKey,
          id,
          e.at,
          s.model,
          e.input,
          e.cached,
          e.cacheWrite,
          e.cacheRead,
          e.output,
          e.reasoning,
          e.total,
        );
        eventCount++;
      }
    });

    // ---- pull requests, commits, links and the references that justify evidence
    const nodeId = (repo: string, n: number) => `PR_kwDO${sha1(`${repo}#${n}`).slice(0, 10)}`;
    let linkCount = 0;
    let decisionCount = 0;
    for (const pr of prs) {
      const node = nodeId(pr.repo, pr.number);
      const merged = localMs(pr.date, pr.time, tz);
      const url = `https://github.com/${pr.repo}/pull/${pr.number}`;
      const slug = pr.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      run(
        `INSERT INTO pull_request (node_id, repo_id, number, title, url, author_login, merged_by_login, merged_at, head_ref, base_ref,
           merge_commit_sha, commits_complete) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'main', ?, 1)`,
        node,
        pr.repo,
        pr.number,
        pr.title,
        url,
        pr.author,
        pr.mergedBy,
        merged,
        `feature/${slug}-${pr.number}`,
        sha1(`${pr.repo}#${pr.number}:merge`),
      );
      const commits = Array.from({ length: (pr.number % 3) + 1 }, (_, i) =>
        sha1(`${pr.repo}#${pr.number}:c${i}`),
      );
      for (const sha of commits)
        run('INSERT INTO pr_commit (pr_node_id, sha) VALUES (?, ?)', node, sha);

      for (const link of pr.links) {
        const id = ids.get(link.sessionKey);
        if (id === undefined) continue;
        const evidence = link.cls === 'evidence';
        const basis = evidence
          ? link.basis === BASIS_TEXT.prReference
            ? 'pr_reference'
            : 'commit_match'
          : 'same_repo_window';
        run(
          'INSERT INTO pr_session_link (pr_node_id, session_id, class, basis, computed_at) VALUES (?, ?, ?, ?, ?)',
          node,
          id,
          evidence ? 'evidence' : 'suggested',
          basis,
          now,
        );
        linkCount++;
        if (basis === 'pr_reference') {
          run(
            "INSERT INTO session_ref (session_id, kind, value, observed_at) VALUES (?, 'pr_url', ?, ?) ON CONFLICT DO NOTHING",
            id,
            // the identifier the evidence scan stores (data-and-sources › Evidence extraction): lowercase owner/name#number, not the URL
            `${pr.repo.toLowerCase()}#${pr.number}`,
            merged - 10 * MIN,
          );
        } else if (basis === 'commit_match') {
          run(
            "INSERT INTO session_ref (session_id, kind, value, observed_at) VALUES (?, 'commit', ?, ?) ON CONFLICT DO NOTHING",
            id,
            commits[0]!,
            merged - 20 * MIN,
          );
        }
        if (link.cls === 'owner') {
          run(
            "INSERT INTO owner_link_decision (pr_node_id, session_id, decision, prior_class, prior_basis, decided_at) VALUES (?, ?, 'confirmed', 'suggested', 'same_repo_window', ?)",
            node,
            id,
            Math.min(now, merged + 60 * MIN),
          );
          decisionCount++;
        }
      }
    }

    if (prs.length > 0) recordComputedLinksSuccess(db, now);

    // ---- sources, accounts, the last run
    const failed = scenario === 'refresh-failed';
    const hasLocal = sessionsIn.length > 0;
    const lastOk = now; // "Today, 9:42 AM"
    const source = (
      id: string,
      status: string,
      location: string | null,
      oldest: number | null,
      result: string,
      extra: Record<string, unknown> = {},
      more: {
        unreadable?: number;
        failures?: number;
        errorCode?: string;
        errorDetail?: string;
        success?: number | null;
        attempt?: number;
      } = {},
    ) =>
      run(
        `INSERT INTO source_state (source_id, status, location, oldest_event_at, last_success_at, last_attempt_at, last_attempt_result,
           consecutive_failures, error_code, error_detail, unreadable_count, unsupported_count, adapter_version, extra_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'fixture', ?)`,
        id,
        status,
        location,
        oldest,
        more.success === undefined ? lastOk : more.success,
        more.attempt ?? lastOk,
        result,
        more.failures ?? 0,
        more.errorCode ?? null,
        more.errorDetail ?? null,
        more.unreadable ?? 0,
        JSON.stringify(extra),
      );
    const imported = (provider: string) => sessionsIn.filter((s) => s.provider === provider).length;

    if (!empty) {
      const none = (id: string, location: string) =>
        source(id, 'notfound', location, null, 'failed', {}, { success: null });
      if (hasLocal) {
        if (failed) {
          source(
            'codex',
            'failed',
            '~/.codex/sessions',
            firstSeen['codex'] ?? null,
            'failed',
            { staleAfter: '2026-11-03' },
            {
              failures: 1,
              success: localMs('2026-11-03', '18:12', tz),
              attempt: localMs(world.today, '09:40', tz),
              errorCode: 'unrecognized_format',
              errorDetail:
                'Couldn’t read 2 new session files (unrecognized format). Already-imported history is unaffected.',
            },
          );
        } else source('codex', 'ok', '~/.codex/sessions', firstSeen['codex'] ?? null, 'succeeded');
        source('claude', 'ok', '~/.claude/projects', firstSeen['claude'] ?? null, 'succeeded');
        source(
          'paseo',
          'partial',
          'Paseo local agent metadata',
          firstSeen['paseo'] ?? null,
          'partial',
          {
            note: '3 agent records couldn’t be read (unsupported format). Their provider usage is still counted; their agent relationships show as Unknown.',
          },
          { unreadable: 3 },
        );
      } else {
        none('codex', '~/.codex/sessions');
        none('claude', '~/.claude/projects');
        none('paseo', 'Paseo local agent metadata');
      }
      source('github', 'ok', 'github.com', null, 'succeeded');
      source('chatgpt_account', 'ok', 'Codex app-server', null, 'succeeded');
      if (failed) {
        source(
          'claude_account',
          'failed',
          null,
          null,
          'failed',
          { stale: true },
          {
            failures: 1,
            success: localMs('2026-10-30', '08:05', tz),
            attempt: localMs(world.today, '09:40', tz),
            errorCode: 'reconnect_needed',
            errorDetail: 'Claude needs to be reconnected.',
          },
        );
      } else source('claude_account', 'ok', null, null, 'succeeded');

      // ChatGPT daily buckets over the window, summing to the account-reported total.
      const w = world.chatgptWindow;
      const days: string[] = [];
      for (let d = w.start; d <= w.end; d = addDays(d, 1)) days.push(d);
      const r = rng(77);
      const weights = days.map(() => 0.4 + r());
      const sum = weights.reduce((a, b) => a + b, 0);
      let run2 = 0;
      const cumulative = weights.map((x) => (run2 += x / sum));
      cumulative[cumulative.length - 1] = 1;
      splitInteger(w.total, cumulative).forEach((tokens, i) =>
        run(
          "INSERT INTO account_daily_tokens (account, date, tokens, fetched_at) VALUES ('chatgpt', ?, ?, ?)",
          days[i]!,
          tokens,
          now,
        ),
      );
      run(
        "INSERT INTO account_snapshot (account, kind, limit_id, unit, value, window_minutes, resets_at, fetched_at) VALUES ('claude', 'rate_limit', 'seven_day', 'percent', 62, 10080, ?, ?)",
        dayStart('2026-11-05', tz),
        failed ? localMs('2026-10-30', '08:05', tz) : now,
      );

      const per = {
        codex: failed
          ? {
              state: 'failed',
              imported: 0,
              duplicatesSkipped: 0,
              unreadable: 2,
              message: 'Couldn’t read 2 new session files (unrecognized format).',
            }
          : {
              state: 'succeeded',
              imported: imported('codex'),
              duplicatesSkipped: 0,
              unreadable: 0,
            },
        claude: {
          state: 'succeeded',
          imported: imported('claude'),
          duplicatesSkipped: 0,
          unreadable: 0,
        },
        paseo: {
          state: 'partial',
          imported: sessionsIn.filter((s) => s.paseo).length,
          duplicatesSkipped: 0,
          unreadable: 3,
          message: '3 agent records couldn’t be read.',
        },
        github: { state: 'succeeded', imported: prs.length, duplicatesSkipped: 0, unreadable: 0 },
      };
      run(
        "INSERT INTO refresh_run (id, trigger, started_at, finished_at, state, per_source_json) VALUES (1, 'schedule', ?, ?, ?, ?)",
        now - MIN,
        now,
        failed ? 'partial' : 'partial',
        JSON.stringify(per),
      );
    }

    // ---- app_meta
    const meta = (key: string, value: string) =>
      run(
        'INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        key,
        value,
      );
    meta('report_timezone', tz);
    meta('install_id', `00000000-0000-4000-8000-${sha1('seed').slice(0, 12)}`);
    if (!empty) {
      meta('setup_completed_at', String(added));
      meta('github_login', world.me);
    }
    meta('seed_marker', 'synthetic-fixture-world');
    meta('seed_scenario', scenario);
    meta('seed_now', new Date(now).toISOString());

    return {
      repos: repos.length,
      sessions: sessionsIn.length,
      events: eventCount,
      pullRequests: prs.length,
      prLinks: linkCount,
      ownerDecisions: decisionCount,
    };
  });
}
