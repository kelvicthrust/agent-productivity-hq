import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_WINDOW_MS,
  MAX_SUGGESTIONS_PER_PR,
  SUGGESTION_WINDOW_MS,
  classify as classifyIndexed,
  effectiveClass,
  indexRefs,
  indexSessions,
  isCandidate,
  isLinkedClass,
  linkedClassOf,
  summarisePr,
  type EffectiveClass,
  type OwnerDecision,
  type PrForLinking,
  type RefForIndex,
  type SessionForLinking,
} from '../../src/shared/domain/linking.ts';

// classify and effectiveClass (G8_3): which sessions link to a PR and as what, and what an owner decision does to a link's class.
// Pure functions: the tests hold their inputs in plain objects, with no database.

const HOUR = 3_600_000;
const MERGED = Date.parse('2026-11-03T18:00:00Z');
const FULL = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
const MERGE_SHA = 'ffeeddccbbaa99887766554433221100ffeeddcc';

const pr = (extra: Partial<PrForLinking> = {}): PrForLinking => ({
  repoId: 'kelvin/app',
  number: 7,
  mergedAt: MERGED,
  headRef: 'feature/seven',
  mergeCommitSha: MERGE_SHA,
  commits: [FULL, '0123456789abcdef0123456789abcdef01234567'],
  ...extra,
});

let nextId = 1;
const session = (extra: Partial<SessionForLinking> = {}): SessionForLinking => {
  const id = nextId++;
  return {
    id,
    repoId: 'kelvin/app',
    gitBranch: null,
    startedAt: MERGED - 30 * HOUR,
    lastEventAt: MERGED - 10 * HOUR,
    ...extra,
  };
};

const refs = (list: Omit<RefForIndex, 'sessionId'>[], sessionId: number): RefForIndex[] =>
  list.map((ref) => ({ ...ref, sessionId }));

const classify = (
  pr: PrForLinking,
  sessions: readonly SessionForLinking[],
  refs: ReturnType<typeof indexRefs>,
) => classifyIndexed(pr, indexSessions(sessions), refs);

const summary = (links: ReturnType<typeof classify>) =>
  links.map((link) => `${link.sessionId}:${link.class}:${link.basis}`);

describe('evidence', () => {
  it('links a session that recorded the PR reference', () => {
    const s = session({ repoId: null }); // evidence does not need a recorded repo
    const index = indexRefs(refs([{ kind: 'pr_url', value: 'kelvin/app#7' }], s.id));
    expect(summary(classify(pr(), [s], index))).toEqual([`${s.id}:evidence:pr_reference`]);
  });

  it('does not take another repo’s PR with the same number, or another number, as a reference', () => {
    const s = session();
    const index = indexRefs(
      refs(
        [
          { kind: 'pr_url', value: 'other/app#7' },
          { kind: 'pr_url', value: 'kelvin/app#70' },
          { kind: 'pr_url', value: 'kelvin/app#17' },
        ],
        s.id,
      ),
    );
    // not evidence; the session still earns a suggestion by repo and time
    expect(summary(classify(pr(), [s], index))).toEqual([`${s.id}:suggested:same_repo_window`]);
  });

  it.each([
    ['the full commit id', FULL],
    ['a 7 character prefix', FULL.slice(0, 7)],
    ['a 12 character prefix', FULL.slice(0, 12)],
    ['the second commit', '0123456789abcdef0123456789abcdef01234567'],
    ['the merge commit', MERGE_SHA],
    ['a prefix of the merge commit', MERGE_SHA.slice(0, 9)],
  ])('links a session that showed %s', (_name, sha) => {
    const s = session({ repoId: null });
    const index = indexRefs(refs([{ kind: 'commit', value: sha }], s.id));
    expect(summary(classify(pr(), [s], index))).toEqual([`${s.id}:evidence:commit_match`]);
  });

  it('does not match a commit id that only starts the same way for fewer than 7 characters, or differs after 7', () => {
    const s = session({ repoId: null });
    const index = indexRefs(
      refs(
        [
          { kind: 'commit', value: FULL.slice(0, 6) },
          { kind: 'commit', value: `${FULL.slice(0, 7)}0` },
          { kind: 'commit', value: 'deadbeef' },
        ],
        s.id,
      ),
    );
    expect(classify(pr(), [s], index)).toEqual([]);
  });

  it('gives the PR reference as the basis when a session has both, and links the session once', () => {
    const s = session();
    const index = indexRefs(
      refs(
        [
          { kind: 'commit', value: FULL.slice(0, 7) },
          { kind: 'pr_url', value: 'kelvin/app#7' },
        ],
        s.id,
      ),
    );
    expect(summary(classify(pr(), [s], index))).toEqual([`${s.id}:evidence:pr_reference`]);
  });

  it('matches a PR that has no commits read yet by its merge commit alone, and one with none at all by nothing', () => {
    const s = session({ repoId: null });
    const index = indexRefs(refs([{ kind: 'commit', value: MERGE_SHA }], s.id));
    expect(summary(classify(pr({ commits: [] }), [s], index))).toEqual([
      `${s.id}:evidence:commit_match`,
    ]);
    expect(classify(pr({ commits: [], mergeCommitSha: null }), [s], index)).toEqual([]);
  });

  it('keeps every evidence session, with no cap', () => {
    const sessions = Array.from({ length: 8 }, () => session());
    const index = indexRefs(
      sessions.flatMap((s) => refs([{ kind: 'pr_url', value: 'kelvin/app#7' }], s.id)),
    );
    const links = classify(pr(), sessions, index);
    expect(links).toHaveLength(8);
    expect(new Set(links.map((l) => l.class))).toEqual(new Set(['evidence']));
  });
});

