import { describe, expect, it } from 'vitest';
import {
  claudeTotal,
  codexSubsetsHold,
  codexTotal,
  compactCount,
  providerTotal,
  sumTotals,
  totalsByProvider,
} from '../../src/shared/domain/tokens';

describe('provider totals (owner rule r6)', () => {
  it('Codex total is input plus output; cached input and reasoning are subsets and are not added again', () => {
    const tokens = { input: 1_000, cachedInput: 800, output: 200, reasoning: 150 };
    expect(codexTotal(tokens)).toBe(1_200);
    expect(codexTotal({ ...tokens, cachedInput: 0, reasoning: 0 })).toBe(1_200);
    expect(providerTotal.codex(tokens)).toBe(1_200);
  });

  it('Claude total adds its four separate categories', () => {
    expect(claudeTotal({ inputUncached: 10, cacheWrite: 200, cacheRead: 3_000, output: 40 })).toBe(
      3_250,
    );
    expect(providerTotal.claude({ inputUncached: 1, cacheWrite: 1, cacheRead: 1, output: 1 })).toBe(
      4,
    );
  });

  it('checks the Codex subset rules', () => {
    expect(codexSubsetsHold({ input: 10, cachedInput: 10, output: 5, reasoning: 5 })).toBe(true);
    expect(codexSubsetsHold({ input: 10, cachedInput: 11, output: 5, reasoning: 0 })).toBe(false);
    expect(codexSubsetsHold({ input: 10, cachedInput: 0, output: 5, reasoning: 6 })).toBe(false);
  });

  it('never merges providers: sums come back per provider with no grand total', () => {
    const sums = totalsByProvider([
      { provider: 'codex', total: 100 },
      { provider: 'claude', total: 5_000 },
      { provider: 'codex', total: 20 },
    ]);
    expect(sums).toEqual({ codex: 120, claude: 5_000 });
    expect(Object.keys(sums)).toEqual(['codex', 'claude']);
    expect(sumTotals([1, 2, 3])).toBe(6);
  });

  it('formats compact counts like the prototype', () => {
    expect(compactCount(null)).toBe('—');
    expect(compactCount(0)).toBe('0');
    expect(compactCount(999)).toBe('999');
    expect(compactCount(1_000)).toBe('1K');
    expect(compactCount(12_340)).toBe('12.3K');
    expect(compactCount(850_000)).toBe('850K');
    expect(compactCount(1_200_000)).toBe('1.2M');
    expect(compactCount(3_400_000_000)).toBe('3.4B');
  });
});
