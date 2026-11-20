// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HqScene } from '../../../src/client/features/hq/HqScene';
import { agent } from '../../fixtures/hq/scripted';

// The drawn grid at each column count (the layout rules themselves are in scene.test.ts): a surviving room keeps its cell when a room
// above it empties, a vacated cell stays an empty room, rows after the last occupied cell go, and there is no "+N more".

const NOW = Date.parse('2026-11-04T17:42:00Z');

/** Pretends the window is `width` px wide for the `(min-width: N px)` queries the scene asks. */
function windowOf(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const min = Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? Infinity);
    return {
      matches: width >= min,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const sessions = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    agent(NOW, { id: `s${i}`, provider: 'claude', startedMinutesAgo: 10 + i }),
  );

/** The grid's cells in order: the session id of a room, or null for an empty room. */
function grid(): (string | null)[] {
  const scene = screen.getByTestId('hq-scene');
  const cells = scene.querySelector('.grid')?.children ?? [];
  return Array.from(cells).map((cell) => cell.getAttribute('data-session'));
}

describe.each([
  [1, 1],
  [2, 720],
  [3, 1280],
] as const)('%i column(s)', (columns, width) => {
  beforeEach(() => windowOf(width));

  it('keeps a surviving room in its cell when the first, a middle or the last room empties', () => {
    const all = sessions(7);
    const { rerender } = render(<HqScene agents={all} nowMs={NOW} />);
    expect(grid()).toEqual([...all.map((a) => a.id), ...pad(columns, 7)]);
    const rows = Math.ceil(7 / columns);
    expect(screen.getByTestId('hq-scene').querySelector('.grid')?.getAttribute('style')).toContain(
      `repeat(${columns}, minmax(0px, 1fr))`,
    );

    rerender(<HqScene agents={all.slice(1)} nowMs={NOW} />);
    expect(grid()).toEqual([null, ...all.slice(1).map((a) => a.id), ...pad(columns, 7)]);

    rerender(<HqScene agents={all.filter((a) => a.id !== 's3' && a.id !== 's0')} nowMs={NOW} />);
    expect(grid()).toEqual([null, 's1', 's2', null, 's4', 's5', 's6', ...pad(columns, 7)]);

    // A newcomer takes the lowest empty cell.
    rerender(
      <HqScene
        agents={[
          ...all.filter((a) => a.id !== 's3' && a.id !== 's0'),
          agent(NOW, { id: 'n', provider: 'claude' }),
        ]}
        nowMs={NOW}
      />,
    );
    expect(grid()).toEqual(['n', 's1', 's2', null, 's4', 's5', 's6', ...pad(columns, 7)]);

    // The last row goes when its last room does, and nothing above it moves.
    const fewer = sessions(columns === 1 ? 6 : columns * (rows - 1));
    rerender(<HqScene agents={fewer} nowMs={NOW} />);
    expect(grid()).toEqual(fewer.map((a) => a.id));
  });

  it('draws every session and no "+N more", however many there are', () => {
    render(<HqScene agents={sessions(25)} nowMs={NOW} />);
    expect(screen.getAllByTestId('hq-room')).toHaveLength(25);
    expect(screen.getByTestId('hq-scene').textContent).not.toMatch(/\+\d+ more/);
  });
});

/** The text of every room's sign, two lines each, in the order the rooms are drawn. */
const signs = () =>
  screen
    .getAllByTestId('hq-room')
    .map((room) => [...room.querySelectorAll('text')].slice(0, 2).map((text) => text.textContent));

// What the signs say, drawn: each chat's title on the first line, so two chats in one repository do not look like one.
describe.each([
  [1, 1],
  [2, 720],
  [3, 1280],
] as const)('the signs at %i column(s)', (_columns, width) => {
  beforeEach(() => windowOf(width));
  const repo = 'kelvin/usage-metrics';

  it('gives two chats in the same repository different first lines', () => {
    render(
      <HqScene
        agents={[
          agent(NOW, {
            id: 'a',
            provider: 'claude',
            repo,
            title: 'Fix login',
            startedMinutesAgo: 9,
          }),
          agent(NOW, {
            id: 'b',
            provider: 'codex',
            repo,
            title: 'Weekly digest',
            startedMinutesAgo: 8,
          }),
        ]}
        nowMs={NOW}
      />,
    );
    // Newest first: b, then a. Both are in the same repository and say so on the second line.
    expect(signs()).toEqual([
      ['Weekly digest', 'usage-metrics · solo'],
      ['Fix login', 'usage-metrics · solo'],
    ]);
  });

  it('falls back to the repository name without saying it twice when there is no title', () => {
    render(<HqScene agents={[agent(NOW, { id: 'a', provider: 'claude', repo })]} nowMs={NOW} />);
    expect(signs()).toEqual([['usage-metrics', 'solo']]);
  });

  it('cuts a very long title with an ellipsis, and keeps the state when the repository name is long', () => {
    const title = 'Investigate why the nightly import job keeps timing out on large repositories';
    render(
      <HqScene
        agents={[
          agent(NOW, {
            id: 'a',
            provider: 'claude',
            repo: 'kelvin/a-very-long-repository-name-indeed',
            title,
            state: 'idle',
            activity: 'none',
            sinceMinutesAgo: 12,
          }),
        ]}
        nowMs={NOW}
      />,
    );
    const [first, second] = signs()[0] ?? [];
    expect(first?.endsWith('…')).toBe(true);
    expect(title.startsWith((first ?? '').slice(0, -1))).toBe(true);
    expect(first?.length).toBeLessThan(title.length);
    expect(second?.endsWith('idle 12 min')).toBe(true);
    expect(second).toContain('…');
  });
});

/** The empty rooms that complete the last row of `used` cells. */
const pad = (columns: number, used: number) =>
  Array.from({ length: (columns - (used % columns)) % columns }, () => null);
