import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { inTransaction } from '../../src/server/db/open.ts';
import {
  changeDecision,
  isRefIdentifier,
  readCandidateRows,
  readEvidenceRows,
  readLinkInputs,
  readPair,
  replaceComputedLinks,
  writeSessionRefs,
  type ComputedLinkRow,
} from '../../src/server/db/queries/links.ts';
import { upsertPullRequests } from '../../src/server/db/queries/prs.ts';
import { upsertSession } from '../../src/server/db/queries/usage.ts';
import { memoryDb } from '../server/helpers.ts';

// The SQL half of attribution (G8_2, G8_4): identifiers only get into session_ref, a recompute rebuilds pr_session_link in one
// transaction and cannot reach an owner decision, and every decision is read, judged and written under one lock. The rules
// themselves (classify, the transition table) are tested in test/linking.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MERGED = Date.parse('2026-11-03T18:00:00Z');

function addRepo(db: DatabaseSync, id: string) {
  db.prepare(
    `INSERT INTO repo (id, display_name, tracking_state, access_state, added_at, backfill_complete)
     VALUES (?, ?, 'active', 'ok', 0, 1)`,
  ).run(id, id);
}

function addPr(db: DatabaseSync, nodeId: string, repo: string, number: number, mergedAt = MERGED) {
  upsertPullRequests(db, [
    {
      nodeId,
      repoId: repo,
      number,
      title: `PR ${number}`,
      url: `https://github.com/${repo}/pull/${number}`,
      authorLogin: 'kelvin',
      mergedByLogin: 'kelvin',
      mergedAt,
      headRef: `feature/${number}`,
      baseRef: 'main',
      mergeCommitSha: 'abcdef1234567890',
      commits: ['1111111aaaaaaa', '2222222bbbbbbb'],
      commitsComplete: true,
    },
  ]);
}

function addSession(
  db: DatabaseSync,
  id: string,
  repo: string | null,
  lastEventAt: number,
  extra: { startedAt?: number; tokens?: number } = {},
): number {
  const sessionId = upsertSession(db, {
    provider: 'claude',
    providerSessionId: id,
    kind: 'root',
    repoId: repo,
    gitBranch: 'feature/1',
    startedAt: extra.startedAt ?? lastEventAt - HOUR,
    startedBasis: 'source_start',
    firstEventAt: extra.startedAt ?? lastEventAt - HOUR,
    lastEventAt,
  });
  if (extra.tokens)
    db.prepare(
      `INSERT INTO usage_event (provider, dedupe_key, session_id, occurred_at, model, provider_total)
       VALUES ('claude', ?, ?, ?, 'model-x', ?)`,
    ).run(`${id}:e1`, sessionId, lastEventAt, extra.tokens);
  return sessionId;
}

const link = (
  prNodeId: string,
  sessionId: number,
  cls: ComputedLinkRow['class'],
  basis: ComputedLinkRow['basis'],
): ComputedLinkRow => ({ prNodeId, sessionId, class: cls, basis });

function world() {
  const db = memoryDb();
  addRepo(db, 'kelvin/app');
  addRepo(db, 'kelvin/other');
  addPr(db, 'PR_1', 'kelvin/app', 1);
  addPr(db, 'PR_2', 'kelvin/other', 2);
  return db;
}

const rows = (db: DatabaseSync, sql: string) => db.prepare(sql).all() as Record<string, unknown>[];

