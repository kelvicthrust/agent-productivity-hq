// Small helpers for the budget bench: percentiles, reading a budget out of TECH's own words, and the results table.

export const p95 = (samples: readonly number[]): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)]!;
};
export const median = (samples: readonly number[]): number =>
  [...samples].sort((a, b) => a - b)[samples.length >> 1]!;

/** The first "≤ N ms" or "≤ N s" in a TECH budget cell, in milliseconds; null when the cell sets no time. */
export function budgetMs(cell: string): number | null {
  const match = /≤\s*([\d.]+)\s*(ms|s)\b/.exec(cell);
  if (!match) return null;
  return Number(match[1]) * (match[2] === 's' ? 1000 : 1);
}

export interface Result {
  obligation: string;
  budget: string;
  /** What was measured, as the budget states it (p95, or the slowest run), in ms. */
  ms: number | null;
  limitMs: number | null;
  samples: number;
  /** What the number is: "p95", "slowest of 3"… */
  stat: string;
  /** Why a row has no number. */
  note?: string;
}

const fmt = (ms: number) => (ms >= 100 ? ms.toFixed(0) : ms.toFixed(1));

export function renderTable(results: readonly Result[]): string {
  const rows = results.map((r) => {
    const verdict =
      r.ms === null ? 'NOT TIMED' : r.limitMs !== null && r.ms > r.limitMs ? 'FAIL' : 'pass';
    return [
      r.obligation,
      r.budget,
      r.ms === null ? '-' : `${fmt(r.ms)} ms ${r.stat}`,
      r.samples > 0 ? String(r.samples) : '-',
      verdict,
    ];
  });
  const head = ['Obligation', 'TECH budget', 'Measured', 'n', 'Result'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}
