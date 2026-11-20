import { describe, expect, it } from 'vitest';
import { GEOMETRY, layoutAlignedChart, niceMax } from '../../../src/client/components/AlignedChart';
import type { Bucket } from '../../../src/shared/contracts/series';
import { WEEK, emptyHistory } from './fixtures';

// G7_3: the aligned chart's geometry. `layoutAlignedChart` is the whole picture as a pure function, so these checks need no
// browser. The constants are the prototype's (ui.js alignedChart); the semantics are the product's: a null is never a zero,
// the future is quiet, and providers are separate segments that are never added into a total.

describe('niceMax', () => {
  it('rounds up to 1, 2, 5 or 10 times a power of ten, as the prototype does', () => {
    const cases: Array<[number, number]> = [
      [1, 1],
      [1.5, 2],
      [2, 2],
      [3, 5],
      [5, 5],
      [6, 10],
      [11, 20],
      [38_100_000, 50_000_000],
      [1000, 1000],
      [1001, 2000],
      [0.7, 1],
    ];
    for (const [value, expected] of cases) expect(niceMax(value), String(value)).toBe(expected);
  });

  it('is 1 for anything that is not a positive number, so an empty axis still has a scale', () => {
    for (const value of [0, -4, Number.NaN]) expect(niceMax(value)).toBe(1);
  });
});

describe('layoutAlignedChart: size', () => {
  it('is never narrower than 240px, so text stays at 11px in a 256px card body', () => {
    expect(GEOMETRY.minWidth).toBe(240);
    for (const width of [1, 100, 239.4]) {
      const layout = layoutAlignedChart(WEEK, width);
      expect(layout.width, String(width)).toBe(240);
      for (const bucket of layout.buckets) {
        expect(bucket.band.x).toBeGreaterThanOrEqual(0);
        expect(bucket.band.x + bucket.band.width).toBeLessThanOrEqual(240);
      }
    }
  });

  it('falls back to the prototype’s 720px when the width is not known yet', () => {
    expect(layoutAlignedChart(WEEK, 0).width).toBe(720);
    expect(layoutAlignedChart(WEEK, Number.NaN).width).toBe(720);
  });

  it('draws tighter below 480px: a 40px label column and shorter panels', () => {
    const narrow = layoutAlignedChart(WEEK, 479);
    const wide = layoutAlignedChart(WEEK, 480);
    expect([narrow.padLeft, narrow.delivery.height, narrow.usage.height]).toEqual([40, 72, 104]);
    expect([wide.padLeft, wide.delivery.height, wide.usage.height]).toEqual([52, 92, 132]);
  });

  it('stacks the panels, the rail and the labels on the prototype’s grid', () => {
    const layout = layoutAlignedChart(WEEK, 720);
    expect(layout.delivery.top).toBe(26);
    expect(layout.usage.top).toBe(26 + 92 + 44);
    expect(layout.railY).toBe(layout.usage.top + 132 + 8);
    expect(layout.labelY).toBe(layout.railY + 6 + 16);
    expect(layout.height).toBe(layout.labelY + 6);
    expect(layout.plotWidth).toBe(720 - 52 - 6);
    expect(layout.usage.titleY).toBe(layout.usage.top - 14);
  });

  it('gives each bucket a column; a bar is 68% of it, never more than 28px or less than 1px', () => {
    const week = layoutAlignedChart(WEEK, 720);
    expect(week.band).toBeCloseTo(662 / 7, 1);
    expect(week.barWidth).toBe(28);
    const year = layoutAlignedChart(emptyHistory(30), 720);
    expect(year.barWidth).toBeCloseTo(((720 - 58) / 30) * 0.68, 1);
    const dense = layoutAlignedChart(
      Array.from({ length: 2000 }, () => WEEK[0]!),
      240,
    );
    expect(dense.barWidth).toBe(1);
  });
});