describe('session_ref takes identifiers and nothing else', () => {
  it('stores a PR reference, a commit id and a branch, once each, keeping the earliest sighting', () => {
    const db = world();
    const s = addSession(db, 'a', 'kelvin/app', MERGED);
    const first = writeSessionRefs(db, s, [
      { kind: 'pr_url', value: 'kelvin/app#1', observedAt: 2000 },
      { kind: 'commit', value: '1111111aaaaaaa', observedAt: 2000 },
      { kind: 'branch', value: 'feature/1', observedAt: 2000 },
    ]);
    expect(first).toEqual({ stored: 3, rejected: 0 });
    // the same identifiers again, earlier and later: one row each, observed_at is the earliest
    writeSessionRefs(db, s, [
      { kind: 'pr_url', value: 'kelvin/app#1', observedAt: 1000 },
      { kind: 'commit', value: '1111111aaaaaaa', observedAt: 9000 },
    ]);
    expect(rows(db, 'SELECT kind, value, observed_at FROM session_ref ORDER BY kind')).toEqual([
      { kind: 'branch', value: 'feature/1', observed_at: 2000 },
      { kind: 'commit', value: '1111111aaaaaaa', observed_at: 2000 },
      { kind: 'pr_url', value: 'kelvin/app#1', observed_at: 1000 },
    ]);
  });

  it('refuses anything that is not the shape of an identifier, counts it, and stores no byte of it', () => {
    const db = world();
    const s = addSession(db, 'a', 'kelvin/app', MERGED);
    const SENTINEL = 'SENTINEL_BODY_TEXT_please_open_https://github.com/kelvin/app/pull/1_now';
    const result = writeSessionRefs(db, s, [
      { kind: 'pr_url', value: SENTINEL, observedAt: 1 },
      { kind: 'pr_url', value: 'Kelvin/App#1', observedAt: 1 }, // not lowercase: the scan lowercases before it stores
      { kind: 'pr_url', value: 'kelvin/app#0', observedAt: 1 },
      { kind: 'pr_url', value: 'kelvin/app#12345678', observedAt: 1 },
      { kind: 'commit', value: 'ABCDEF1', observedAt: 1 },
      { kind: 'commit', value: 'abcdef', observedAt: 1 }, // 6 characters
      { kind: 'commit', value: `${'a'.repeat(41)}`, observedAt: 1 },
      { kind: 'branch', value: 'a branch with spaces', observedAt: 1 },
      { kind: 'branch', value: SENTINEL, observedAt: 1 },
      { kind: 'branch', value: 'x'.repeat(201), observedAt: 1 },
      { kind: 'commit', value: 'abcdef1', observedAt: Number.NaN },
    ]);
    expect(result).toEqual({ stored: 0, rejected: 11 });
    expect(rows(db, 'SELECT * FROM session_ref')).toEqual([]);
    // a search of the whole database for the body text finds nothing
    for (const { name } of rows(db, "SELECT name FROM sqlite_master WHERE type = 'table'") as {
      name: string;
    }[]) {
      expect(JSON.stringify(rows(db, `SELECT * FROM "${name}"`)), name).not.toContain(
        'SENTINEL_BODY',
      );
    }
  });

  it('knows each kind’s shape', () => {
    expect(isRefIdentifier('pr_url', 'kelvin/app#12')).toBe(true);
    expect(isRefIdentifier('pr_url', 'https://github.com/kelvin/app/pull/12')).toBe(false);
    expect(isRefIdentifier('commit', 'abcdef1')).toBe(true);
    expect(isRefIdentifier('commit', 'abcdef')).toBe(false);
    expect(isRefIdentifier('branch', 'feature/x-1.2')).toBe(true);
    expect(isRefIdentifier('branch', '-rf')).toBe(false);
  });

  it('is written inside the caller’s transaction: a file that fails to commit leaves no reference', () => {
    const db = world();
    const s = addSession(db, 'a', 'kelvin/app', MERGED);
    expect(() =>
      inTransaction(db, () => {
        writeSessionRefs(db, s, [{ kind: 'commit', value: 'abcdef1', observedAt: 1 }]);
        throw new Error('the file did not commit');
      }),
    ).toThrow('did not commit');
    expect(rows(db, 'SELECT * FROM session_ref')).toEqual([]);
  });
});

describe('readLinkInputs', () => {
  it('returns every PR with its commits, every session and every identifier', () => {
    const db = world();
    const s = addSession(db, 'a', 'kelvin/app', MERGED);
    writeSessionRefs(db, s, [{ kind: 'pr_url', value: 'kelvin/app#1', observedAt: 5 }]);
    const input = readLinkInputs(db);
    expect(
      input.prs.map((p) => [p.nodeId, p.repoId, p.number, p.headRef, p.mergeCommitSha]),
    ).toEqual(
      expect.arrayContaining([
        ['PR_1', 'kelvin/app', 1, 'feature/1', 'abcdef1234567890'],
        ['PR_2', 'kelvin/other', 2, 'feature/2', 'abcdef1234567890'],
      ]),
    );
    expect(input.prs.find((p) => p.nodeId === 'PR_1')?.commits.sort()).toEqual([
      '1111111aaaaaaa',
      '2222222bbbbbbb',
    ]);
    expect(input.sessions).toEqual([
      {
        id: s,
        provider: 'claude',
        repoId: 'kelvin/app',
        gitBranch: 'feature/1',
        startedAt: MERGED - HOUR,
        lastEventAt: MERGED,
      },
    ]);
    expect(input.refs).toEqual([
      { sessionId: s, kind: 'pr_url', value: 'kelvin/app#1', observedAt: 5 },
    ]);
  });
});