describe('suggestions', () => {
  const none = indexRefs([]);

  it('suggests a same-repo session whose last event is in the 48 hours before the merge', () => {
    const s = session({ lastEventAt: MERGED - 5 * HOUR });
    expect(summary(classify(pr(), [s], none))).toEqual([`${s.id}:suggested:same_repo_window`]);
  });

  it('includes both ends of the window and excludes a millisecond outside it', () => {
    // The window is 48 hours as TECH states it, written out here and not taken from the constant, so changing the constant fails.
    expect(SUGGESTION_WINDOW_MS).toBe(48 * HOUR);
    const edge = [session({ lastEventAt: MERGED - 48 * HOUR }), session({ lastEventAt: MERGED })];
    const outside = [
      session({ lastEventAt: MERGED - 48 * HOUR - 1 }),
      session({ lastEventAt: MERGED + 1 }),
    ];
    const ids = classify(pr(), [...edge, ...outside], none).map((l) => l.sessionId);
    expect(new Set(ids)).toEqual(new Set(edge.map((s) => s.id)));
  });

  it('never suggests a session of another repo or with no repo recorded', () => {
    const sessions = [session({ repoId: 'kelvin/other' }), session({ repoId: null })];
    expect(classify(pr(), sessions, none)).toEqual([]);
  });

  it('uses the start when a session has no last event', () => {
    const s = session({ lastEventAt: null, startedAt: MERGED - HOUR });
    expect(classify(pr(), [s], none)).toHaveLength(1);
  });

  it('says same_branch when the session’s branch, or any branch it worked on, is the PR’s head branch', () => {
    const byMeta = session({ gitBranch: 'feature/seven' });
    const byRef = session();
    const other = session({ gitBranch: 'feature/eight' });
    const index = indexRefs(refs([{ kind: 'branch', value: 'feature/seven' }], byRef.id));
    expect(summary(classify(pr(), [byMeta, byRef, other], index)).sort()).toEqual(
      [
        `${byMeta.id}:suggested:same_branch`,
        `${byRef.id}:suggested:same_branch`,
        `${other.id}:suggested:same_repo_window`,
      ].sort(),
    );
  });

  it('has no same_branch for a PR with no head branch', () => {
    const s = session({ gitBranch: 'feature/seven' });
    expect(summary(classify(pr({ headRef: null }), [s], none))).toEqual([
      `${s.id}:suggested:same_repo_window`,
    ]);
  });

  it(`keeps at most ${MAX_SUGGESTIONS_PER_PR} suggestions, the most recently active first`, () => {
    const sessions = [1, 2, 3, 4, 5].map((n) => session({ lastEventAt: MERGED - n * HOUR }));
    const links = classify(pr(), sessions, none);
    expect(links.map((l) => l.sessionId)).toEqual([
      sessions[0]!.id,
      sessions[1]!.id,
      sessions[2]!.id,
    ]);
  });

  it('breaks a tie on activity by the higher session id', () => {
    const sessions = [1, 2, 3, 4].map(() => session({ lastEventAt: MERGED - 2 * HOUR }));
    const ids = classify(pr(), sessions, none).map((l) => l.sessionId);
    expect(ids).toEqual([sessions[3]!.id, sessions[2]!.id, sessions[1]!.id]);
  });

  it('suggests only sessions that gave no evidence, and the evidence ones do not use up the three', () => {
    const evidence = session({ lastEventAt: MERGED - HOUR });
    const near = [1, 2, 3, 4].map((n) => session({ lastEventAt: MERGED - (n + 1) * HOUR }));
    const index = indexRefs(refs([{ kind: 'pr_url', value: 'kelvin/app#7' }], evidence.id));
    const links = classify(pr(), [evidence, ...near], index);
    expect(links[0]).toEqual({ sessionId: evidence.id, class: 'evidence', basis: 'pr_reference' });
    expect(links.filter((l) => l.class === 'suggested')).toHaveLength(MAX_SUGGESTIONS_PER_PR);
    expect(links.filter((l) => l.sessionId === evidence.id)).toHaveLength(1);
  });
});

