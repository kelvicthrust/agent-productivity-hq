// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlignedChart, type AlignedChartProps } from '../../../src/client/components/AlignedChart';
import type { Bucket } from '../../../src/shared/contracts/series';
import { WEEK, emptyHistory } from './fixtures';

// G7_3: the aligned chart as a component. The geometry is checked in layout.test.ts; these check what a person gets: the
// group role and its name, one findable and focusable column per bucket, the keyboard model (arrows, Home, End, Enter), the
// readout that follows it and is announced, the Chart/Table switch, and the rules that hold everywhere (no zero from a null,
// no total across providers, no animation, a 240px floor). Rendered pixels are the browser specs' job (M7 e2e).

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const TITLE = 'Merged PRs and recorded local tokens';
const SCOPE = 'PRs: All repos · Authored by you · Tokens: This machine · All repos · All providers';

/** Holds the selection the way Overview and Trends do: the chart reports, the host keeps the state. */
function Host({
  onSelect,
  initial = null,
  ...props
}: Partial<AlignedChartProps> & { initial?: number | null }) {
  const [selected, setSelected] = useState<number | null>(initial);
  return (
    <AlignedChart
      buckets={WEEK}
      title={TITLE}
      scope={SCOPE}
      {...props}
      selectedIndex={selected}
      onSelect={(index) => {
        setSelected(index);
        onSelect?.(index);
      }}
    />
  );
}

const chart = () => screen.getByRole('group', { name: /Merged PRs and recorded local tokens/ });
const bucket = (index: number): SVGElement => {
  const found = chart().querySelector<SVGElement>(`[data-bucket-index="${index}"]`);
  if (!found) throw new Error(`no bucket ${index}`);
  return found;
};
const live = () =>
  screen
    .getAllByRole('status')
    .map((node) => node.textContent ?? '')
    .join('|');
const key = (name: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document.activeElement ?? chart(), { key: name, ...init });
/** The readout line above the picture. */
const readout = () =>
  screen.getByText(
    'Hover a bucket, or focus the chart and use the arrow keys, to read its values.',
    {
      exact: true,
    },
  );

function focusChart() {
  act(() => chart().focus());
}

describe('the chart as a group', () => {
  it('is a group described as a chart, named by its title, scope and keyboard help', () => {
    render(<Host />);
    const group = chart();
    expect(group.tagName.toLowerCase()).toBe('svg');
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-roledescription')).toBe('chart');
    const name = group.getAttribute('aria-label') ?? '';
    expect(name).toContain(TITLE);
    expect(name).toContain('All repos · Authored by you');
    expect(name).toContain('arrow keys');
    expect(name).toContain('Enter');
  });

  it('is one tab stop', () => {
    render(<Host />);
    expect(chart().getAttribute('tabindex')).toBe('0');
    for (let i = 0; i < WEEK.length; i += 1) expect(bucket(i).getAttribute('tabindex')).toBe('-1');
  });

  it('heads itself with the title and the scope text', () => {
    render(<Host />);
    expect(screen.getByRole('heading', { level: 2, name: TITLE })).toBeTruthy();
    expect(screen.getByText(SCOPE)).toBeTruthy();
  });

  it('takes a heading level for a chart nested under a section', () => {
    render(<Host headingLevel={3} />);
    expect(screen.getByRole('heading', { level: 3, name: TITLE })).toBeTruthy();
  });

  it('draws two panels, each with its own title, unit and axis', () => {
    render(<Host />);
    const svg = chart();
    const words = within(svg as unknown as HTMLElement);
    expect(words.getByText('Merged PRs')).toBeTruthy();
    expect(words.getByText('count')).toBeTruthy();
    expect(words.getByText('Recorded local tokens')).toBeTruthy();
    expect(words.getByText('tokens, this machine')).toBeTruthy();
    // the count axis tops out at 5 and the token axis at 2M: separate scales, no shared numeric axis
    expect(words.getByText('5')).toBeTruthy();
    expect(words.getByText('2M')).toBeTruthy();
    expect(words.getByText('1M')).toBeTruthy();
  });

  it('writes the axis labels for a screen reader nowhere inside the group: the readout and table carry the words', () => {
    render(<Host />);
    const hidden = chart().querySelector('[aria-hidden="true"]');
    expect(hidden?.textContent).toContain('Recorded local tokens');
  });
});

