import { join } from 'node:path';
import { UsageError } from './lib/args.ts';
import { defineExperiment, runIfMain } from './lib/cli.ts';
import { DecoderMissingError } from './lib/readonly.ts';
import { safeText } from './lib/redact.ts';
import type { ExperimentContext } from './lib/types.ts';

// E5 · Evidence availability (TECH › Feasibility experiments, data-and-sources › Evidence extraction).
//
// Reads Claude Code transcripts and Codex rollouts line by line and looks, in memory, for the two evidence kinds the
// product will store: a PR URL (`pr_url`) and a git commit SHA (`commit`). Only the matched identifier is ever held, and
// only while its session file is being read; lines are never kept, printed or written. The result is counts: how many
// sessions carry evidence for the two PRs the owner names with flags, and how many sessions carry any at all.

const DAY_MS = 86_400_000;
const NAME = '[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}';
// `https://github.com/{owner}/{name}/pull/{number}` and the REST form `api.github.com/repos/{o}/{n}/pulls/{number}`.
const PR_URL =
  /https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100})\/pull\/(\d{1,7})(?!\d)/g;
const PR_API =
  /https:\/\/api\.github\.com\/repos\/([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100})\/pulls\/(\d{1,7})(?!\d)/g;
// git's commit summary line: `[branch( extra)? sha7-40] subject`, e.g. `[main (root-commit) 1a2b3c4] …`.
const COMMIT_SUMMARY =
  /\[(?:detached HEAD|[A-Za-z0-9._/-]{1,100})(?: \([^)\]]{1,30}\))? ([0-9a-f]{7,40})\]/g;
// `git rev-parse HEAD` output: a whole 40-hex string inside a quoted tool result, ended by a quote or an escaped newline.
const BARE_SHA = /(?:"|\\n)([0-9a-f]{40})(?:"|\\n)/g;
const PR_FLAG = new RegExp(`^(${NAME})#(\\d{1,7})$`);
const PR_URL_FLAG = new RegExp(`^https://github\\.com/(${NAME})/pull/(\\d{1,7})/?$`);
const TIMESTAMP_LINE = /"timestamp"/;
/** What a retained ref must look like: the product keeps `owner/name#number` or a 7 to 40 hex SHA, nothing else. */
const RETAINED_PR = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}#\d{1,7}$/;
const RETAINED_COMMIT = /^[0-9a-f]{7,40}$/;

export interface Refs {
  prs: string[];
  commits: string[];
}

/** Pure: the PR references and commit SHAs in one line of text. Everything else in the line is ignored. */
export function extractRefs(text: string): Refs {
  const prs = new Set<string>();
  const commits = new Set<string>();
  for (const pattern of [PR_URL, PR_API])
    for (const m of text.matchAll(pattern)) prs.add(`${m[1]!.toLowerCase()}#${m[2]}`);
  for (const m of text.matchAll(COMMIT_SUMMARY)) commits.add(m[1]!);
  for (const m of text.matchAll(BARE_SHA)) commits.add(m[1]!);
  return { prs: [...prs], commits: [...commits] };
}

function parsePr(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  const m = value.match(PR_FLAG) ?? value.match(PR_URL_FLAG);
  if (!m)
    throw new UsageError(
      `--${flag} must look like owner/name#123 or a github.com pull request URL`,
    );
  return `${m[1]!.toLowerCase()}#${m[2]}`;
}

function parseCommits(ctx: ExperimentContext, flag: string): string[] {
  const commits = ctx.args
    .all(flag)
    .flatMap((v) => v.split(','))
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  for (const c of commits)
    if (!/^[0-9a-f]{7,40}$/.test(c))
      throw new UsageError(`--${flag} must be 7 to 40 hex characters`);
  return commits;
}