describe('candidates for "Link a session"', () => {
  const target = { repoId: 'kelvin/app', mergedAt: MERGED };

  it('are same-repo sessions active at some point in the 3 days up to the merge', () => {
    expect(CANDIDATE_WINDOW_MS).toBe(72 * HOUR);
    const at = (lastEventAt: number | null, startedAt = lastEventAt ?? 0, repoId = 'kelvin/app') =>
      isCandidate(target, { repoId, startedAt, lastEventAt });
    expect(at(MERGED - CANDIDATE_WINDOW_MS)).toBe(true);
    expect(at(MERGED - CANDIDATE_WINDOW_MS - 1)).toBe(false);
    expect(at(MERGED - 10 * HOUR, MERGED)).toBe(true); // started at the merge
    expect(at(MERGED + HOUR, MERGED + 1)).toBe(false); // started after the merge
    expect(at(MERGED + 5 * HOUR, MERGED - 5 * HOUR)).toBe(true); // spans the merge
    expect(at(null, MERGED - 5 * HOUR)).toBe(true); // no last event: the start counts
    expect(at(MERGED - HOUR, MERGED - 2 * HOUR, 'kelvin/other')).toBe(false);
    expect(
      isCandidate(target, { repoId: null, startedAt: MERGED - HOUR, lastEventAt: MERGED }),
    ).toBe(false);
  });
});

describe('effectiveClass', () => {
  const table: [
    'evidence' | 'suggested' | null,
    OwnerDecision | null,
    EffectiveClass,
    string | null,
  ][] = [
    ['evidence', null, 'evidence', 'evidence'],
    ['suggested', null, 'suggested', 'suggested'],
    [null, null, 'none', null],
    ['suggested', 'confirmed', 'owner', 'owner'],
    [null, 'confirmed', 'owner', 'owner'], // a manual add has no computed claim
    ['evidence', 'confirmed', 'evidence', 'evidence'], // a confirmation never weakens an evidence claim
    ['evidence', 'rejected', 'rejected', null],
    ['suggested', 'rejected', 'rejected', null],
    [null, 'rejected', 'rejected', null],
    ['suggested', 'dismissed', 'hidden', null],
    ['evidence', 'dismissed', 'hidden', null],
    [null, 'dismissed', 'hidden', null],
  ];
  it.each(table)(
    'computed %s + decision %s is %s (listed as %s)',
    (computed, decision, effective, listed) => {
      expect(effectiveClass(computed, decision)).toBe(effective);
      expect(linkedClassOf(computed, decision)).toBe(listed);
    },
  );

  it('takes the claim as a class or as a computed link, and undefined as none', () => {
    expect(effectiveClass({ class: 'suggested' }, 'confirmed')).toBe('owner');
    expect(effectiveClass(undefined, undefined)).toBe('none');
  });
});

describe('a PR’s class counts the PR once, however many sessions link to it', () => {
  it('takes the strongest class and counts links separately from PRs', () => {
    const many: EffectiveClass[] = [
      'suggested',
      'evidence',
      'evidence',
      'owner',
      'evidence',
      'rejected',
      'hidden',
    ];
    const result = summarisePr(many);
    expect(result).toEqual({ linkClass: 'evidence', linked: 4, suggested: 1 });
    // The PR is ONE row: the class is one value, so a count of linked PRs over [that PR] is 1, not 4.
    expect([result].filter((p) => isLinkedClass(p.linkClass))).toHaveLength(1);
  });

  it.each([
    [['owner', 'suggested'], 'owner', true],
    [['suggested', 'suggested'], 'suggested', false],
    [['rejected', 'hidden', 'none'], 'unlinked', false],
    [[], 'unlinked', false],
  ] as const)('%j is %s (linked: %s)', (classes, expected, linked) => {
    const result = summarisePr(classes);
    expect(result.linkClass).toBe(expected);
    expect(isLinkedClass(result.linkClass)).toBe(linked);
  });
});
