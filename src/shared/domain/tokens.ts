// Provider token totals (owner rule r6). Pure.
//
// Subsets are never added again: Codex `cachedInput` is part of `input` and `reasoning` is part of `output`; Claude's
// four categories are separate and add. Totals are per provider and are never summed across providers.

export type Provider = 'codex' | 'claude';

export interface CodexTokens {
  input: number;
  /** A subset of `input`. */
  cachedInput: number;
  output: number;
  /** A subset of `output`. */
  reasoning: number;
}

export interface ClaudeTokens {
  inputUncached: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export const codexTotal = (t: CodexTokens): number => t.input + t.output;
export const claudeTotal = (t: ClaudeTokens): number =>
  t.inputUncached + t.cacheWrite + t.cacheRead + t.output;

export const providerTotal = { codex: codexTotal, claude: claudeTotal } as const;

/** Checks the subset rules a stored Codex row must satisfy. */
export function codexSubsetsHold(t: CodexTokens): boolean {
  return (
    t.cachedInput >= 0 && t.cachedInput <= t.input && t.reasoning >= 0 && t.reasoning <= t.output
  );
}

/** Sums totals that already belong to one provider. Different providers must be kept apart, so the caller passes one provider's totals. */
export const sumTotals = (totals: Iterable<number>): number => {
  let sum = 0;
  for (const total of totals) sum += total;
  return sum;
};

/** Per-provider sums of `(provider, total)` rows. The result has one number per provider and no grand total on purpose. */
export function totalsByProvider(
  rows: Iterable<{ provider: Provider; total: number }>,
): Record<Provider, number> {
  const out: Record<Provider, number> = { codex: 0, claude: 0 };
  for (const row of rows) out[row.provider] += row.total;
  return out;
}

/** "1.2M", "850K", "42": the compact count used in chart readouts (matches the prototype). */
export function compactCount(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  const a = Math.abs(n);
  const trim = (x: number) => {
    const s = x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2);
    return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  };
  if (a >= 1e9) return `${trim(n / 1e9)}B`;
  if (a >= 1e6) return `${trim(n / 1e6)}M`;
  if (a >= 1e3) return `${trim(n / 1e3)}K`;
  return String(Math.round(n));
}