describe('replaceComputedLinks: a refresh rebuilds the computed table and never touches a decision', () => {
  it('replaces every computed row with the new computation and leaves owner decisions exactly as they were', () => {
    const db = world();
    const a = addSession(db, 'a', 'kelvin/app', MERGED);
    const b = addSession(db, 'b', 'kelvin/app', MERGED - HOUR);
    replaceComputedLinks(
      db,
      [link('PR_1', a, 'evidence', 'pr_reference'), link('PR_1', b, 'suggested', 'same_branch')],
      100,
    );
    changeDecision(db, 'PR_1', b, 150, () => ({
      kind: 'set',
      decision: 'confirmed',
      priorClass: 'suggested',
      priorBasis: 'same_branch',
    }));
    changeDecision(db, 'PR_1', a, 160, () => ({
      kind: 'set',
      decision: 'rejected',
      priorClass: 'evidence',
      priorBasis: 'pr_reference',
    }));
    const decisions = rows(db, 'SELECT * FROM owner_link_decision ORDER BY session_id');

    // a refresh that now finds a different set (b's suggestion is gone, a new one for a third session appears)
    const c = addSession(db, 'c', 'kelvin/app', MERGED - 2 * HOUR);
    expect(replaceComputedLinks(db, [link('PR_1', c, 'suggested', 'same_repo_window')], 200)).toBe(
      1,
    );

    expect(
      rows(db, 'SELECT pr_node_id, session_id, class, basis, computed_at FROM pr_session_link'),
    ).toEqual([
      {
        pr_node_id: 'PR_1',
        session_id: c,
        class: 'suggested',
        basis: 'same_repo_window',
        computed_at: 200,
      },
    ]);
    expect(rows(db, 'SELECT * FROM owner_link_decision ORDER BY session_id')).toEqual(decisions);
    // and an empty computation empties the table, still without touching a decision
    expect(replaceComputedLinks(db, [], 300)).toBe(0);
    expect(rows(db, 'SELECT * FROM owner_link_decision ORDER BY session_id')).toEqual(decisions);
  });

  it('keeps the evidence row when a pair is given as both evidence and a suggestion, in either order', () => {
    const db = world();
    const a = addSession(db, 'a', 'kelvin/app', MERGED);
    replaceComputedLinks(
      db,
      [link('PR_1', a, 'suggested', 'same_branch'), link('PR_1', a, 'evidence', 'commit_match')],
      1,
    );
    expect(rows(db, 'SELECT class, basis FROM pr_session_link')).toEqual([
      { class: 'evidence', basis: 'commit_match' },
    ]);
    replaceComputedLinks(
      db,
      [link('PR_1', a, 'evidence', 'pr_reference'), link('PR_1', a, 'suggested', 'same_branch')],
      2,
    );
    expect(rows(db, 'SELECT class, basis FROM pr_session_link')).toEqual([
      { class: 'evidence', basis: 'pr_reference' },
    ]);
  });

  it('is all or nothing: a class with the wrong basis throws before anything changes, and a failure part-way rolls back', () => {
    const db = world();
    const a = addSession(db, 'a', 'kelvin/app', MERGED);
    const b = addSession(db, 'b', 'kelvin/app', MERGED);
    replaceComputedLinks(db, [link('PR_1', a, 'evidence', 'pr_reference')], 1);
    const before = rows(db, 'SELECT * FROM pr_session_link');

    expect(() =>
      replaceComputedLinks(db, [link('PR_1', b, 'suggested', 'commit_match')], 2),
    ).toThrow(TypeError);
    expect(rows(db, 'SELECT * FROM pr_session_link')).toEqual(before);

    // a row the STRICT table refuses (a fractional session id) fails after the old rows were deleted: the delete is rolled back
    expect(() =>
      replaceComputedLinks(
        db,
        [
          link('PR_1', b, 'suggested', 'same_branch'),
          link('PR_1', 1.5, 'suggested', 'same_branch'),
        ],
        3,
      ),
    ).toThrow();
    expect(db.isTransaction).toBe(false);
    expect(rows(db, 'SELECT * FROM pr_session_link')).toEqual(before);
  });
});

