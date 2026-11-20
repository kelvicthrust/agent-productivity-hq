// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appRoutes } from '../../src/client/app/router';
import { createQueryClient } from '../../src/client/lib/queryClient';

// First launch (G10_1; TECH J1: "First load → GET /api/bootstrap says setupComplete=false → router redirects to /setup"): the shell
// sends an unfinished setup to /setup, a finished one is never sent there, nothing is decided while the server has not answered
// or cannot be reached, and /setup keeps no navigation and no filters. The filters sit under a screen's title; Sources has none.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const BOOTSTRAP = (setupComplete: boolean) => ({
  setupComplete,
  timezone: 'America/Los_Angeles',
  today: '2026-11-04',
  lookbackStart: '2025-11-05',
  issues: [],
});

type Bootstrap = 'unfinished' | 'finished' | 'unreachable' | 'pending';

/** The app's own bootstrap answer, and nothing else: every other request fails as if no server were there. */
function server(bootstrap: Bootstrap) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url !== '/api/bootstrap') return Promise.reject(new TypeError('no server in this test'));
      if (bootstrap === 'unreachable') return Promise.reject(new TypeError('no server'));
      if (bootstrap === 'pending') return new Promise<Response>(() => undefined);
      return Promise.resolve(
        new Response(JSON.stringify(BOOTSTRAP(bootstrap === 'finished')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
}

function mount(path: string, bootstrap: Bootstrap) {
  server(bootstrap);
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const at = (router: ReturnType<typeof mount>) => router.state.location.pathname;
const navs = () => screen.queryAllByRole('navigation', { name: 'Sections' });

describe('an unfinished setup', () => {
  it.each(['/', '/trends', '/delivery', '/usage', '/hq', '/sources', '/no/such/page'])(
    'sends %s to /setup, replacing the entry so Back does not return to a page that would bounce again',
    async (path) => {
      const router = mount(path, 'unfinished');
      await waitFor(() => expect(at(router)).toBe('/setup'));
      expect(router.state.historyAction).toBe('REPLACE');
      // The address changes before the screen is drawn: wait for the heading rather than reading it the instant the address moves.
      expect(await screen.findByRole('heading', { level: 1, name: /^Setup/ })).toBeTruthy();
    },
  );

  it('keeps /setup without navigation and without filters', async () => {
    const router = mount('/usage', 'unfinished');
    await waitFor(() => expect(at(router)).toBe('/setup'));
    await screen.findByRole('heading', { level: 1, name: /^Setup/ });
    expect(navs()).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'Filters' })).toBeNull();
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
  });
});

describe('a finished setup', () => {
  it.each(['/', '/trends', '/usage', '/hq', '/sources', '/no/such/page'])(
    'never sends %s anywhere',
    async (path) => {
      const router = mount(path, 'finished');
      // Give the bootstrap answer time to arrive and be acted on: nothing moves.
      await waitFor(() =>
        expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0),
      );
      await new Promise((done) => setTimeout(done, 50));
      expect(at(router)).toBe(path);
    },
  );

  it('draws the navigation and the filters on a screen, so their absence on /setup means something', async () => {
    const router = mount('/usage', 'finished');
    await waitFor(() => expect(screen.getByRole('region', { name: 'Filters' })).toBeTruthy());
    expect(navs().length).toBeGreaterThan(0);
    expect(at(router)).toBe('/usage');
  });

  it('draws the filters under the title, and not at all on Sources & repos or HQ', async () => {
    mount('/usage', 'finished');
    const region = await screen.findByRole('region', { name: 'Filters' });
    const heading = screen.getByRole('heading', { level: 1, name: /^Usage/ });
    expect(heading.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    cleanup();

    mount('/sources', 'finished');
    await screen.findByRole('heading', { level: 1, name: /^Sources/ });
    expect(screen.queryByRole('region', { name: 'Filters' })).toBeNull();
    cleanup();

    mount('/hq', 'finished');
    await screen.findByRole('heading', { level: 1, name: /^HQ/ });
    expect(screen.queryByRole('region', { name: 'Filters' })).toBeNull();
  });

  it('leaves /setup reachable: the owner can look at it again', async () => {
    const router = mount('/setup', 'finished');
    await new Promise((done) => setTimeout(done, 50));
    expect(at(router)).toBe('/setup');
    expect(await screen.findByRole('heading', { level: 1, name: /^Setup/ })).toBeTruthy();
  });
});

describe('before the server has said anything', () => {
  it.each<Bootstrap>(['pending', 'unreachable'])(
    'decides nothing while the bootstrap is %s, so a slow or missing server never moves the owner',
    async (state) => {
      const router = mount('/usage', state);
      await new Promise((done) => setTimeout(done, 50));
      expect(at(router)).toBe('/usage');
    },
  );
});
