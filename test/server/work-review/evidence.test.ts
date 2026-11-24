import { describe, expect, it } from 'vitest';
import { recordComputedLinksSuccess } from '../../../src/server/db/queries/link-health.ts';
import { setMeta } from '../../../src/server/db/queries/meta.ts';
import { readWorkNotes, saveWorkNotes } from '../../../src/server/db/queries/work-review.ts';
import { collectWorkReviewEvidence } from '../../../src/server/services/work-review/evidence.ts';
import type { Scope } from '../../../src/shared/contracts/common.ts';
import { NOW, TZ, memoryDb } from '../helpers.ts';
import { addEvent, addRepo, addSession, at } from '../usage/helpers.ts';

const repo = 'example/desk';
const date = '2026-11-03';
const afterMidnightUtc = at(date, '23:50');
const scope: Scope = {
  start: '2026-11-02',
  end: '2026-11-08',
  gran: 'day',
  repos: [repo],
  provider: 'all',
  author: 'mine',
  timezone: TZ,
};

describe('stored Work Review evidence', () => {
  it('scopes distinct delivery and session-day progress independently, using effective links and report dates', () => {
    const db = memoryDb();
    try {
      addRepo(db, repo);
      addRepo(db, 'elsewhere/desk');
      db.prepare("INSERT INTO app_meta VALUES ('github_login', 'Owner')").run();
      for (const [id, author, repository] of [
        ['mine', 'owner', repo],
        ['their', 'other', repo],
        ['outside', 'owner', 'elsewhere/desk'],
      ] as const) {
        db.prepare(
          `INSERT INTO pull_request (node_id, repo_id, number, title, url, author_login, merged_at, merged_by_login)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'owner')`,
        ).run(
          id,
          repository,
          id === 'their' ? 2 : 1,
          id,
          `https://github.com/${repository}`,
          author,
          afterMidnightUtc,
        );
      }
      for (const id of [1, 2, 3, 4, 5]) {
        addSession(db, {
          id,
          provider: id === 2 ? 'claude' : 'codex',
          kind: id === 2 || id === 3 ? 'child' : 'root',
          parent: id === 2 ? 1 : id === 3 ? 2 : null,
          repo: id === 5 ? 'elsewhere/desk' : repo,
          name: id === 4 ? 'Research styles' : null,
          startedAt: at(date),
        });
        addEvent(db, { session: id, at: afterMidnightUtc });
      }
      addEvent(db, { session: 1, at: at(date, '23:51') });
      addEvent(db, { session: 1, at: at('2026-11-04', '00:01') });
      addEvent(db, { session: 1, at: at('2026-11-09') });
      db.exec(`INSERT INTO pr_session_link VALUES
                 ('mine', 1, 'evidence', 'pr_reference', 1),
                 ('mine', 2, 'suggested', 'same_repo_window', 1),
                 ('mine', 3, 'evidence', 'pr_reference', 1),
                 ('mine', 4, 'suggested', 'same_repo_window', 1),
                 ('their', 3, 'evidence', 'commit_match', 1),
                 ('their', 5, 'evidence', 'pr_reference', 1),
                 ('outside', 1, 'evidence', 'pr_reference', 1);
               INSERT INTO owner_link_decision VALUES
                 ('mine', 2, 'confirmed', 'suggested', 'same_repo_window', 1),
                 ('mine', 3, 'rejected', 'evidence', 'pr_reference', 1);`);
      const missingLinks = collectWorkReviewEvidence(db, scope, NOW);
      expect(missingLinks.sessionDays[0]?.linkedPrIds).toEqual([]);
      expect(missingLinks.sessionDays[1]?.linkedPrIds).toEqual(['mine']);

      recordComputedLinksSuccess(db, NOW);
      const evidence = collectWorkReviewEvidence(db, scope, NOW);
      expect(evidence.prs).toMatchObject([{ id: 'mine', mine: true, author: 'owner', date }]);
      expect(evidence.sessionDays).toMatchObject([
        { sessionId: 1, date, group: '1', linkedPrIds: ['mine'] },
        { sessionId: 2, date, group: '1', linkedPrIds: ['mine'] },
        { sessionId: 3, date, group: '1', linkedPrIds: [] },
        { sessionId: 4, date, group: '4', title: 'Research styles', linkedPrIds: [] },
        { sessionId: 1, date: '2026-11-04', group: '1', linkedPrIds: ['mine'] },
      ]);

      const team = collectWorkReviewEvidence(
        db,
        { ...scope, author: 'all', provider: 'codex' },
        NOW,
      );
      expect(team.prs).toMatchObject([
        { id: 'their', mine: false, author: 'other' },
        { id: 'mine', mine: true },
      ]);
      expect(team.sessionDays.map(({ sessionId }) => sessionId)).toEqual([1, 3, 4, 1]);
      expect(team.sessionDays.find(({ sessionId }) => sessionId === 3)?.linkedPrIds).toEqual([
        'their',
      ]);
      expect(team.sessionDays[0]?.fingerprint).toBe(evidence.sessionDays[0]?.fingerprint);
      setMeta(db, 'links_dirty', '1');
      const staleLinks = collectWorkReviewEvidence(db, scope, NOW);
      expect(staleLinks.sessionDays[0]?.linkedPrIds).toEqual([]);
      expect(staleLinks.sessionDays[1]?.linkedPrIds).toEqual(['mine']);
      expect(staleLinks.coverage).toContain(
        'Computed pull request associations are awaiting verification. Owner confirmations still apply.',
      );
    } finally {
      db.close();
    }
  });

  it('invalidates the changed activity day only and leaves cached notes reusable after transcript loss', () => {
    const db = memoryDb();
    try {
      addRepo(db, repo);
      addSession(db, { id: 1, repo, startedAt: at(date) });
      addEvent(db, { session: 1, at: afterMidnightUtc });
      addEvent(db, { session: 1, at: at('2026-11-04', '00:01') });
      db.exec(`INSERT INTO source_file (id, source_id, path, size, mtime_ms, head_hash, read_offset, state)
               VALUES (1, 'codex', '/does-not-exist/imported.jsonl', 10, 1, 'old', 10, 'ok');
               UPDATE usage_event SET source_file_id=1;`);
      const before = collectWorkReviewEvidence(db, scope, NOW);
      expect(before.sessionDays[0]?.transcript.files[0]).toMatchObject({ size: 10 });
      for (const unit of before.sessionDays) {
        saveWorkNotes(
          db,
          unit.cacheKey,
          unit.fingerprint,
          unit.sourceHash,
          at(unit.date, '00:00'),
          [],
          false,
        );
      }

      db.exec(`UPDATE source_file SET size=100, mtime_ms=2, read_offset=100, head_hash='new';
               UPDATE source_file SET state='unreadable';`);
      const afterLoss = collectWorkReviewEvidence(db, scope, NOW);
      expect(afterLoss.fingerprint).toBe(before.fingerprint);
      expect(afterLoss.sessionDays[0]?.transcript.files).toEqual([null]);

      addEvent(db, { session: 1, at: at('2026-11-04', '01:01') });
      const afterWork = collectWorkReviewEvidence(db, scope, NOW);
      expect(afterWork.fingerprint).not.toBe(before.fingerprint);
      expect(afterWork.sessionDays[0]?.fingerprint).toBe(before.sessionDays[0]?.fingerprint);
      expect(afterWork.sessionDays[1]?.fingerprint).not.toBe(before.sessionDays[1]?.fingerprint);
    } finally {
      db.close();
    }
  });

  it('refreshes live or recovered source evidence without re-reading complete historical notes', () => {
    const db = memoryDb();
    try {
      const today = '2026-11-04';
      addRepo(db, repo);
      addSession(db, { id: 1, repo, startedAt: at(date) });
      addSession(db, { id: 2, repo, startedAt: at(date) });
      addEvent(db, { session: 1, at: afterMidnightUtc });
      addEvent(db, { session: 1, at: at(today, '00:01') });
      addEvent(db, { session: 2, at: afterMidnightUtc });
      db.exec(`INSERT INTO source_file (id, source_id, path, size, mtime_ms, head_hash, read_offset, state) VALUES
                 (1, 'codex', '/first.jsonl', 100, ${at(date)}, 'first', 100, 'ok'),
                 (2, 'codex', '/second.jsonl', 100, ${at(date)}, 'other', 0, 'unreadable');
               UPDATE usage_event SET source_file_id=session_id;`);
      const firstReport = collectWorkReviewEvidence(db, scope, NOW);
      const [historical, missing, live] = firstReport.sessionDays;
      for (const unit of firstReport.sessionDays) {
        saveWorkNotes(
          db,
          unit.cacheKey,
          unit.fingerprint,
          unit.sourceHash,
          at(unit.date, '00:00'),
          [],
          unit === missing,
        );
      }
      expect(collectWorkReviewEvidence(db, scope, NOW).fingerprint).toBe(firstReport.fingerprint);
      db.exec(`UPDATE source_file SET size=140, read_offset=140, mtime_ms=${at(today)} WHERE id=1;
               UPDATE source_file SET state='ok', read_offset=100 WHERE id=2;`);
      const next = collectWorkReviewEvidence(db, scope, NOW);
      expect(next.fingerprint).not.toBe(firstReport.fingerprint);
      expect(next.sessionDays[0]?.sourceHash).toBe(historical!.sourceHash);
      expect(next.sessionDays[1]?.sourceHash).not.toBe(missing!.sourceHash);
      expect(next.sessionDays[2]?.sourceHash).not.toBe(live!.sourceHash);
      expect(next.sessionDays.map(({ fingerprint }) => fingerprint)).toEqual(
        firstReport.sessionDays.map(({ fingerprint }) => fingerprint),
      );
      expect(
        readWorkNotes(
          db,
          next.sessionDays[0]!.cacheKey,
          historical!.fingerprint,
          historical!.sourceHash,
        )?.partial,
      ).toBe(false);
      expect(
        readWorkNotes(
          db,
          next.sessionDays[1]!.cacheKey,
          missing!.fingerprint,
          next.sessionDays[1]!.sourceHash,
        ),
      ).toBeNull();

      const month = collectWorkReviewEvidence(
        db,
        { ...scope, start: '2026-11-01', end: '2026-11-30' },
        NOW,
      );
      for (const unit of month.sessionDays) {
        saveWorkNotes(
          db,
          unit.cacheKey,
          unit.fingerprint,
          unit.sourceHash,
          at(unit.date, '00:00'),
          [],
          false,
        );
      }
      expect(collectWorkReviewEvidence(db, scope, NOW).fingerprint).toBe(next.fingerprint);
      expect(collectWorkReviewEvidence(db, scope, at('2026-11-05')).fingerprint).toBe(
        next.fingerprint,
      );
    } finally {
      db.close();
    }
  });
});
