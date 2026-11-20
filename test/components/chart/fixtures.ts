import type { Bucket } from '../../../src/shared/contracts/series';

// A week of daily buckets, Mon Nov 2 .. Sun Nov 8, 2026, read on Wed Nov 4. It holds every case the chart has to tell apart:
//   Mon  PRs and tokens for both providers, fully covered
//   Tue  a covered zero: no PRs, and both providers recorded nothing
//   Wed  Codex has tokens; Claude Code has no history yet (null, not 0), so the bucket is partly covered
//   Thu–Sun  upcoming: nothing is known, nothing is drawn

const ok = { codex: 'ok', claude: 'ok', rail: 'ok' } as const;

const upcoming = (start: string, label: string, short: string): Bucket => ({
  start,
  end: start,
  label,
  short,
  prs: null,
  delivery: 'future',
  tokens: { codex: null, claude: null },
  usage: { codex: 'future', claude: 'future', rail: 'future' },
});

export const WEEK: Bucket[] = [
  {
    start: '2026-11-02',
    end: '2026-11-02',
    label: 'Mon, Nov 2, 2026',
    short: 'Mon 2',
    prs: 3,
    delivery: 'ok',
    tokens: { codex: 1_200_000, claude: 800_000 },
    usage: { ...ok },
  },
  {
    start: '2026-11-03',
    end: '2026-11-03',
    label: 'Tue, Nov 3, 2026',
    short: 'Tue 3',
    prs: 0,
    delivery: 'ok',
    tokens: { codex: 0, claude: 0 },
    usage: { ...ok },
  },
  {
    start: '2026-11-04',
    end: '2026-11-04',
    label: 'Wed, Nov 4, 2026',
    short: 'Wed 4',
    prs: 1,
    delivery: 'ok',
    tokens: { codex: 40_000, claude: null },
    usage: { codex: 'ok', claude: 'unavailable', rail: 'partial' },
  },
  upcoming('2026-11-05', 'Thu, Nov 5, 2026', 'Thu 5'),
  upcoming('2026-11-06', 'Fri, Nov 6, 2026', 'Fri 6'),
  upcoming('2026-11-07', 'Sat, Nov 7, 2026', 'Sat 7'),
  upcoming('2026-11-08', 'Sun, Nov 8, 2026', 'Sun 8'),
];

/** `n` consecutive daily buckets from 2026-01-01 with no local history at all and no tracked repo. */
export function emptyHistory(n: number): Bucket[] {
  return Array.from({ length: n }, (_, i) => {
    const day = String(i + 1).padStart(2, '0');
    return {
      start: `2026-01-${day}`,
      end: `2026-01-${day}`,
      label: `Day ${i + 1}`,
      short: `Jan ${i + 1}`,
      prs: null,
      delivery: 'none',
      tokens: { codex: null, claude: null },
      usage: { codex: 'unavailable', claude: 'unavailable', rail: 'unavailable' },
    } satisfies Bucket;
  });
}