describe('layoutAlignedChart: two panels with their own axes', () => {
  const layout = layoutAlignedChart(WEEK, 720);

  it('scales merged PRs by their own count and tokens by their own, on separate axes', () => {
    expect(layout.delivery.max).toBe(5); // the busiest day has 3 PRs
    expect(layout.usage.max).toBe(2_000_000); // the tallest stack is 2M tokens
    expect(layout.delivery.ticks.map((tick) => tick.label)).toEqual(['5', null, '0']); // 2.5 is not a count
    expect(layout.usage.ticks.map((tick) => tick.label)).toEqual(['2M', '1M', '0']);
    expect(layout.delivery.ticks.map((tick) => tick.y)).toEqual([26, 26 + 46, 26 + 92]);
  });

  it('labels the middle of the count axis only when it is a whole number', () => {
    const ten = layoutAlignedChart([{ ...WEEK[0]!, prs: 10 }], 720);
    expect(ten.delivery.max).toBe(10);
    expect(ten.delivery.ticks.map((tick) => tick.label)).toEqual(['10', '5', '0']);
  });

  it('marks only the baseline solid', () => {
    expect(layout.usage.ticks.map((tick) => tick.baseline)).toEqual([false, false, true]);
  });
});

describe('layoutAlignedChart: what each bucket draws', () => {
  const layout = layoutAlignedChart(WEEK, 720);
  const [mon, tue, wed, thu] = layout.buckets as [
    (typeof layout.buckets)[number],
    (typeof layout.buckets)[number],
    (typeof layout.buckets)[number],
    (typeof layout.buckets)[number],
  ];

  it('draws a PR bar from the baseline, as tall as its share of the axis', () => {
    expect(mon.delivery.kind).toBe('bar');
    if (mon.delivery.kind !== 'bar') return;
    expect(mon.delivery.rect.height).toBeCloseTo((3 / 5) * 92, 1);
    expect(mon.delivery.rect.y + mon.delivery.rect.height).toBeCloseTo(26 + 92, 1);
    expect(mon.delivery.radius).toBe(3);
  });

  it('stacks the providers as separate segments, each as tall as its own tokens, Codex at the bottom', () => {
    expect(mon.usage.kind).toBe('stack');
    if (mon.usage.kind !== 'stack') return;
    const [codex, claude] = mon.usage.segments;
    expect(mon.usage.segments.map((segment) => segment.provider)).toEqual(['codex', 'claude']);
    expect(codex!.value).toBe(1_200_000);
    expect(claude!.value).toBe(800_000);
    expect(codex!.rect.height).toBeCloseTo((1_200_000 / 2_000_000) * 132, 1);
    expect(claude!.rect.height).toBeCloseTo((800_000 / 2_000_000) * 132, 1);
    // Claude sits on top of Codex, with no gap
    expect(claude!.rect.y + claude!.rect.height).toBeCloseTo(codex!.rect.y, 1);
    expect(codex!.rect.y + codex!.rect.height).toBeCloseTo(layout.usage.top + 132, 1);
  });

  it('never carries a total across providers', () => {
    expect(JSON.stringify(layout)).not.toMatch(/total/i);
    // 1.2M + 0.8M = 2M is only the height of the stack: no shape or label says it
    expect(layout.usage.ticks.map((tick) => tick.label)).not.toContain('2M tokens');
  });

  it('draws a covered zero as a flat tick in both panels, not as a bar and not as nothing', () => {
    expect(tue.delivery.kind).toBe('zero');
    expect(tue.usage.kind).toBe('zero');
    if (tue.delivery.kind === 'zero') {
      expect(tue.delivery.rect.height).toBe(1.5);
      expect(tue.delivery.rect.y).toBe(26 + 92 - 1.5);
    }
  });

  it('draws only the provider that has a number: a null is no segment, and not a zero', () => {
    expect(wed.usage.kind).toBe('stack');
    if (wed.usage.kind !== 'stack') return;
    expect(wed.usage.segments.map((segment) => segment.provider)).toEqual(['codex']);
  });

  it('draws nothing for a bucket that has not started: not a bar, not a tick, not hatching, no rail', () => {
    for (const shape of layout.buckets.slice(3)) {
      expect(shape.delivery.kind, `delivery ${shape.index}`).toBe('empty');
      expect(shape.usage.kind, `usage ${shape.index}`).toBe('empty');
      expect(shape.rail.kind, `rail ${shape.index}`).toBe('empty');
    }
    expect(thu.rail.kind).toBe('empty');
  });

  it('draws the coverage rail: solid when complete, hatched when partial', () => {
    expect(mon.rail.kind).toBe('complete');
    expect(tue.rail.kind).toBe('complete');
    expect(wed.rail.kind).toBe('partial');
    for (const shape of [mon, tue, wed]) {
      if (shape.rail.kind === 'empty') continue;
      expect(shape.rail.rect.height).toBe(6);
      expect(shape.rail.rect.y).toBe(layout.railY);
    }
  });

  it('hatches the whole usage column where there is no history, and draws an empty outline on the rail', () => {
    const none = layoutAlignedChart(emptyHistory(3), 720);
    for (const shape of none.buckets) {
      expect(shape.usage.kind).toBe('unavailable');
      if (shape.usage.kind === 'unavailable') {
        expect(shape.usage.rect.width).toBeCloseTo(none.band, 1);
        expect(shape.usage.rect.height).toBe(132);
      }
      expect(shape.rail.kind).toBe('none');
      // and the delivery panel has nothing for "no tracked repos"
      expect(shape.delivery.kind).toBe('empty');
    }
  });

  it('does not invent a zero from a missing number', () => {
    const noNumbers: Bucket = {
      ...WEEK[0]!,
      prs: null,
      tokens: { codex: null, claude: null },
      usage: { codex: 'ok', claude: 'ok', rail: 'ok' },
    };
    const [shape] = layoutAlignedChart([noNumbers], 720).buckets;
    expect(shape!.delivery.kind).toBe('empty'); // the API said "synced" but gave no count
    expect(shape!.usage.kind).toBe('empty'); // and said "covered" but gave no tokens
  });

  it('does not tick a zero while the first backfill is still running', () => {
    const syncing = (prs: number | null): Bucket => ({ ...WEEK[0]!, delivery: 'syncing', prs });
    const layoutOf = (prs: number | null) => layoutAlignedChart([syncing(prs)], 720).buckets[0]!;
    expect(layoutOf(0).delivery.kind).toBe('empty');
    expect(layoutOf(null).delivery.kind).toBe('empty');
    expect(layoutOf(2).delivery.kind).toBe('bar'); // a count so far is still a count
  });
});