describe('buckets', () => {
  it('has one column per bucket, findable and focusable by its index', () => {
    render(<Host />);
    const columns = chart().querySelectorAll('[data-bucket-index]');
    expect([...columns].map((node) => node.getAttribute('data-bucket-index'))).toEqual(
      WEEK.map((_, i) => String(i)),
    );
    act(() => bucket(4).focus());
    expect(document.activeElement).toBe(bucket(4));
  });

  it('marks the selected bucket, and only that one', () => {
    render(<Host initial={2} />);
    expect(bucket(2).getAttribute('data-selected')).toBe('true');
    expect(bucket(2).getAttribute('aria-current')).toBe('true');
    for (const i of [0, 1, 3, 4, 5, 6]) {
      expect(bucket(i).hasAttribute('data-selected'), `bucket ${i}`).toBe(false);
      expect(bucket(i).hasAttribute('aria-current'), `bucket ${i}`).toBe(false);
    }
  });

  it('ignores a selected index the series no longer has', () => {
    render(<Host initial={40} />);
    expect(chart().querySelector('[data-selected]')).toBeNull();
  });

  it('reports a click on a bucket by its index, and a click anywhere on its column counts', () => {
    const onSelect = vi.fn();
    render(<Host onSelect={onSelect} />);
    fireEvent.click(bucket(1).querySelector('rect')!);
    expect(onSelect).toHaveBeenLastCalledWith(1);
    fireEvent.click(bucket(3)); // an upcoming bucket is a bucket too: the drawer says it has not happened yet
    expect(onSelect).toHaveBeenLastCalledWith(3);
    expect(bucket(3).getAttribute('data-selected')).toBe('true');
  });

  it('does not report a click on the axis', () => {
    const onSelect = vi.fn();
    render(<Host onSelect={onSelect} />);
    fireEvent.click(chart());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('never opens anything itself: it only reports', () => {
    // The drawer belongs to Overview and Trends (useRecordsDrawer().open). This component takes no provider and no router, so
    // it renders and reports with neither, which is the point of the test above.
    const onSelect = vi.fn();
    render(<Host onSelect={onSelect} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('keyboard', () => {
  it('starts the cursor on the newest bucket that has started, reads it out and announces it', () => {
    render(<Host />);
    focusChart();
    // Wed Nov 4 is the newest bucket that has started
    expect(live()).toContain(
      'Wed, Nov 4, 2026. Merged PRs: 1. Codex: 40K tokens. Claude Code: history unavailable.',
    );
    expect(screen.getByText('Wed, Nov 4, 2026')).toBeTruthy();
  });

  it('starts on the selected bucket when there is one', () => {
    render(<Host initial={0} />);
    focusChart();
    expect(live()).toContain('Mon, Nov 2, 2026');
  });

  it('moves one bucket with the arrows, and the readout and announcement follow', () => {
    render(<Host />);
    focusChart();
    key('ArrowLeft');
    expect(live()).toContain(
      'Tue, Nov 3, 2026. Merged PRs: 0. Codex: 0 (no recorded activity). Claude Code: 0 (no recorded activity).',
    );
    key('ArrowLeft');
    expect(live()).toContain(
      'Mon, Nov 2, 2026. Merged PRs: 3. Codex: 1.2M tokens. Claude Code: 800K tokens.',
    );
    key('ArrowRight');
    expect(live()).toContain('Tue, Nov 3, 2026');
  });

  it('jumps to the first and last bucket with Home and End, and stops at the ends', () => {
    render(<Host />);
    focusChart();
    key('End');
    expect(live()).toContain('Sun, Nov 8, 2026. Upcoming, no data yet.');
    key('ArrowRight');
    expect(live()).toContain('Sun, Nov 8, 2026');
    key('Home');
    expect(live()).toContain('Mon, Nov 2, 2026');
    key('ArrowLeft');
    expect(live()).toContain('Mon, Nov 2, 2026');
  });

  it('outlines the cursor’s bucket while the chart has focus, and not before or after', () => {
    render(<Host />);
    const outlined = () =>
      [...chart().querySelectorAll('[data-bucket-index] > rect:first-child')].filter((rect) =>
        rect.getAttribute('class')?.includes('stroke-focus'),
      );
    expect(outlined()).toHaveLength(0);
    focusChart();
    expect(outlined()).toHaveLength(1);
    expect(outlined()[0]!.parentElement).toBe(bucket(2));
    key('ArrowLeft');
    expect(outlined()[0]!.parentElement).toBe(bucket(1));
    act(() => chart().blur());
    expect(outlined()).toHaveLength(0);
  });

  it('selects the cursor’s bucket on Enter, and on Space as the prototype did', () => {
    const onSelect = vi.fn();
    render(<Host onSelect={onSelect} />);
    focusChart();
    key('ArrowLeft');
    key('Enter');
    expect(onSelect).toHaveBeenLastCalledWith(1);
    expect(bucket(1).getAttribute('data-selected')).toBe('true');
    key('ArrowLeft');
    key(' ');
    expect(onSelect).toHaveBeenLastCalledWith(0);
  });

  it('leaves the browser’s own shortcuts alone', () => {
    const onSelect = vi.fn();
    render(<Host onSelect={onSelect} />);
    focusChart();
    const before = live();
    for (const init of [
      { altKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
    ]) {
      expect(fireEvent.keyDown(chart(), { key: 'ArrowLeft', ...init })).toBe(true); // not prevented
    }
    expect(fireEvent.keyDown(chart(), { key: 'ArrowDown' })).toBe(true);
    expect(fireEvent.keyDown(chart(), { key: 'Tab' })).toBe(true);
    expect(live()).toBe(before);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('takes focus back onto a bucket by its index, with the cursor on it, and then keeps moving from there', () => {
    // This is how Overview hands focus back to the bucket that opened the drawer.
    const onSelect = vi.fn();
    render(<Host onSelect={onSelect} />);
    act(() => bucket(1).focus());
    expect(document.activeElement).toBe(bucket(1));
    expect(live()).toContain('Tue, Nov 3, 2026');
    key('ArrowRight'); // focus follows the cursor from bucket to bucket
    expect(document.activeElement).toBe(bucket(2));
    key('Home');
    expect(document.activeElement).toBe(bucket(0));
    key('Enter');
    expect(onSelect).toHaveBeenLastCalledWith(0);
  });

  it('forgets the cursor when focus leaves, so the readout goes back to the selected bucket', () => {
    render(<Host initial={0} />);
    focusChart();
    key('End');
    expect(screen.getByText('Sun, Nov 8, 2026')).toBeTruthy();
    act(() => chart().blur());
    expect(screen.queryByText('Sun, Nov 8, 2026')).toBeNull();
    expect(screen.getByText('Mon, Nov 2, 2026')).toBeTruthy();
    expect(live()).toBe('');
  });

  it('does nothing, and does not throw, with no buckets', () => {
    const onSelect = vi.fn();
    render(<Host buckets={[]} onSelect={onSelect} />);
    focusChart();
    key('ArrowRight');
    key('Enter');
    expect(onSelect).not.toHaveBeenCalled();
    expect(readout()).toBeTruthy();
  });
});

describe('readout', () => {
  it('says what a bucket says: counts, tokens per provider, and where there is no number, why', () => {
    render(<Host />);
    fireEvent.mouseOver(bucket(2));
    const line = screen.getByText('Wed, Nov 4, 2026').parentElement!;
    expect(line.textContent).toContain('Merged PRs: 1');
    expect(line.textContent).toContain('Codex: 40K tokens');
    expect(line.textContent).toContain('Claude Code: history unavailable');
    // a null is never read as zero
    expect(line.textContent).not.toMatch(/Claude Code: 0/);
  });

  it('reads a covered zero as a zero, and an upcoming bucket as upcoming', () => {
    render(<Host />);
    fireEvent.mouseOver(bucket(1));
    expect(screen.getByText('Tue, Nov 3, 2026').parentElement!.textContent).toContain(
      'Codex: 0 (no recorded activity)',
    );
    fireEvent.mouseOver(bucket(5));
    const upcoming = screen.getByText('Sat, Nov 7, 2026').parentElement!;
    expect(upcoming.textContent).toContain('Upcoming, no data yet');
    expect(upcoming.textContent).not.toMatch(/Merged PRs|Codex|tokens/);
  });

  it('gives each provider its own line and never adds them into a total', () => {
    render(<Host />);
    fireEvent.mouseOver(bucket(0));
    const text = screen.getByText('Mon, Nov 2, 2026').parentElement!.textContent ?? '';
    expect(text).toContain('Codex: 1.2M tokens');
    expect(text).toContain('Claude Code: 800K tokens');
    expect(text).not.toMatch(/(?<![\d.])2M\b/); // 1.2M + 800K, which is not a number the chart ever says
    expect(text.toLowerCase()).not.toContain('total');
  });

  it('follows the pointer, and returns to the selected bucket when the pointer leaves', () => {
    render(<Host initial={0} />);
    expect(screen.getByText('Mon, Nov 2, 2026')).toBeTruthy();
    fireEvent.mouseOver(bucket(1));
    expect(screen.getByText('Tue, Nov 3, 2026')).toBeTruthy();
    fireEvent.mouseLeave(chart());
    expect(screen.getByText('Mon, Nov 2, 2026')).toBeTruthy();
  });

  it('tells a new visitor how to read it, before anything is chosen', () => {
    render(<Host />);
    expect(readout()).toBeTruthy();
  });

  it('is not announced for a pointer passing by, only for the keyboard', () => {
    render(<Host />);
    fireEvent.mouseOver(bucket(0));
    expect(live()).toBe('');
  });

  it('says which coverage a figure has: partial and not yet collected', () => {
    const partial: Bucket = {
      ...WEEK[0]!,
      usage: { codex: 'partial', claude: 'stale', rail: 'partial' },
    };
    render(<Host buckets={[partial]} />);
    fireEvent.mouseOver(bucket(0));
    const text = screen.getByText(partial.label).parentElement!.textContent;
    expect(text).toContain('Codex: 1.2M tokens · partial coverage');
    expect(text).toContain('Claude Code: 800K tokens · not collected since failed refresh');
  });

  it('says "not available" when coverage is fine but the API gave no count, never 0', () => {
    const noCount: Bucket = {
      ...WEEK[0]!,
      prs: null,
      tokens: { codex: null, claude: 800_000 },
    };
    render(<Host buckets={[noCount]} />);
    fireEvent.mouseOver(bucket(0));
    const text = screen.getByText(noCount.label).parentElement!.textContent;
    expect(text).toContain('Merged PRs: not available');
    expect(text).toContain('Codex: not available');
    expect(text).toContain('Claude Code: 800K tokens');
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    const cells = within(screen.getByRole('row', { name: /Mon, Nov 2/ })).getAllByRole('cell');
    expect(cells.map((cell) => cell.textContent)).toEqual([
      'Not available',
      'Not available',
      '800,000',
      'Complete',
    ]);
  });

  it('says "no tracked repos" and "history unavailable" instead of a number', () => {
    render(<Host buckets={emptyHistory(3)} />);
    fireEvent.mouseOver(bucket(0));
    const text = screen.getByText('Day 1').parentElement!.textContent;
    expect(text).toContain('Merged PRs: no tracked repos');
    expect(text).toContain('Codex: history unavailable');
    expect(text).toContain('Claude Code: history unavailable');
  });
});

describe('hatching and the patterns', () => {
  it('fills no-history columns with the hatch pattern, and Claude Code’s tokens with their own', () => {
    const { container } = render(<Host buckets={[...emptyHistory(2), WEEK[0]!]} />);
    const patterns = [...container.querySelectorAll('pattern')];
    expect(patterns).toHaveLength(2);
    const ids = patterns.map((node) => node.id);
    const fills = [...chart().querySelectorAll('rect')]
      .map((node) => node.getAttribute('fill'))
      .filter((fill): fill is string => fill !== null && fill.startsWith('url('));
    // every url(#id) the picture uses is defined in the document
    for (const fill of fills) expect(ids).toContain(fill.slice(5, -1));
    const claude = chart().querySelector('[data-provider="claude"]');
    expect(claude?.getAttribute('fill')).toMatch(/^url\(#.+claude\)$/);
    const hatched = bucket(0).querySelectorAll('rect[fill^="url("]');
    expect(hatched.length).toBeGreaterThan(0); // the unavailable column
  });

  it('stipples unavailable history with dots, so diagonal hatching only means Claude Code', () => {
    const { container } = render(<Host buckets={[...emptyHistory(2), WEEK[0]!]} />);
    const [claude, unavailable] = [...container.querySelectorAll('pattern')];
    expect(claude!.getAttribute('patternTransform')).toBe('rotate(45)');
    expect(unavailable!.getAttribute('patternTransform')).toBeNull();
    expect(unavailable!.querySelector('circle')).toBeTruthy();
  });

  it('keeps two charts’ patterns apart', () => {
    const { container } = render(
      <>
        <Host title="One" scope="a" />
        <Host title="Two" scope="b" />
      </>,
    );
    const ids = [...container.querySelectorAll('pattern')].map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(4);
  });

  it('keeps the key in the table view', () => {
    render(<Host />);
    expect(screen.getByRole('list', { name: 'Chart key' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    expect(screen.getByRole('list', { name: 'Chart key' })).toBeTruthy();
  });

  it('lists only the providers it draws', () => {
    const codexOnly = WEEK.map((b): Bucket => ({
      ...b,
      tokens: { codex: b.tokens.codex ?? null },
      usage: { codex: b.usage.codex ?? 'none', rail: b.usage.rail ?? 'none' },
    }));
    render(<Host buckets={codexOnly} />);
    const key = within(screen.getByRole('list', { name: 'Chart key' }));
    expect(key.getByText('Codex tokens')).toBeTruthy();
    expect(key.queryByText('Claude Code tokens')).toBeNull();
    expect(key.getByText('Merged PRs')).toBeTruthy();
    expect(key.getByText('Zero, covered')).toBeTruthy();
    expect(key.getByText('History unavailable')).toBeTruthy();
    expect(key.getByText('Local coverage: complete, partial, none')).toBeTruthy();
  });
});

describe('upcoming caption', () => {
  it('says "Upcoming" once across the upcoming buckets, in the chart view only', () => {
    const { container } = render(<Host />);
    const captions = container.querySelectorAll('[data-note="upcoming"]');
    expect(captions).toHaveLength(1);
    expect(captions[0]?.textContent).toBe('Upcoming');
    expect(captions[0]?.closest('[aria-hidden="true"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    expect(container.querySelector('[data-note="upcoming"]')).toBeNull();
  });

  it('draws the upcoming axis labels in the same muted ink as the rest', () => {
    render(<Host />);
    const labels = [...chart().querySelectorAll('text')].filter((node) =>
      /^(Thu|Fri|Sat|Sun) \d$/.test(node.textContent ?? ''),
    );
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(label.getAttribute('class')).not.toContain('border-strong');
  });
});

describe('no tracked repos and unavailable history', () => {
  it('says so inside the delivery panel instead of leaving it silently empty', () => {
    render(<Host buckets={emptyHistory(8)} />);
    expect(
      within(chart() as unknown as HTMLElement).getByText('No tracked repositories'),
    ).toBeTruthy();
  });

  it('labels a long run of unavailable history with the API’s words', () => {
    render(
      <Host buckets={emptyHistory(8)} unavailableText="History unavailable before Mar 14, 2026" />,
    );
    expect(
      within(chart() as unknown as HTMLElement).getByText(
        'History unavailable before Mar 14, 2026',
      ),
    ).toBeTruthy();
  });
});

describe('width', () => {
  const width = (px: number) =>
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(px);

  it('redraws at its container’s width', () => {
    width(600);
    render(<Host />);
    expect(chart().getAttribute('width')).toBe('600');
    expect(chart().getAttribute('viewBox')).toMatch(/^0 0 600 /);
  });

  it('never draws narrower than 240px, however narrow the container', () => {
    width(120);
    render(<Host />);
    expect(chart().getAttribute('width')).toBe('240');
  });

  it('falls back to 720px before it has been measured', () => {
    render(<Host />);
    expect(chart().getAttribute('width')).toBe('720');
  });
});

describe('no animation', () => {
  it('puts no transition, animation or motion element on the bars, the selection or the cursor', () => {
    const { container } = render(<Host initial={1} />);
    focusChart();
    key('ArrowLeft');
    const svg = chart();
    for (const node of [svg, ...svg.querySelectorAll('*')]) {
      expect(node.getAttribute('class') ?? '', node.tagName).not.toMatch(
        /transition|animate|duration|ease-|delay-/,
      );
      expect(node.getAttribute('style') ?? '', node.tagName).not.toMatch(/transition|animation/);
    }
    expect(svg.querySelector('animate, animateTransform, animateMotion, set')).toBeNull();
    // nothing in the chart's own markup but the loading placeholder may pulse
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });

  it('does not animate switching between the chart and the table either', () => {
    const { container } = render(<Host />);
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    const table = container.querySelector('table')!;
    for (const node of [table, ...table.querySelectorAll('*')]) {
      expect(node.getAttribute('class') ?? '').not.toMatch(/animate/);
    }
  });
});

describe('chart and table switch', () => {
  it('starts on the chart, with the switch named for what it does', () => {
    render(<Host />);
    const group = screen.getByRole('radiogroup', { name: 'Chart display' });
    expect(within(group).getByRole('radio', { name: 'Chart' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(within(group).getByRole('radio', { name: 'Table' }).getAttribute('aria-checked')).toBe(
      'false',
    );
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('swaps the picture for the same buckets as a table, and back', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    expect(screen.queryByRole('group', { name: /Merged PRs/ })).toBeNull();
    expect(screen.getByRole('table', { name: `${TITLE}, as a table` })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Chart' }));
    expect(chart()).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  describe('the table', () => {
    const open = (props: Partial<AlignedChartProps> = {}) => {
      const view = render(<Host {...props} />);
      fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
      return view;
    };
    const row = (name: string) => screen.getByRole('row', { name: new RegExp(name) });

    it('has a column for each of merged PRs, each provider’s tokens and coverage', () => {
      open();
      const head = screen.getAllByRole('columnheader').map((cell) => cell.textContent);
      expect(head).toEqual([
        'Period',
        'Merged PRs',
        'Codex tokens',
        'Claude Code tokens',
        'Local coverage',
      ]);
    });

    it('has a row per bucket, with the readout’s words in its cells', () => {
      open();
      expect(screen.getAllByRole('row')).toHaveLength(WEEK.length + 1);
      const cells = (name: string) =>
        within(row(name))
          .getAllByRole('cell')
          .map((cell) => cell.textContent);
      expect(cells('Mon, Nov 2')).toEqual(['3', '1,200,000', '800,000', 'Complete']);
      // a covered zero is a 0; no history is "Unavailable"; neither is ever the other
      expect(cells('Tue, Nov 3')).toEqual(['0', '0', '0', 'Complete']);
      expect(cells('Wed, Nov 4')).toEqual(['1', '40,000', 'Unavailable', 'Partial']);
      // the future is a dash, not a zero
      expect(cells('Thu, Nov 5')).toEqual(['—', '—', '—', 'Upcoming']);
    });

    it('says "n/a" for no tracked repos and "No records" for a source that was never found', () => {
      const never: Bucket = {
        ...emptyHistory(1)[0]!,
        usage: { codex: 'none', claude: 'none', rail: 'none' },
      };
      open({ buckets: [never] });
      expect(
        within(row('Day 1'))
          .getAllByRole('cell')
          .map((cell) => cell.textContent),
      ).toEqual(['n/a', 'No records', 'No records', 'None']);
    });

    it('marks a partial figure with an asterisk and explains it', () => {
      open({
        buckets: [{ ...WEEK[0]!, usage: { codex: 'partial', claude: 'ok', rail: 'partial' } }],
      });
      expect(screen.getByText('1,200,000 *')).toBeTruthy();
      expect(
        screen.getByText(/^\* Partial: part of this period is before available history/),
      ).toBeTruthy();
    });

    it('makes each period a button that selects it, findable by index, and marks the selected one', () => {
      const onSelect = vi.fn();
      open({ onSelect });
      const button = screen.getByRole('button', { name: 'Tue, Nov 3, 2026' });
      expect(button.getAttribute('data-bucket-index')).toBe('1');
      fireEvent.click(button);
      expect(onSelect).toHaveBeenCalledWith(1);
      expect(
        screen.getByRole('button', { name: 'Tue, Nov 3, 2026' }).getAttribute('aria-current'),
      ).toBe('true');
      expect(
        screen.getByRole('button', { name: 'Mon, Nov 2, 2026' }).hasAttribute('aria-current'),
      ).toBe(false);
    });

    it('takes focus back onto a period by its index', () => {
      const { container } = open();
      const button = container.querySelector<HTMLElement>('[data-bucket-index="2"]')!;
      act(() => button.focus());
      expect(document.activeElement).toBe(button);
      expect(button.textContent).toBe('Wed, Nov 4, 2026');
    });

    it('scrolls sideways inside a region a keyboard can reach, and never wraps a value', () => {
      const { container } = open();
      const region = screen.getByRole('region', {
        name: 'Chart values as a table, scrolls sideways',
      });
      expect(region.getAttribute('tabindex')).toBe('0');
      for (const cell of container.querySelectorAll('td')) {
        expect(cell.className).toContain('whitespace-nowrap');
      }
    });

    it('draws only the providers it has', () => {
      open({
        buckets: WEEK.map((b): Bucket => ({
          ...b,
          tokens: { claude: b.tokens.claude ?? null },
          usage: { claude: b.usage.claude ?? 'none', rail: b.usage.rail ?? 'none' },
        })),
      });
      const head = screen.getAllByRole('columnheader').map((cell) => cell.textContent);
      expect(head).toEqual(['Period', 'Merged PRs', 'Claude Code tokens', 'Local coverage']);
    });
  });
});

describe('loading and error', () => {
  it('shows a placeholder while the series loads, and says so', () => {
    render(<Host state="loading" />);
    expect(screen.getByRole('status').textContent).toBe('Loading chart');
    expect(screen.queryByRole('group', { name: /Merged PRs/ })).toBeNull();
  });

  it('shows what went wrong, offers Try again, and leaves the table available from what it has', () => {
    const onRetry = vi.fn();
    render(<Host state="error" onRetry={onRetry} />);
    expect(screen.getByText('Couldn’t build this chart')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    expect(screen.getAllByRole('row')).toHaveLength(WEEK.length + 1);
    expect(screen.queryByText('Couldn’t build this chart')).toBeNull();
  });
});
