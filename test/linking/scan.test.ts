import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractRefs } from '../../scripts/experiments/e5-evidence.ts';
import {
  MAX_REFS_PER_KIND,
  createRefCollector,
  scanLine,
} from '../../src/server/collectors/evidence/index.ts';
import { writeSessionRefs } from '../../src/server/db/queries/links.ts';
import { addRepo, addSession, memoryDb, rows } from './world.ts';

// Evidence extraction (G8_2, P-31): the scan is pure, finds only identifiers, and no other substring of a line reaches the
// collector's output or the database. Fixtures are the invented E5 transcripts (SENTINEL_* marks text that must never be kept).

const SHA = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';

describe('scanLine', () => {
  const cases: [string, string, { prs: string[]; commits: string[] }][] = [
    [
      'a PR URL, lowercased',
      'opened https://github.com/Acme-Crew/Widgets/pull/101 for review',
      { prs: ['acme-crew/widgets#101'], commits: [] },
    ],
    [
      'the REST form of a PR',
      '"url":"https://api.github.com/repos/Acme-Crew/Widgets/pulls/102"',
      { prs: ['acme-crew/widgets#102'], commits: [] },
    ],
    [
      'a PR URL followed by a path or a fragment',
      'see https://github.com/o/n/pull/5/files and https://github.com/o/n/pull/6#issuecomment-1',
      { prs: ['o/n#5', 'o/n#6'], commits: [] },
    ],
    [
      'the same PR twice, once',
      'https://github.com/o/n/pull/5 https://github.com/o/n/pull/5',
      { prs: ['o/n#5'], commits: [] },
    ],
    [
      'git’s commit summary',
      '[main (root-commit) 1a2b3c4] first\\n[feature/x-1 abcdef0123456789] more',
      { prs: [], commits: ['1a2b3c4', 'abcdef0123456789'] },
    ],
    [
      'a detached HEAD commit summary',
      '[detached HEAD 9f8e7d6c] fix',
      { prs: [], commits: ['9f8e7d6c'] },
    ],
    [
      'a 40-hex git rev-parse result in a tool result',
      `{"content":"${SHA}\\n"}`,
      { prs: [], commits: [SHA] },
    ],
    [
      'an issue URL, a run id and a 64-hex string are not evidence',
      `https://github.com/o/n/issues/9 run ${SHA}${SHA.slice(0, 24)} and "${SHA}${SHA.slice(0, 24)}"`,
      { prs: [], commits: [] },
    ],
    [
      'a PR number the store would refuse (leading zero, more than 7 digits)',
      'https://github.com/o/n/pull/007 https://github.com/o/n/pull/12345678 https://github.com/o/n/pull/0',
      { prs: [], commits: [] },
    ],
    [
      'the largest accepted PR number',
      'https://github.com/o/n/pull/9999999',
      { prs: ['o/n#9999999'], commits: [] },
    ],
    [
      'a non-TLS or look-alike host',
      'http://github.com/o/n/pull/1 https://github.com.evil.example/o/n/pull/2 https://notgithub.com/o/n/pull/3',
      { prs: [], commits: [] },
    ],
  ];
  it.each(cases)('finds %s', (_name, line, expected) => {
    expect(scanLine(line)).toEqual(expected);
  });

  it('yields nothing, without throwing, for a value that is not text', () => {
    for (const value of [undefined, null, 42, {}, [], '', 'x', Symbol('s'), () => 1]) {
      expect(scanLine(value)).toEqual({ prs: [], commits: [] });
    }
  });

  it('returns the same identifiers as the experiment’s extractRefs over every fixture line (PR numbers without a leading zero)', () => {
    const root = join(import.meta.dirname, '../fixtures/github/evidence');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.jsonl')) files.push(path);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThanOrEqual(4);
    let found = 0;
    for (const file of files) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const expected = extractRefs(line);
        const actual = scanLine(line);
        expect(actual.prs.sort()).toEqual(expected.prs.sort());
        expect(actual.commits.sort()).toEqual(expected.commits.sort());
        found += actual.prs.length + actual.commits.length;
      }
    }
    expect(found).toBeGreaterThan(0);
  });

  it('keeps no other substring: the output of a line with bodies and secrets is identifiers and nothing else', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: `SENTINEL_BODY_TEXT token=SENTINEL_TOKEN_x9 opened https://github.com/Acme/Widgets/pull/9?secret=SENTINEL_QUERY and [main 1a2b3c4] SENTINEL_SUBJECT`,
          },
        ],
      },
    });
    const out = scanLine(line);
    expect(out).toEqual({ prs: ['acme/widgets#9'], commits: ['1a2b3c4'] });
    expect(JSON.stringify(out)).not.toMatch(/SENTINEL/);
  });

  it('stays fast on a very long line that nearly matches every pattern', () => {
    const near =
      'https://github.com/' +
      'a'.repeat(5000) +
      '/' +
      'b'.repeat(5000) +
      '/pul ' +
      '[' +
      'a'.repeat(5000);
    const line = `${near.repeat(40)} ${'0123456789abcdef'.repeat(4000)}`;
    const started = performance.now();
    scanLine(line);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('createRefCollector', () => {
  it('collects PR references and commit ids from lines and branches from metadata, each once, earliest sighting kept', () => {
    const c = createRefCollector();
    c.addLine('opened https://github.com/o/n/pull/5 [main 1a2b3c4] x', 5000);
    c.addLine('again https://github.com/o/n/pull/5 [main 1a2b3c4] x', 1000);
    c.addLine('later https://github.com/o/n/pull/5', 9000);
    c.addBranch('feature/x', 4000);
    c.addBranch('feature/x', 3000);
    expect(c.refs()).toEqual([
      { kind: 'pr_url', value: 'o/n#5', observedAt: 1000 },
      { kind: 'commit', value: '1a2b3c4', observedAt: 1000 },
      { kind: 'branch', value: 'feature/x', observedAt: 3000 },
    ]);
  });

  it('takes a branch from metadata only: a branch-looking word in text is not one', () => {
    const c = createRefCollector();
    c.addLine('git checkout -b feature/not-a-branch-ref', 1000);
    expect(c.refs()).toEqual([]);
  });

  it('drops what it cannot use: no usable time, a non-text branch, a blank or over-long branch name', () => {
    const c = createRefCollector();
    c.addLine('https://github.com/o/n/pull/5', Number.NaN);
    c.addLine('https://github.com/o/n/pull/5', Number.POSITIVE_INFINITY);
    c.addBranch(undefined, 1);
    c.addBranch(42, 1);
    c.addBranch('', 1);
    c.addBranch('x'.repeat(201), 1);
    c.addBranch('ok', Number.NaN);
    expect(c.refs()).toEqual([]);
  });

  it('keeps the first identifiers of a kind when a transcript names more than the cap, and still takes an earlier sighting of one it has', () => {
    const c = createRefCollector();
    for (let n = 1; n <= MAX_REFS_PER_KIND + 50; n += 1) {
      c.addLine(`https://github.com/o/n/pull/${n}`, 10_000 + n);
    }
    c.addLine('https://github.com/o/n/pull/1', 1);
    const prs = c.refs().filter((r) => r.kind === 'pr_url');
    expect(prs).toHaveLength(MAX_REFS_PER_KIND);
    expect(prs.find((r) => r.value === 'o/n#1')?.observedAt).toBe(1);
    expect(prs.some((r) => r.value === `o/n#${MAX_REFS_PER_KIND + 50}`)).toBe(false);
  });

  it('gives the store only identifiers: a full database search for the line text finds nothing', () => {
    const db = memoryDb();
    addRepo(db, 'kelvin/app');
    const sessionId = addSession(db, { lastEventAt: 2_000_000 });
    const c = createRefCollector();
    const lines = [
      '{"text":"SENTINEL_PROMPT_a please open https://github.com/Kelvin/App/pull/12 now"}',
      '{"content":"[feature/x 1a2b3c4d] SENTINEL_SUBJECT_b"}',
      '{"stdout":"1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d\\n","note":"SENTINEL_TOOL_RESULT_c"}',
      '{"content":"SENTINEL_ONLY_d no identifier here"}',
    ];
    for (const line of lines) c.addLine(line, 1_000_000);
    c.addBranch('feature/x', 1_000_000);
    const result = writeSessionRefs(db, sessionId, c.refs());
    expect(result).toEqual({ stored: 4, rejected: 0 });
    expect(rows(db, 'SELECT kind, value FROM session_ref ORDER BY kind, value')).toEqual([
      { kind: 'branch', value: 'feature/x' },
      { kind: 'commit', value: '1a2b3c4d' },
      { kind: 'commit', value: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d' },
      { kind: 'pr_url', value: 'kelvin/app#12' },
    ]);
    for (const { name } of rows(db, "SELECT name FROM sqlite_master WHERE type = 'table'") as {
      name: string;
    }[]) {
      expect(JSON.stringify(rows(db, `SELECT * FROM "${name}"`)), name).not.toMatch(/SENTINEL/);
    }
  });
});
