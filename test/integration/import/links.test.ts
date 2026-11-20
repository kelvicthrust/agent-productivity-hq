import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { replaceComputedLinks } from '../../../src/server/db/queries/links.ts';
import { upsertPullRequests } from '../../../src/server/db/queries/prs.ts';
import {
  buildPrDetail,
  recomputeLinks,
  removeLinkDecision,
  setLinkDecision,
} from '../../../src/server/services/links.ts';
import { tempDir } from '../../server/helpers.ts';
import { T0, everythingStored, makeHome, startMachine } from './helpers.ts';

// Evidence from real adapters through a real refresh (G8_2, G8_3, G8_4): the Claude Code and Codex adapters scan every line they
// read, in memory, and store identifiers only; the link recompute turns them into evidence links; an owner decision survives
// every later refresh and a restart. The transcripts are INVENTED; the "body" text they plant must never reach the database.

const CLAUDE_FILE =
  '.claude/projects/-fixture-SENTINEL_CWD_d4e5f6-lib/33333333-cccc-4ccc-8ccc-000000000003.jsonl';
const CLAUDE_SESSION = '33333333-cccc-4ccc-8ccc-000000000003';
const CODEX_FILE =
  '.codex/sessions/2026/10/12/rollout-2026-10-12T09-00-00-aaaaaaaa-1111-4111-8111-00000000000a.jsonl';
const CODEX_SESSION = 'aaaaaaaa-1111-4111-8111-00000000000a';

const BODY = 'SENTINEL_PROMPT_body_7f3a9c';
const SUBJECT = 'SENTINEL_TOOL_subject_c19d44';
const PR_COMMIT = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';
const MERGED = Date.parse('2026-10-13T12:00:00Z');

/** The three lines a session adds when it names a PR: a prompt with a URL, and git's own summary of a commit. */
const claudeLines = (): string =>
  [
    {
      type: 'user',
      timestamp: '2026-10-13T09:05:00.000Z',
      sessionId: CLAUDE_SESSION,
      gitBranch: 'feature/links',
      message: {
        role: 'user',
        content: `${BODY} please look at https://github.com/Kelvin/Lib/pull/12 and fix it`,
      },
    },
    {
      type: 'user',
      timestamp: '2026-10-13T09:06:00.000Z',
      sessionId: CLAUDE_SESSION,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', content: `[feature/links ${PR_COMMIT.slice(0, 7)}] ${SUBJECT}` },
        ],
      },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n') + '\n';

function addTrackedPr(db: ReturnType<typeof startMachine>['db']): void {
  db.prepare(
    `INSERT INTO repo (id, display_name, tracking_state, access_state, added_at, backfill_complete)
     VALUES ('kelvin/lib', 'kelvin/lib', 'active', 'ok', 0, 1)`,
  ).run();
  upsertPullRequests(db, [
    {
      nodeId: 'PR_lib_12',
      repoId: 'kelvin/lib',
      number: 12,
      title: 'Fix the lib',
      url: 'https://github.com/kelvin/lib/pull/12',
      authorLogin: 'kelvin',
      mergedByLogin: 'kelvin',
      mergedAt: MERGED,
      headRef: 'feature/links',
      baseRef: 'main',
      mergeCommitSha: null,
      commits: [PR_COMMIT],
      commitsComplete: true,
    },
    {
      nodeId: 'PR_lib_13',
      repoId: 'kelvin/lib',
      number: 13,
      title: 'Another',
      url: 'https://github.com/kelvin/lib/pull/13',
      authorLogin: 'kelvin',
      mergedByLogin: 'kelvin',
      mergedAt: MERGED + 3_600_000,
      headRef: 'feature/other',
      baseRef: 'main',
      mergeCommitSha: null,
      commits: ['9999999999999999999999999999999999999999'],
      commitsComplete: true,
    },
  ]);
}

const sessionId = (m: ReturnType<typeof startMachine>, provider: string, id: string): number =>
  (
    m.db
      .prepare('SELECT id FROM session WHERE provider = ? AND provider_session_id = ?')
      .get(provider, id) as { id: number }
  ).id;