describe('changeDecision: one decision, one transaction', () => {
  it('reads the pair, lets the rule decide, writes the decision, and returns the pair before and after', () => {
    const db = world();
    const a = addSession(db, 'a', 'kelvin/app', MERGED);
    replaceComputedLinks(db, [link('PR_1', a, 'suggested', 'same_repo_window')], 1);
    const seen: unknown[] = [];
    const { before, after } = changeDecision(db, 'PR_1', a, 500, (state) => {
      seen.push(state);
      return {
        kind: 'set',
        decision: 'confirmed',
        priorClass: state.computed?.class ?? null,
        priorBasis: state.computed?.basis ?? null,
      };
    });
    expect(seen).toHaveLength(1);
    expect(before.computed).toEqual({ class: 'suggested', basis: 'same_repo_window' });
    expect(before.decision).toBeNull();
    expect(before.pr).toMatchObject({
      nodeId: 'PR_1',
      repoId: 'kelvin/app',
      number: 1,
      mergedAt: MERGED,
    });
    expect(before.session).toMatchObject({ id: a, repoId: 'kelvin/app' });
    expect(after.decision).toEqual({
      decision: 'confirmed',
      priorClass: 'suggested',
      priorBasis: 'same_repo_window',
      decidedAt: 500,
    });
    expect(db.isTransaction).toBe(false);
  });

  it('upserts: a second decision for the pair replaces the first and never adds a row; clear deletes it', () => {
    const db = world();
    const a = addSession(db, 'a', 'kelvin/app', MERGED);
    changeDecision(db, 'PR_1', a, 1, () => ({
      kind: 'set',
      decision: 'confirmed',
      priorClass: null,
      priorBasis: null,
    }));
    changeDecision(db, 'PR_1', a, 2, () => ({
      kind: 'set',
      decision: 'rejected',
      priorClass: 'evidence',
      priorBasis: 'pr_reference',
    }));
    expect(rows(db, 'SELECT decision, prior_class, decided_at FROM owner_link_decision')).toEqual([
      { decision: 'rejected', prior_class: 'evidence', decided_at: 2 },
    ]);
    const { after } = changeDecision(db, 'PR_1', a, 3, () => ({ kind: 'clear' }));
    expect(after.decision).toBeNull();
    expect(rows(db, 'SELECT * FROM owner_link_decision')).toEqual([]);
    // clearing what is not there is fine: it is the same state
    expect(() => changeDecision(db, 'PR_1', a, 4, () => ({ kind: 'clear' }))).not.toThrow();
  });

  it('keep writes nothing', () => {
    const db = world();
    const a = addSession(db, 'a', 'kelvin/app', MERGED);
    const { before, after } = changeDecision(db, 'PR_1', a, 1, () => ({ kind: 'keep' }));
    expect(after).toEqual(before);
    expect(rows(db, 'SELECT * FROM owner_link_decision')).toEqual([]);
  });

  it('a rule that refuses by throwing leaves no decision and no open transaction', () => {
    const db = world();
    const a = addSession(db, 'a', 'kelvin/app', MERGED);
    expect(() =>
      changeDecision(db, 'PR_1', a, 1, () => {
        throw new RangeError('not allowed from this state');
      }),
    ).toThrow('not allowed');
    expect(rows(db, 'SELECT * FROM owner_link_decision')).toEqual([]);
    expect(db.isTransaction).toBe(false);
  });

  it('says so when the PR or the session does not exist', () => {
    const db = world();
    const a = addSession(db, 'a', 'kelvin/app', MERGED);
    expect(readPair(db, 'PR_NONE', a).pr).toBeNull();
    expect(readPair(db, 'PR_1', 9999).session).toBeNull();
  });
});

