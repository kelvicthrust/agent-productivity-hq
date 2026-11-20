// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Sparkline } from '../../src/client/components/Sparkline';

afterEach(cleanup);

const twelve = [3, 5, 2, 8, 4, 6, 7, 1, 9, 5, 4, 8];

function show(values: (number | null)[], currentIndex = values.length - 1, kind = 'delivery') {
  return render(
    <Sparkline values={values} currentIndex={currentIndex} kind={kind as 'delivery'} />,
  );
}

describe('Sparkline', () => {
  it('is a quiet picture with its numbers in an accessible summary, oldest to newest', () => {
    const { container } = show(twelve);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(
      screen.getByRole('img', {
        name: '12-week trend, oldest to newest: 3, 5, 2, 8, 4, 6, 7, 1, 9, 5, 4, 8; this week 8',
      }),
    ).toBeTruthy();
  });

  it('says "no data" for a week with no figure, never 0', () => {
    show([3, null, 2, null, null, 4]);
    expect(
      screen.getByRole('img', {
        name: '6-week trend, oldest to newest: 3, no data, 2, no data, no data, 4; this week 4',
      }),
    ).toBeTruthy();
    cleanup();
    show([3, 5, null], 2);
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/this week no data$/);
  });

  it('names the series in the summary when given a label and formats the figures it is given', () => {
    render(
      <Sparkline
        values={[1_200_000, 3_400_000]}
        currentIndex={1}
        kind="codex"
        label="Codex"
        format={(n) => `${n / 1e6}M`}
      />,
    );
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe(
      'Codex 2-week trend, oldest to newest: 1.2M, 3.4M; this week 3.4M',
    );
  });

  it('breaks the line at a missing week instead of drawing it as zero', () => {
    const { container } = show([1, 2, null, 4, 5, 6]);
    const segments = container.querySelectorAll('path[data-segment]');
    expect(segments).toHaveLength(2);
    // Each segment is only its own weeks: M x y then L per further point.
    expect(segments[0]!.getAttribute('d')!.match(/[ML]/g)).toHaveLength(2);
    expect(segments[1]!.getAttribute('d')!.match(/[ML]/g)).toHaveLength(3);
  });

  it('keeps a lone week between two gaps visible as a dot', () => {
    const { container } = show([1, null, 3, null, 5]);
    expect(container.querySelectorAll('path[data-segment]')).toHaveLength(0);
    expect(container.querySelectorAll('circle[data-lone]')).toHaveLength(3);
  });

  it('draws the current week as a filled dot in the series colour', () => {
    for (const kind of ['delivery', 'codex', 'claude'] as const) {
      const { container } = show(twelve, 11, kind);
      const dot = container.querySelector('circle[data-current]');
      expect(dot?.getAttribute('class')).toContain(`fill-series-${kind}`);
      cleanup();
    }
  });

  it('draws no current dot when the current week has no figure', () => {
    const { container } = show([3, 5, null], 2);
    expect(container.querySelector('circle[data-current]')).toBeNull();
  });

  it('uses its own scale: the highest week is at the top and the lowest at the bottom', () => {
    const { container } = show([10, 20, 30]);
    const d = container.querySelector('path[data-segment]')!.getAttribute('d')!;
    const ys = [...d.matchAll(/[ML]\s*[\d.]+[ ,]([\d.]+)/g)].map((m) => Number(m[1]));
    expect(ys[0]).toBeGreaterThan(ys[1]!);
    expect(ys[1]).toBeGreaterThan(ys[2]!);
    expect(ys[2]).toBeGreaterThanOrEqual(0);
    expect(ys[0]).toBeLessThanOrEqual(20);
  });

  it('draws a flat series as a level line, not a division by zero', () => {
    const { container } = show([5, 5, 5, 5]);
    const d = container.querySelector('path[data-segment]')!.getAttribute('d')!;
    expect(d).not.toMatch(/NaN|Infinity/);
  });
});
