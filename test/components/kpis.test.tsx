// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Kpis } from '../../src/client/features/overview/Kpis';
import type { Filters } from '../../src/client/lib/filters';
import type { Overview, SeriesBucket } from '../../src/client/lib/analytics';

// The Overview tiles' 12-week sparklines: Merged PRs has one, and each provider in the tokens tile has its own, drawn from that
// provider's own weeks and never added to the other's. The tile's figures and its crew cluster are checked here too.

const trend = vi.hoisted(() => ({
  state: { data: undefined, isPending: false } as {
    data: { buckets: unknown[] } | undefined;
    isPending: boolean;
    isPlaceholderData?: boolean;
  },
}));
vi.mock('../../src/client/lib/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/client/lib/analytics')>()),
  useKpiTrend: () => trend.state,
}));

afterEach(cleanup);
beforeEach(() => {
  trend.state = { data: undefined, isPending: false };
});

const weeks = (
  prs: (number | null)[],
  codex: (number | null)[],
  claude: (number | null)[],
): SeriesBucket[] =>
  prs.map(
    (value, i) =>
      ({
        start: `2026-0${(i % 9) + 1}-01`,
        end: `2026-0${(i % 9) + 1}-07`,
        label: `Week ${i}`,
        short: `${i}`,
        prs: value,
        delivery: 'ok',
        tokens: { codex: codex[i] ?? null, claude: claude[i] ?? null },
        usage: {},
      }) as SeriesBucket,
  );

const filters: Filters = {
  start: '2026-11-02',
  end: '2026-11-08',
  gran: 'day',
  repos: [],
  provider: 'all',
  author: 'mine',
};

function overview(providers: ('codex' | 'claude')[] = ['codex', 'claude'], crew = 5): Overview {
  const tokens = {
    codex: { value: 10_400_000, coverage: 'ok' },
    claude: { value: 23_000_000, coverage: 'ok' },
  };
  return {
    scope: {
      ...filters,
      timezone: 'America/Los_Angeles',
      provider: providers.length === 2 ? 'all' : providers[0],
    },
    kpis: {
      mergedPrs: { value: 8, delivery: 'ok', previous: { label: 'Last week', value: 7 } },
      linkedPrs: { value: 5, of: 8, suggestedOnly: 1 },
      localTokens: Object.fromEntries(providers.map((p) => [p, tokens[p]])),
      rootSessions: {
        value: crew,
        unknownRelationship: 0,
        crew: ['codex', 'claude', 'codex', 'claude', 'codex'].slice(0, crew),
      },
      childAgents: { value: 2, paseo: 1, native: 1, crew: ['codex', 'claude'] },
    },
  } as unknown as Overview;
}

const show = (data: Overview, stale = false) =>
  render(
    <MemoryRouter>
      <Kpis data={data} busy={false} stale={stale} filters={filters} />
    </MemoryRouter>,
  );
const tile = (name: string) => screen.getByRole('group', { name });
const sparks = (el: HTMLElement) => within(el).queryAllByRole('img');