describe('readEvidenceRows', () => {
  it('returns the computed links and the owner’s manual links for one PR, with each session’s tokens over all its events', () => {
    const db = world();
    const a = addSession(db, 'a', 'kelvin/app', MERGED, { tokens: 1200 });
    const b = addSession(db, 'b', 'kelvin/app', MERGED - HOUR);
    const manual = addSession(db, 'manual', 'kelvin/app', MERGED - 2 * HOUR, { tokens: 50 });
    const elsewhere = addSession(db, 'elsewhere', 'kelvin/other', MERGED);
    db.prepare(
      `INSERT INTO usage_event (provider, dedupe_key, session_id, occurred_at, model, provider_total) VALUES ('claude', 'a:e2', ?, ?, 'model-x', 300)`,
    ).run(a, MERGED - 40 * DAY); // long before the PR: still the session's own total
    replaceComputedLinks(
      db,
      [
        link('PR_1', a, 'evidence', 'pr_reference'),
        link('PR_1', b, 'suggested', 'same_branch'),
        link('PR_2', elsewhere, 'evidence', 'commit_match'),
      ],
      1,
    );
    changeDecision(db, 'PR_1', b, 2, () => ({
      kind: 'set',
      decision: 'dismissed',
      priorClass: 'suggested',
      priorBasis: 'same_branch',
    }));
    changeDecision(db, 'PR_1', manual, 3, () => ({
      kind: 'set',
      decision: 'confirmed',
      priorClass: null,
      priorBasis: null,
    }));

    const items = readEvidenceRows(db, 'PR_1').sort((x, y) => x.session.id - y.session.id);
    expect(
      items.map((i) => [
        i.session.id,
        i.computed?.class ?? null,
        i.decision?.decision ?? null,
        i.session.tokens,
      ]),
    ).toEqual([
      [a, 'evidence', null, 1500],
      [b, 'suggested', 'dismissed', 0],
      [manual, null, 'confirmed', 50],
    ]);
    expect(readEvidenceRows(db, 'PR_NONE')).toEqual([]);
    expect(readEvidenceRows(db, 'PR_2').map((i) => i.session.id)).toEqual([elsewhere]);
  });
});

describe('readCandidateRows', () => {
  const window = { fromMs: MERGED - 3 * DAY, toMs: MERGED };

  it('offers same-repo sessions active in the window, most recent first, and nothing already listed', () => {
    const db = world();
    const recent = addSession(db, 'recent', 'kelvin/app', MERGED - HOUR);
    const older = addSession(db, 'older', 'kelvin/app', MERGED - 2 * DAY);
    const tooOld = addSession(db, 'tooOld', 'kelvin/app', MERGED - 4 * DAY);
    const startedAfter = addSession(db, 'startedAfter', 'kelvin/app', MERGED + 2 * HOUR, {
      startedAt: MERGED + HOUR,
    });
    const spans = addSession(db, 'spans', 'kelvin/app', MERGED + DAY, {
      startedAt: MERGED - 5 * DAY,
    });
    const otherRepo = addSession(db, 'otherRepo', 'kelvin/other', MERGED - HOUR);
    const noRepo = addSession(db, 'noRepo', null, MERGED - HOUR);
    const ids = readCandidateRows(db, 'PR_1', window, 30).map((s) => s.id);
    expect(ids).toEqual([recent, older, spans].sort((x, y) => ids.indexOf(x) - ids.indexOf(y)));
    expect(ids).toContain(spans); // started before the merge and still running after it: active in the window
    expect(ids.slice(0, 2)).toEqual([spans, recent]); // spans' last event is the latest
    for (const excluded of [tooOld, startedAfter, otherRepo, noRepo])
      expect(ids).not.toContain(excluded);
    expect(readCandidateRows(db, 'PR_1', window, 1)).toHaveLength(1);
    expect(readCandidateRows(db, 'PR_NONE', window, 30)).toEqual([]);
  });

  it('leaves out sessions already listed (a computed link, a confirmed or a rejected decision) but offers a dismissed suggestion again', () => {
    const db = world();
    const listed = addSession(db, 'listed', 'kelvin/app', MERGED - HOUR);
    const owner = addSession(db, 'owner', 'kelvin/app', MERGED - HOUR);
    const struck = addSession(db, 'struck', 'kelvin/app', MERGED - HOUR);
    const dismissed = addSession(db, 'dismissed', 'kelvin/app', MERGED - HOUR);
    const free = addSession(db, 'free', 'kelvin/app', MERGED - HOUR);
    replaceComputedLinks(
      db,
      [
        link('PR_1', listed, 'suggested', 'same_repo_window'),
        link('PR_1', struck, 'evidence', 'pr_reference'),
        link('PR_1', dismissed, 'suggested', 'same_branch'),
      ],
      1,
    );
    changeDecision(db, 'PR_1', owner, 2, () => ({
      kind: 'set',
      decision: 'confirmed',
      priorClass: null,
      priorBasis: null,
    }));
    changeDecision(db, 'PR_1', struck, 3, () => ({
      kind: 'set',
      decision: 'rejected',
      priorClass: 'evidence',
      priorBasis: 'pr_reference',
    }));
    changeDecision(db, 'PR_1', dismissed, 4, () => ({
      kind: 'set',
      decision: 'dismissed',
      priorClass: 'suggested',
      priorBasis: 'same_branch',
    }));
    expect(
      readCandidateRows(db, 'PR_1', window, 30)
        .map((s) => s.id)
        .sort(),
    ).toEqual([dismissed, free].sort());
  });
});