describe('evidence through a real refresh', () => {
  it('stores identifiers only (a search of every table for the planted text finds nothing) and links the session to the PR it named', async () => {
    const m = startMachine({ home: makeHome(), links: true });
    addTrackedPr(m.db);
    await m.refresh(); // the first import: the sessions exist, nothing names a PR yet
    expect(m.db.prepare('SELECT COUNT(*) AS n FROM pr_session_link').get()).toEqual({ n: 0 });

    m.tick(15 * 60_000);
    appendFileSync(join(m.home, CLAUDE_FILE), claudeLines());
    const run = await m.refresh();
    expect(run.state).toBe('succeeded');

    const claude = sessionId(m, 'claude', CLAUDE_SESSION);
    // the identifiers the lines named and nothing else: the PR reference (lowercased), the commit id and the branches
    expect(
      m.db
        .prepare('SELECT kind, value FROM session_ref WHERE session_id = ? ORDER BY kind, value')
        .all(claude),
    ).toEqual([
      // the fixture transcript's own branch (metadata the schema keeps) and the one the new line carries
      { kind: 'branch', value: 'SENTINEL_BRANCH_e5f6a1' },
      { kind: 'branch', value: 'feature/links' },
      { kind: 'commit', value: PR_COMMIT.slice(0, 7) },
      { kind: 'pr_url', value: 'kelvin/lib#12' },
    ]);
    // the PR reference wins over the commit as the basis, and only that PR is linked (the commit belongs to PR 12 as well)
    expect(
      m.db
        .prepare('SELECT pr_node_id, class, basis FROM pr_session_link WHERE session_id = ?')
        .all(claude),
    ).toEqual([{ pr_node_id: 'PR_lib_12', class: 'evidence', basis: 'pr_reference' }]);

    // G8_2: no prompt, reply, tool or commit text anywhere in the database
    const stored = JSON.stringify(everythingStored(m.db));
    expect(stored).not.toContain(BODY);
    expect(stored).not.toContain(SUBJECT);
    expect(stored).not.toMatch(/SENTINEL_(PROMPT|TOOL)_(body|subject)/);
    // nor in anything the run logged
    expect(JSON.stringify(m.logs.entries)).not.toMatch(/SENTINEL_(PROMPT|TOOL)_(body|subject)/);
    expect(JSON.stringify(m.logs.entries)).not.toContain('Kelvin/Lib');
    m.close();
  });

  it('reads a Codex rollout the same way, and counts a PR that two sessions name once', async () => {
    const m = startMachine({ home: makeHome(), links: true });
    addTrackedPr(m.db);
    await m.refresh();
    m.tick(15 * 60_000);
    appendFileSync(join(m.home, CLAUDE_FILE), claudeLines());
    appendFileSync(
      join(m.home, CODEX_FILE),
      JSON.stringify({
        timestamp: '2026-10-12T09:40:00.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          output: `[main ${PR_COMMIT.slice(0, 9)}] ${SUBJECT}`,
        },
      }) + '\n',
    );
    await m.refresh();

    const codex = sessionId(m, 'codex', CODEX_SESSION);
    expect(
      m.db
        .prepare('SELECT pr_node_id, class, basis FROM pr_session_link WHERE session_id = ?')
        .all(codex),
    ).toEqual([{ pr_node_id: 'PR_lib_12', class: 'evidence', basis: 'commit_match' }]);
    expect(JSON.stringify(everythingStored(m.db))).not.toContain(SUBJECT);

    // two sessions now link PR 12: it is one PR with two linked sessions
    expect(
      m.db
        .prepare(
          "SELECT COUNT(DISTINCT pr_node_id) AS prs, COUNT(*) AS links FROM pr_session_link WHERE class = 'evidence'",
        )
        .get(),
    ).toEqual({ prs: 1, links: 2 });
    const detail = buildPrDetail(m.db, 'PR_lib_12');
    expect(detail.pr).toMatchObject({ linkClass: 'evidence', linkedSessionCount: 2 });
    expect(detail.evidence.map((item) => item.basis).sort()).toEqual([
      'commit_match',
      'pr_reference',
    ]);
    m.close();
  });
});

describe('a decision outlives refreshes and a restart', () => {
  it('is not overwritten by a refresh that finds the same, more or less evidence, and is still there after the app restarts', async () => {
    const dbPath = join(tempDir(), 'agent-productivity.db');
    const home = makeHome();
    let m = startMachine({ home, dbPath, links: true });
    addTrackedPr(m.db);
    await m.refresh();
    m.tick(15 * 60_000);
    appendFileSync(join(home, CLAUDE_FILE), claudeLines());
    await m.refresh();
    const claude = sessionId(m, 'claude', CLAUDE_SESSION);

    // the owner marks the evidence link incorrect
    setLinkDecision(m.db, 'PR_lib_12', claude, 'rejected', { nowMs: T0 });
    const decision = m.db.prepare('SELECT * FROM owner_link_decision').all();
    expect(decision).toEqual([
      expect.objectContaining({
        pr_node_id: 'PR_lib_12',
        session_id: claude,
        decision: 'rejected',
        prior_class: 'evidence',
        prior_basis: 'pr_reference',
      }),
    ]);

    // a refresh finds the same evidence: the decision is untouched, and the link still counts as nothing
    m.tick(15 * 60_000);
    await m.refresh();
    expect(m.db.prepare('SELECT * FROM owner_link_decision').all()).toEqual(decision);
    expect(buildPrDetail(m.db, 'PR_lib_12').pr).toMatchObject({
      linkClass: 'unlinked',
      linkedSessionCount: 0,
    });

    // a recompute that finds no evidence at all (the computed table emptied) still leaves the decision, and the claim it kept
    replaceComputedLinks(m.db, [], T0);
    recomputeLinks(m.db, T0);
    expect(m.db.prepare('SELECT * FROM owner_link_decision').all()).toEqual(decision);
    m.close();

    // restart: the same file, a new process
    m = startMachine({ home, dbPath, links: true });
    expect(m.db.prepare('SELECT * FROM owner_link_decision').all()).toEqual(decision);
    await m.refresh();
    expect(m.db.prepare('SELECT * FROM owner_link_decision').all()).toEqual(decision);
    const after = buildPrDetail(m.db, 'PR_lib_12');
    expect(after.pr).toMatchObject({ linkClass: 'unlinked' });
    expect(after.evidence).toEqual([
      expect.objectContaining({
        effectiveClass: 'rejected',
        sourceClass: 'evidence',
        actions: ['restore'],
      }),
    ]);

    // Undo (Restore): the decision goes and the computed claim shows again
    removeLinkDecision(m.db, 'PR_lib_12', claude, { nowMs: T0 });
    expect(buildPrDetail(m.db, 'PR_lib_12').pr).toMatchObject({
      linkClass: 'evidence',
      linkedSessionCount: 1,
    });
    m.close();
  });
});