describe('layoutAlignedChart: providers', () => {
  it('draws the providers the buckets carry, so a provider filter leaves the other out', () => {
    const codexOnly = WEEK.map((bucket): Bucket => ({
      ...bucket,
      tokens: { codex: bucket.tokens.codex ?? null },
      usage: { codex: bucket.usage.codex ?? 'none', rail: bucket.usage.rail ?? 'none' },
    }));
    const layout = layoutAlignedChart(codexOnly, 720);
    expect(layout.providers).toEqual(['codex']);
    const mon = layout.buckets[0]!;
    if (mon.usage.kind === 'stack') {
      expect(mon.usage.segments.map((segment) => segment.provider)).toEqual(['codex']);
    }
  });

  it('takes the providers it is told to draw', () => {
    const layout = layoutAlignedChart(WEEK, 720, { providers: ['claude'] });
    expect(layout.providers).toEqual(['claude']);
    const mon = layout.buckets[0]!;
    if (mon.usage.kind === 'stack') {
      expect(mon.usage.segments.map((segment) => segment.provider)).toEqual(['claude']);
    }
  });

  it('scales the usage axis by the providers in the chart: leaving one out shortens the stack', () => {
    const heavy: Bucket = { ...WEEK[0]!, tokens: { codex: 3_000_000, claude: 3_000_000 } };
    expect(layoutAlignedChart([heavy], 720).usage.max).toBe(10_000_000); // a 6M stack
    expect(layoutAlignedChart([heavy], 720, { providers: ['codex'] }).usage.max).toBe(5_000_000);
  });

  it('sets the usage scale from what is drawn, not from hatched or upcoming buckets', () => {
    const huge: Bucket = {
      ...WEEK[0]!,
      tokens: { codex: 900_000_000, claude: 900_000_000 },
      usage: { codex: 'unavailable', claude: 'unavailable', rail: 'unavailable' },
    };
    expect(layoutAlignedChart([huge, WEEK[0]!], 720).usage.max).toBe(2_000_000);
  });
});