const splitList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Folders to read, announced one by one. Same defaults as discovery (data-and-sources › Discovery). */
function sessionFolders(ctx: ExperimentContext): { claude: string[]; codex: string[] } {
  const claudeFlag = ctx.args.all('claude-root');
  const claudeRoots = claudeFlag.length
    ? claudeFlag
    : splitList(ctx.env['CLAUDE_CONFIG_DIR']).length
      ? splitList(ctx.env['CLAUDE_CONFIG_DIR'])
      : [join(ctx.home, '.config', 'claude'), join(ctx.home, '.claude')];
  const codexFlag = ctx.args.all('codex-root');
  const codexRoots = codexFlag.length
    ? codexFlag
    : splitList(ctx.env['CODEX_HOME']).length
      ? splitList(ctx.env['CODEX_HOME'])
      : [join(ctx.home, '.codex')];
  return {
    claude: claudeRoots.map((r) => ctx.willRead('Claude Code transcripts', join(r, 'projects'))),
    codex: codexRoots.flatMap((r) => [
      ctx.willRead('Codex rollouts', join(r, 'sessions')),
      ctx.willRead('Codex archived rollouts', join(r, 'archived_sessions')),
    ]),
  };
}

/** Matches a commit ref against a PR's commit ids, by prefix in either direction (a short ref against a full id). */
const commitMatches = (commits: Set<string>, oids: string[]): boolean =>
  oids.some((oid) => [...commits].some((c) => oid.startsWith(c) || c.startsWith(oid)));

