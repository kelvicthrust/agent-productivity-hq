// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AfkScene } from '../../../src/client/features/hq/AfkScene';
import { HqScene } from '../../../src/client/features/hq/HqScene';
import { HqRoute } from '../../../src/client/features/hq/route';
import { buildSessions } from '../../../src/client/features/hq/sessions';
import { createQueryClient } from '../../../src/client/lib/queryClient';
import { HQ_HOOKS_PROMPT_KEY, markShown } from '../../../src/client/lib/shownOnce';
import { agent, emptyRoster, officeAgents, officeRoster } from '../../fixtures/hq/scripted';

// The illustrated scene over the example office: four rooms with their signs (the session's title, then where it runs and its state), decorative only, and absent when there is nobody to draw.

const NOW = Date.parse('2026-11-04T17:42:00Z');
beforeEach(() => {
  // The hooks switch's first-time dialog has been seen on this browser, so these tests are about the page itself.
  markShown(HQ_HOOKS_PROMPT_KEY);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex], [contenteditable]';

describe('the scene', () => {
  it('draws one room per session with its sign, and is decorative', () => {
    render(<HqScene sessions={buildSessions(officeAgents(NOW))} nowMs={NOW} />);
    const scene = screen.getByTestId('hq-scene');
    expect(scene.getAttribute('aria-hidden')).toBe('true');
    // Not reachable: nothing focusable, nothing interactive, no live region, no title or description to read out.
    expect(scene.querySelectorAll(FOCUSABLE)).toHaveLength(0);
    expect(scene.querySelectorAll('[role], [aria-live], title, desc')).toHaveLength(0);

    const rooms = screen.getAllByTestId('hq-room');
    expect(rooms).toHaveLength(4);
    const signs = rooms.map((room) =>
      [...room.querySelectorAll('text')].map((text) => text.textContent).slice(0, 2),
    );
    // One column wide here (no window query answers): the title leads, then the repository and the state; the sign of the room that
    // needs the owner stops short of its star, and a long repository name gives way to the state.
    expect(signs).toEqual([
      ['Sync shared in…', 'captain + 1'],
      ['Fix the flaky chec…', 'atlas-api · solo'],
      ['Build the HQ page', 'agent-p… · captain + 3'],
      ['scratch', 'idle 12 min'],
    ]);
    expect(rooms.map((room) => room.getAttribute('data-mood'))).toEqual([
      'needs',
      'normal',
      'normal',
      'idle',
    ]);
  });

  it('names a state under each character in a few words', () => {
    render(<HqScene sessions={buildSessions(officeAgents(NOW))} nowMs={NOW} />);
    const text = screen.getByTestId('hq-scene').textContent ?? '';
    for (const caption of ['needs you', 'reading', 'editing', 'running', 'thinking', 'idle']) {
      expect(text).toContain(caption);
    }
  });

  it('gives every scene its own wobble filters, so two never share an id', () => {
    const { container } = render(
      <>
        <HqScene sessions={buildSessions(officeAgents(NOW))} nowMs={NOW} />
        <HqScene sessions={buildSessions(officeAgents(NOW))} nowMs={NOW} />
      </>,
    );
    const ids = [...container.querySelectorAll('filter')].map((filter) => filter.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });

  it('keeps a room in its phone grid row when the room above it empties', () => {
    const agents = ['first', 'middle', 'last'].map((id, index) =>
      agent(NOW, { id, provider: 'claude', startedMinutesAgo: 10 + index }),
    );
    const { rerender } = render(<HqScene sessions={buildSessions(agents)} nowMs={NOW} />);
    const row = (id: string) => {
      const room = screen.getAllByTestId('hq-room').find((el) => el.dataset['session'] === id);
      if (!room?.parentElement) throw new Error(`Missing room for ${id}`);
      return Array.from(room.parentElement.children).indexOf(room);
    };
    const before = row('middle');
    expect(before).toBe(1);

    rerender(<HqScene sessions={buildSessions(agents.slice(1))} nowMs={NOW} />);

    expect(row('middle')).toBe(before);
  });
});

describe('the AFK room', () => {
  it('is decorative, empty of characters, and gives every scene its own wobble filters', () => {
    const { container } = render(
      <>
        <AfkScene />
        <HqScene sessions={buildSessions(officeAgents(NOW))} nowMs={NOW} />
      </>,
    );
    const afk = screen.getByTestId('hq-afk');
    expect(afk.getAttribute('aria-hidden')).toBe('true');
    expect(afk.querySelectorAll(FOCUSABLE)).toHaveLength(0);
    expect(afk.querySelectorAll('[role], [aria-live], title, desc')).toHaveLength(0);
    const words = [...afk.querySelectorAll('text')].map((text) => text.textContent);
    expect(words).toEqual(['AFK', 'back', 'soon']);
    const ids = [...container.querySelectorAll('filter')].map((filter) => filter.id);
    expect(new Set(ids).size).toBe(6);
  });

  it('puts every loop behind motion-safe, so reduced motion leaves a still drawing', () => {
    render(<AfkScene />);
    const classes = [...screen.getByTestId('hq-afk').querySelectorAll('[class]')].flatMap((el) =>
      (el.getAttribute('class') ?? '').split(/\s+/),
    );
    const loops = classes.filter((name) => /animate-/.test(name));
    expect(loops.length).toBeGreaterThan(0);
    for (const name of loops) expect(name.startsWith('motion-safe:')).toBe(true);
  });
});

describe('on the page', () => {
  function mount(body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          // GET /api/hq answers the roster and whether the hooks switch is on.
          new Response(JSON.stringify({ exactPrompts: 'off', ...(body as object) }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    );
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <HqRoute />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('is drawn above the roster when there are agents', async () => {
    mount(officeRoster(NOW));
    const roster = await screen.findByRole('list', { name: 'Sessions' });
    const scene = screen.getByTestId('hq-scene');
    expect(scene.compareDocumentPosition(roster) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByTestId('hq-room')).toHaveLength(3);
  });

  it('is not drawn when there is nobody to draw', async () => {
    mount(emptyRoster(NOW));
    await waitFor(() => expect(screen.getByText(/A quiet one/)).toBeTruthy());
    expect(screen.queryByTestId('hq-scene')).toBeNull();
    // Nobody to draw means the quiet room, not an empty building.
    expect(screen.getByTestId('hq-afk')).toBeTruthy();
  });
});