describe('layoutAlignedChart: notes and labels', () => {
  it('says once, in the middle of a long run of hatched history, that history is unavailable', () => {
    const layout = layoutAlignedChart(emptyHistory(12), 720, {
      unavailableText: 'History unavailable before Mar 14, 2026',
    });
    expect(layout.notes).toHaveLength(1);
    const [note] = layout.notes;
    expect(note!.kind).toBe('unavailable');
    expect(note!.text).toBe('History unavailable before Mar 14, 2026');
    expect(note!.x).toBeCloseTo(52 + layout.plotWidth / 2, 0);
  });

  it('says it again for each separate run, and not at all when a run cannot hold the words', () => {
    const text = 'History unavailable';
    // two hatched days among sixty are about 21px wide: too narrow for a 128px note
    const crowded = [...Array.from({ length: 60 }, () => WEEK[0]!), ...emptyHistory(2)];
    expect(layoutAlignedChart(crowded, 720, { unavailableText: text }).notes).toHaveLength(0);
    const split = [...emptyHistory(8), WEEK[0]!, ...emptyHistory(8)];
    expect(layoutAlignedChart(split, 720, { unavailableText: text }).notes).toHaveLength(2);
  });

  it('says there are no tracked repos inside the delivery panel when asked to', () => {
    const layout = layoutAlignedChart(emptyHistory(3), 720, {
      noDeliveryText: 'No tracked repositories',
    });
    const note = layout.notes.find((item) => item.kind === 'no-delivery');
    expect(note?.text).toBe('No tracked repositories');
    expect(note!.y).toBeGreaterThan(layout.delivery.top);
    expect(note!.y).toBeLessThan(layout.delivery.top + layout.delivery.height);
  });

  it('thins the axis labels to one per 64px, always starting with the first bucket', () => {
    const layout = layoutAlignedChart(emptyHistory(30), 400);
    expect(layout.xLabels.map((label) => label.index)).toEqual([0, 6, 12, 18, 24]);
    expect(layout.xLabels[0]!.text).toBe('Jan 1');
    const week = layoutAlignedChart(WEEK, 720);
    expect(week.xLabels).toHaveLength(7); // 7 buckets, room for 10
  });

  it('flags the label of a bucket that has not started', () => {
    const labels = layoutAlignedChart(WEEK, 720).xLabels;
    expect(labels.map((label) => label.upcoming)).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
      true,
    ]);
  });
});

describe('layoutAlignedChart: upcoming caption', () => {
  it('captions the run of upcoming buckets once, centred across it in the usage panel', () => {
    const layout = layoutAlignedChart(WEEK, 720, { upcomingText: 'Upcoming' });
    const caption = layout.upcomingNote;
    expect(caption?.text).toBe('Upcoming');
    // WEEK has four upcoming buckets at the end: the run starts at bucket 3 and ends at the plot's right edge.
    expect(caption!.x).toBeCloseTo(52 + 3 * layout.band + (4 * layout.band) / 2, 0);
    expect(caption!.y).toBeGreaterThan(layout.usage.top);
    expect(caption!.y).toBeLessThan(layout.usage.top + layout.usage.height);
  });

  it('captions a single upcoming bucket when its band can hold the word', () => {
    const layout = layoutAlignedChart(WEEK.slice(0, 4), 720, { upcomingText: 'Upcoming' });
    expect(layout.upcomingNote?.x).toBeCloseTo(52 + 3 * layout.band + layout.band / 2, 0);
  });

  it('stays silent when the upcoming run is too narrow for the word, with no run, or when not asked', () => {
    // A month-long range on a phone with the last two days to come: each band is about 11px, far too narrow for "Upcoming".
    const month = [...Array.from({ length: 28 }, () => WEEK[0]!), WEEK[6]!, WEEK[6]!];
    expect(layoutAlignedChart(month, 390, { upcomingText: 'Upcoming' }).upcomingNote).toBe(null);
    expect(
      layoutAlignedChart(WEEK.slice(0, 3), 720, { upcomingText: 'Upcoming' }).upcomingNote,
    ).toBe(null);
    expect(layoutAlignedChart(WEEK, 720).upcomingNote).toBe(null);
  });
});

describe('layoutAlignedChart: edges', () => {
  it('lays out an empty series without a shape', () => {
    const layout = layoutAlignedChart([], 720);
    expect(layout.buckets).toEqual([]);
    expect(layout.xLabels).toEqual([]);
    expect(layout.delivery.max).toBe(1);
  });

  it('is pure: the same input gives the same picture and the input is left alone', () => {
    const before = JSON.stringify(WEEK);
    const first = layoutAlignedChart(WEEK, 600);
    expect(layoutAlignedChart(WEEK, 600)).toEqual(first);
    expect(JSON.stringify(WEEK)).toBe(before);
  });
});
