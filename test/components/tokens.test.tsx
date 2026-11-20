// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TokenLedger } from '../../src/client/components/TokenLedger';
import { TokenStack } from '../../src/client/components/TokenStack';

afterEach(cleanup);

/** The table's rows as [label, value] text, in order. */
function ledgerRows(): string[][] {
  return screen.getAllByRole('row').map((row) => {
    const cells = within(row).getAllByRole('cell');
    // A label cell can carry a small note under the label; the label is the first line.
    return [
      cells[0]!.querySelector('span')?.textContent ?? cells[0]!.textContent,
      cells[1]!.textContent,
    ];
  });
}

describe('TokenLedger', () => {
  const codex = {
    input: 1_200_000,
    cachedInput: 900_000,
    output: 340_000,
    reasoning: 120_000,
    total: 1_540_000,
  };

  it('lists Codex categories with the cached and reasoning subsets, then the provider total', () => {
    render(<TokenLedger provider="codex" tokens={codex} />);
    expect(ledgerRows()).toEqual([
      ['Input', '1,200,000'],
      ['Cached input', '900,000'],
      ['Output', '340,000'],
      ['Reasoning', '120,000'],
      ['Provider total', '1,540,000'],
    ]);
  });

  it('says where each subset is included, so it is not added again', () => {
    render(<TokenLedger provider="codex" tokens={codex} />);
    expect(screen.getByText('included in input')).toBeTruthy();
    expect(screen.getByText('included in output')).toBeTruthy();
    expect(
      screen.getByText(
        'Total = input + output. Cached input and reasoning are subsets and aren’t added again.',
      ),
    ).toBeTruthy();
  });

  it('indents only the subsets, with an elbow', () => {
    render(<TokenLedger provider="codex" tokens={codex} />);
    const labelCell = (name: string) => screen.getByText(name).closest('td')!;
    expect(labelCell('Cached input').className).toContain('before:border-l');
    expect(labelCell('Reasoning').className).toContain('before:border-l');
    expect(labelCell('Input').className).not.toContain('before:');
    expect(labelCell('Output').className).not.toContain('before:');
  });

  it('lists the four separate Claude categories and sums them', () => {
    render(
      <TokenLedger
        provider="claude"
        tokens={{ inputUncached: 10, cacheWrite: 20, cacheRead: 300, output: 4, total: 334 }}
      />,
    );
    expect(ledgerRows()).toEqual([
      ['Input (uncached)', '10'],
      ['Cache write', '20'],
      ['Cache read', '300'],
      ['Output', '4'],
      ['Provider total', '334'],
    ]);
    expect(screen.queryByText('included in input')).toBeNull();
    expect(
      screen.getByText(
        'Total = uncached input + cache write + cache read + output (separate categories, none counted twice).',
      ),
    ).toBeTruthy();
  });

  it('is a table named for its provider, and a missing count reads 0', () => {
    render(<TokenLedger provider="claude" tokens={{ output: 5 }} />);
    expect(screen.getByRole('table', { name: 'Claude Code token categories' })).toBeTruthy();
    expect(ledgerRows()[0]).toEqual(['Input (uncached)', '0']);
  });

  it('appends a coverage note to the rule', () => {
    render(<TokenLedger provider="claude" tokens={{}} note="Covers Mar 14, 2026 onward only." />);
    expect(
      screen.getByText(/none counted twice\)\. Covers Mar 14, 2026 onward only\.$/),
    ).toBeTruthy();
  });
});

describe('TokenStack', () => {
  /** [provider name, value] per line. */
  function lines(container: HTMLElement): string[][] {
    return Array.from(container.firstElementChild!.children).map((line) => [
      line.querySelector('.sr-only')!.textContent!,
      line.textContent!.replace(line.querySelector('.sr-only')!.textContent!, ''),
    ]);
  }

  it('shows one provider per line, Codex first, whatever order the totals arrive in', () => {
    const { container } = render(<TokenStack totals={{ claude: 4_200_000, codex: 38_100_000 }} />);
    expect(lines(container)).toEqual([
      ['Codex: ', '38.1M'],
      ['Claude Code: ', '4.2M'],
    ]);
    expect(container.firstElementChild?.className).toContain('flex-col');
    expect(container.firstElementChild?.className).toContain('items-end');
    expect(container.firstElementChild?.className).toContain('tabular-nums');
  });

  it('shows 0 for a covered provider with no tokens and a dash for an uncovered one', () => {
    const { container } = render(<TokenStack totals={{ codex: 0, claude: null }} />);
    expect(lines(container)).toEqual([
      ['Codex: ', '0'],
      ['Claude Code: ', '—'],
    ]);
  });

  it('shows only the providers in scope and never a combined figure', () => {
    const { container } = render(
      <TokenStack totals={{ codex: 1000, claude: 2000 }} providers={['claude']} />,
    );
    expect(lines(container)).toEqual([['Claude Code: ', '2K']]);
    expect(container.textContent).not.toContain('3K');
  });

  it('keeps the buddy decorative and the provider name for assistive technology', () => {
    const { container } = render(<TokenStack totals={{ codex: 1, claude: 2 }} />);
    const svgs = Array.from(container.querySelectorAll('svg'));
    expect(svgs).toHaveLength(2);
    for (const svg of svgs) expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('Codex:')).toBeTruthy();
  });
});