export const experiment = defineExperiment({
  meta: {
    id: 'E5',
    script: 'scripts/experiments/e5-evidence.ts',
    title: 'Evidence availability',
    question:
      'For one well-linked merged PR does the in-memory extractor find a PR URL or commit ref in a session, and for one ambiguous PR do only suggestions appear, with no body text kept?',
    criteria: [
      {
        id: 'linked-pr-has-evidence',
        text: 'For 1 well-linked merged PR, the extractor finds a `pr_url` or `commit` ref in a session.',
      },
      {
        id: 'ambiguous-pr-only-suggestions',
        text: 'For 1 ambiguous PR, only suggestions appear: no `pr_url` or `commit` ref points at it.',
      },
      {
        id: 'only-identifiers-kept',
        text: 'No body text is persisted: only matched identifiers are held in memory, and nothing is written.',
      },
    ],
    reads: [
      'Claude Code transcripts: every *.jsonl under ~/.config/claude/projects and ~/.claude/projects (or each entry of $CLAUDE_CONFIG_DIR, or --claude-root), line by line in memory',
      'Codex rollouts: every *.jsonl and *.jsonl.zst under ~/.codex/sessions and ~/.codex/archived_sessions (or each entry of $CODEX_HOME, or --codex-root), line by line in memory',
      'Nothing else: the two PRs come from your flags (--linked-pr, --linked-commit, --ambiguous-pr, --ambiguous-commit, --ambiguous-merged-at), not from GitHub',
    ],
    prints: [
      'Which folders it will read, then counts only: session files scanned, lines scanned, PR URL and commit refs found, how many sessions carry evidence for each of the two PRs, the share of sessions with any ref, and how many sessions fall in the 48 hours before the ambiguous PR merged. Never a line, a PR URL, a SHA, a branch or a path',
    ],
    writes: ['docs/implementation/experiments/E5.md (the findings)'],
    network: [],
    spawns: [],
    example:
      'node scripts/experiments/e5-evidence.ts --linked-pr <owner/name#number> --linked-commit <sha> --ambiguous-pr <owner/name#number> --ambiguous-merged-at <ISO time>',
    selftest: [
      {
        name: 'one PR with evidence in two sessions, one ambiguous PR with none',
        args: [
          '--claude-root',
          '{fixtures}/github/evidence/claude',
          '--codex-root',
          '{fixtures}/github/evidence/codex',
          '--linked-pr',
          'acme-crew/widgets#101',
          '--linked-commit',
          '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d',
          '--ambiguous-pr',
          'acme-crew/widgets#202',
          '--ambiguous-merged-at',
          '2026-11-07T12:00:00Z',
        ],
        expect: {
          exit: 0,
          verdicts: {
            'linked-pr-has-evidence': 'pass',
            'ambiguous-pr-only-suggestions': 'pass',
            'only-identifiers-kept': 'pass',
          },
          stdoutIncludes: ['Session files scanned: 4'],
        },
      },
      {
        name: 'the "well-linked" PR has no evidence anywhere',
        args: [
          '--claude-root',
          '{fixtures}/github/evidence/claude',
          '--codex-root',
          '{fixtures}/github/evidence/codex',
          '--linked-pr',
          'acme-crew/widgets#999',
          '--ambiguous-pr',
          'acme-crew/widgets#202',
        ],
        expect: {
          exit: 1,
          verdicts: {
            'linked-pr-has-evidence': 'fail',
            'ambiguous-pr-only-suggestions': 'pass',
            'only-identifiers-kept': 'pass',
          },
        },
      },
      {
        name: 'the "ambiguous" PR actually has a PR URL in a session',
        args: [
          '--claude-root',
          '{fixtures}/github/evidence/claude',
          '--codex-root',
          '{fixtures}/github/evidence/codex',
          '--linked-pr',
          'acme-crew/widgets#101',
          '--ambiguous-pr',
          'https://github.com/acme-crew/widgets/pull/101',
        ],
        expect: {
          exit: 1,
          verdicts: {
            'linked-pr-has-evidence': 'pass',
            'ambiguous-pr-only-suggestions': 'fail',
            'only-identifiers-kept': 'pass',
          },
        },
      },
      {
        name: 'no PRs named: counts only',
        args: [
          '--claude-root',
          '{fixtures}/github/evidence/claude',
          '--codex-root',
          '{fixtures}/github/evidence/codex',
        ],
        expect: {
          exit: 0,
          verdicts: {
            'linked-pr-has-evidence': 'not-run',
            'ambiguous-pr-only-suggestions': 'not-run',
            'only-identifiers-kept': 'pass',
          },
        },
      },
      {
        name: 'no transcripts or rollouts in the folders',
        args: [
          '--claude-root',
          '{fixtures}/github/evidence-empty/claude',
          '--codex-root',
          '{fixtures}/github/evidence-empty/codex',
          '--linked-pr',
          'acme-crew/widgets#101',
          '--ambiguous-pr',
          'acme-crew/widgets#202',
        ],
        expect: {
          exit: 0,
          verdicts: {
            'linked-pr-has-evidence': 'not-run',
            'ambiguous-pr-only-suggestions': 'not-run',
            'only-identifiers-kept': 'not-run',
          },
        },
      },
      {
        name: 'a compressed rollout and no zstd decoder',
        args: [
          '--claude-root',
          '{fixtures}/github/evidence-empty/claude',
          '--codex-root',
          '{fixtures}/github/evidence-zst/codex',
          '--linked-pr',
          'acme-crew/widgets#101',
        ],
        env: { EXPERIMENTS_FORCE_NO_ZSTD: '1' },
        expect: {
          exit: 0,
          verdicts: {
            'linked-pr-has-evidence': 'not-run',
            'ambiguous-pr-only-suggestions': 'not-run',
            'only-identifiers-kept': 'not-run',
          },
          stdoutIncludes: ['Files skipped because no zstd decoder is available: 1'],
        },
      },
      {
        name: 'a PR flag that is not owner/name#number',
        args: ['--claude-root', '{fixtures}/github/evidence/claude', '--linked-pr', 'not a pr'],
        expect: { exit: 2, verdicts: {} },
      },
    ],
  },

  async run(ctx) {
    const linkedPr = parsePr(ctx.args.get('linked-pr'), 'linked-pr');
    const linkedCommits = parseCommits(ctx, 'linked-commit');
    const ambiguousPr = parsePr(ctx.args.get('ambiguous-pr'), 'ambiguous-pr');
    const ambiguousCommits = parseCommits(ctx, 'ambiguous-commit');
    const mergedRaw = ctx.args.get('ambiguous-merged-at');
    const mergedAt = mergedRaw === undefined ? undefined : Date.parse(mergedRaw);
    if (mergedAt !== undefined && Number.isNaN(mergedAt))
      throw new UsageError(
        '--ambiguous-merged-at must be an ISO time such as 2026-11-07T12:00:00Z',
      );

    const folders = sessionFolders(ctx);
    const files: { path: string; source: 'claude' | 'codex' }[] = [];
    for (const root of folders.claude)
      for (const path of ctx.fs.walk(root, { match: /\.jsonl$/ }).files)
        files.push({ path, source: 'claude' });
    for (const root of folders.codex) {
      const found = ctx.fs.walk(root, { match: /\.jsonl(?:\.zst)?$/ }).files;
      const plain = new Set(found);
      // A plain rollout beats its .zst twin (data-and-sources › Codex local rollouts).
      for (const path of found)
        if (!(path.endsWith('.zst') && plain.has(path.slice(0, -'.zst'.length))))
          files.push({ path, source: 'codex' });
    }

    const counts = {
      claude: 0,
      codex: 0,
      lines: 0,
      unreadableLines: 0,
      skippedNoZstd: 0,
      unreadableFiles: 0,
      withAnyRef: 0,
      withPrUrl: 0,
      withCommit: 0,
      linkedByUrl: 0,
      linkedByCommit: 0,
      linkedAny: 0,
      ambiguousByUrl: 0,
      ambiguousByCommit: 0,
      ambiguousAny: 0,
      suggestionWindow: 0,
    };
    // Identifiers only, kept so the run can report how many distinct refs exist and prove nothing else was retained.
    const distinctPrs = new Set<string>();
    const distinctCommits = new Set<string>();
    const wantTimestamps = mergedAt !== undefined;

    for (const file of files) {
      const prs = new Set<string>();
      const commits = new Set<string>();
      let lastEvent: number | null = null;
      let lines = 0;
      try {
        for (const line of ctx.fs.lines(file.path)) {
          lines++;
          const found = extractRefs(line);
          for (const pr of found.prs) prs.add(pr);
          for (const c of found.commits) commits.add(c);
          if (wantTimestamps && TIMESTAMP_LINE.test(line)) {
            try {
              const stamp = (JSON.parse(line) as { timestamp?: unknown }).timestamp;
              const ms = typeof stamp === 'string' ? Date.parse(stamp) : Number.NaN;
              if (!Number.isNaN(ms) && (lastEvent === null || ms > lastEvent)) lastEvent = ms;
            } catch {
              counts.unreadableLines++;
            }
          }
        }
      } catch (error) {
        if (error instanceof DecoderMissingError) counts.skippedNoZstd++;
        else counts.unreadableFiles++;
        continue;
      }
      counts[file.source]++;
      counts.lines += lines;
      for (const pr of prs) distinctPrs.add(pr);
      for (const c of commits) distinctCommits.add(c);
      if (prs.size + commits.size > 0) counts.withAnyRef++;
      if (prs.size > 0) counts.withPrUrl++;
      if (commits.size > 0) counts.withCommit++;

      const byUrl = linkedPr !== undefined && prs.has(linkedPr);
      const byCommit = commitMatches(commits, linkedCommits);
      if (byUrl) counts.linkedByUrl++;
      if (byCommit) counts.linkedByCommit++;
      if (byUrl || byCommit) counts.linkedAny++;
      const ambiguousUrl = ambiguousPr !== undefined && prs.has(ambiguousPr);
      const ambiguousCommit = commitMatches(commits, ambiguousCommits);
      if (ambiguousUrl) counts.ambiguousByUrl++;
      if (ambiguousCommit) counts.ambiguousByCommit++;
      if (ambiguousUrl || ambiguousCommit) counts.ambiguousAny++;
      if (
        mergedAt !== undefined &&
        lastEvent !== null &&
        lastEvent <= mergedAt &&
        lastEvent >= mergedAt - 2 * DAY_MS
      )
        counts.suggestionWindow++;
    }

    const scanned = counts.claude + counts.codex;
    ctx.out.line(
      safeText`Session files scanned: ${scanned} (claude ${counts.claude}, codex ${counts.codex}), ${counts.lines} lines.`,
    );
    if (counts.skippedNoZstd > 0)
      ctx.out.line(
        safeText`Files skipped because no zstd decoder is available: ${counts.skippedNoZstd}`,
      );
    ctx.out.line(
      safeText`Sessions with a PR URL: ${counts.withPrUrl}, with a commit ref: ${counts.withCommit}, with either: ${counts.withAnyRef}.`,
    );

    ctx.findings.fact('Scan', 'Claude session files scanned', counts.claude);
    ctx.findings.fact('Scan', 'Codex session files scanned', counts.codex);
    ctx.findings.fact('Scan', 'lines scanned', counts.lines);
    ctx.findings.fact('Scan', 'files skipped (no zstd decoder)', counts.skippedNoZstd);
    ctx.findings.fact('Scan', 'files that could not be read', counts.unreadableFiles);
    ctx.findings.fact('Scan', 'lines whose timestamp could not be parsed', counts.unreadableLines);
    ctx.findings.fact('Coverage', 'sessions with a PR URL ref', counts.withPrUrl);
    ctx.findings.fact('Coverage', 'sessions with a commit ref', counts.withCommit);
    ctx.findings.fact('Coverage', 'sessions with any ref', counts.withAnyRef);
    ctx.findings.fact(
      'Coverage',
      'coverage percent (sessions with any ref)',
      scanned === 0 ? 0 : Math.round((counts.withAnyRef / scanned) * 1000) / 10,
    );
    ctx.findings.fact('Coverage', 'distinct PR refs', distinctPrs.size);
    ctx.findings.fact('Coverage', 'distinct commit refs', distinctCommits.size);
    ctx.findings.fact('Linked PR', 'sessions with its PR URL', counts.linkedByUrl);
    ctx.findings.fact('Linked PR', 'sessions with one of its commits', counts.linkedByCommit);
    ctx.findings.fact('Ambiguous PR', 'sessions with its PR URL', counts.ambiguousByUrl);
    ctx.findings.fact('Ambiguous PR', 'sessions with one of its commits', counts.ambiguousByCommit);
    if (mergedAt !== undefined) {
      ctx.findings.fact(
        'Ambiguous PR',
        'sessions last active in the 48 h before the merge',
        counts.suggestionWindow,
      );
      ctx.findings.note(
        'The 48-hour count uses time only: a transcript does not name its repository, so the same-repo half of the suggestion rule is not checked here.',
      );
    }

    if (scanned === 0) {
      ctx.findings.note(
        'No session file could be read, so no criterion was evaluated. Check the folders above, or --claude-root and --codex-root.',
      );
      return;
    }

    if (linkedPr === undefined && linkedCommits.length === 0)
      ctx.findings.criterion(
        'linked-pr-has-evidence',
        'not-run',
        'Name the well-linked PR with --linked-pr (and its commits with --linked-commit).',
      );
    else if (counts.linkedAny > 0)
      ctx.findings.criterion(
        'linked-pr-has-evidence',
        'pass',
        safeText`Sessions carrying evidence for it: ${counts.linkedAny} (PR URL in ${counts.linkedByUrl}, commit in ${counts.linkedByCommit}).`,
      );
    else
      ctx.findings.criterion(
        'linked-pr-has-evidence',
        'fail',
        safeText`None of ${scanned} sessions carries a PR URL or commit ref for it, so it would show as suggested at best.`,
      );

    if (ambiguousPr === undefined && ambiguousCommits.length === 0)
      ctx.findings.criterion(
        'ambiguous-pr-only-suggestions',
        'not-run',
        'Name the ambiguous PR with --ambiguous-pr (and --ambiguous-merged-at for the suggestion window).',
      );
    else if (counts.ambiguousAny === 0)
      ctx.findings.criterion(
        'ambiguous-pr-only-suggestions',
        'pass',
        mergedAt !== undefined
          ? safeText`No evidence ref points at it; ${counts.suggestionWindow} sessions fall in the 48 hours before the merge and could be suggested.`
          : 'No evidence ref points at it, so only suggestions can appear.',
      );
    else
      ctx.findings.criterion(
        'ambiguous-pr-only-suggestions',
        'fail',
        safeText`${counts.ambiguousAny} sessions carry a PR URL or commit ref for it, so it is not ambiguous: it would be linked by evidence.`,
      );

    const badRefs =
      [...distinctPrs].filter((r) => !RETAINED_PR.test(r)).length +
      [...distinctCommits].filter((r) => !RETAINED_COMMIT.test(r)).length;
    ctx.findings.fact('Retained', 'refs held in memory', distinctPrs.size + distinctCommits.size);
    ctx.findings.fact('Retained', 'refs that are not identifier-shaped', badRefs);
    ctx.findings.criterion(
      'only-identifiers-kept',
      badRefs === 0 ? 'pass' : 'fail',
      badRefs === 0
        ? safeText`${distinctPrs.size + distinctCommits.size} refs were held in memory, each a PR reference or a hex SHA; nothing was written but this findings file.`
        : safeText`${badRefs} retained refs were not identifier-shaped.`,
    );
    ctx.findings.note(
      "The database grep test in TECH's E5 row belongs to the product's persistence tests: this script has no database and writes only this findings file.",
    );
  },
});

runIfMain(import.meta, experiment);