describe('KPI sparklines', () => {
  it('draws one for Merged PRs and one per provider in the tokens tile, each from its own weeks', () => {
    trend.state = {
      isPending: false,
      data: {
        buckets: weeks([1, 2, 3], [100, 200, 300], [null, 5, 7]),
      },
    };
    show(overview());
    const merged = sparks(tile('Merged PRs'));
    expect(merged.map((el) => el.getAttribute('aria-label'))).toEqual([
      '3-week trend, oldest to newest: 1, 2, 3; this week 3',
    ]);
    const tokens = sparks(tile('Recorded local tokens')).map((el) => el.getAttribute('aria-label'));
    expect(tokens).toEqual([
      'Codex 3-week trend, oldest to newest: 100, 200, 300; this week 300',
      // A week with no figure is "no data", not 0, and the line is cut there.
      'Claude Code 3-week trend, oldest to newest: no data, 5, 7; this week 7',
    ]);
    // Two series, each its provider's own: there is no third line that adds them.
    expect(tokens).toHaveLength(2);
  });

  it('draws only the provider the tile shows when the provider filter leaves one', () => {
    trend.state = { isPending: false, data: { buckets: weeks([1, 2], [100, 200], [5, 7]) } };
    show(overview(['claude']));
    expect(
      sparks(tile('Recorded local tokens')).map((el) => el.getAttribute('aria-label')),
    ).toEqual(['Claude Code 2-week trend, oldest to newest: 5, 7; this week 7']);
  });

  it('shows the current week when it is the only week a provider has recorded', () => {
    const covered = Array.from({ length: 12 }, (_, i) => i + 1);
    const gaps = Array.from({ length: 11 }, () => null);
    trend.state = {
      isPending: false,
      data: { buckets: weeks(covered, covered, [...gaps, 23_000_000]) },
    };
    show(overview());
    const tokens = tile('Recorded local tokens');
    const firstWeek = within(tokens).getByRole('img', {
      name: /^Claude Code 12-week trend, oldest to newest: (no data, ){11}23M; this week 23M$/,
    });
    expect(firstWeek.querySelector('circle[data-current]')).toBeTruthy();
    expect(sparks(tokens)).toHaveLength(2);
  });

  it('holds a quiet line’s place while the trend loads, and says nothing in words', () => {
    trend.state = { isPending: true, data: undefined };
    const { container } = show(overview());
    expect(sparks(tile('Merged PRs'))).toHaveLength(0);
    expect(
      container.querySelectorAll(
        '[aria-hidden="true"].animate-pulse, [aria-hidden="true"][class*="animate-pulse"]',
      ).length,
    ).toBeGreaterThan(0);
  });

  it('does not draw the previous scope’s weeks while a changed filter loads', () => {
    trend.state = {
      isPending: false,
      isPlaceholderData: true,
      data: { buckets: weeks([1, 2, 3], [1, 2, 3], [1, 2, 3]) },
    };
    show(overview());
    expect(screen.queryAllByRole('img')).toHaveLength(0);
  });

  it('does not draw a new scope’s weeks beside figures still from the previous filter', () => {
    trend.state = { isPending: false, data: { buckets: weeks([1, 2, 3], [1, 2, 3], [1, 2, 3]) } };
    show(overview(), true);
    expect(screen.queryAllByRole('img')).toHaveLength(0);
  });

  it('leaves the tiles as they were when the trend cannot be read', () => {
    trend.state = { isPending: false, data: undefined };
    show(overview());
    expect(screen.queryAllByRole('img')).toHaveLength(0);
    expect(tile('Merged PRs').textContent).toContain('8');
    expect(tile('Recorded local tokens').textContent).toContain('Provider totals aren’t combined.');
  });

  it('draws none for Merged PRs while it is still syncing, or when no repo is tracked', () => {
    trend.state = { isPending: false, data: { buckets: weeks([1, 2, 3], [1, 2, 3], [1, 2, 3]) } };
    const syncing = overview();
    (syncing.kpis.mergedPrs as { delivery: string }).delivery = 'syncing';
    show(syncing);
    expect(sparks(tile('Merged PRs'))).toHaveLength(0);
    cleanup();
    const none = overview();
    (none.kpis.mergedPrs as { delivery: string }).delivery = 'none';
    show(none);
    expect(sparks(tile('Merged PRs'))).toHaveLength(0);
  });
});

describe('the crew cluster', () => {
  it('shows the first three buddies and the count of the rest', () => {
    show(overview(['codex', 'claude'], 5));
    const roots = tile('Root sessions');
    expect(roots.querySelectorAll('svg')).toHaveLength(3);
    expect(roots.textContent).toContain('+2');
    // The count is the figure; the cluster is decoration and leaves no words of its own.
    expect(roots.querySelector('[aria-hidden="true"]')?.textContent).toBe('+2');
  });

  it('shows no "+N" when there are three or fewer', () => {
    show(overview(['codex', 'claude'], 3));
    expect(tile('Root sessions').textContent).not.toContain('+');
    expect(tile('Child agents').querySelectorAll('svg')).toHaveLength(2);
  });
});
