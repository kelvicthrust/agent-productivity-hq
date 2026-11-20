// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appRoutes } from '../../src/client/app/router';
import { createQueryClient, queryKeys } from '../../src/client/lib/queryClient';

// Structure and behaviour of the app shell that do not need real layout: DOM order, names, landmarks, the six
// routes plus setup, and focus on route change. What needs layout (which nav is visible at which width, tap
// targets, no sideways scroll) is in test/e2e/shell.spec.ts, which needs a browser.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// The shell now asks the server for the issue count. These tests are about structure, so the server is not reachable
// here: the count stays unknown and nothing about it is drawn (test/client covers the count itself).
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError('no server in this test'))),
  );
});

function mount(path: string, sourceIssues?: number) {
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
  const client = createQueryClient();
  if (sourceIssues !== undefined) {
    client.setQueryData(queryKeys.bootstrap, {
      setupComplete: true,
      timezone: 'America/Los_Angeles',
      today: '2026-11-04',
      lookbackStart: '2025-11-04',
      issues: Array.from({ length: sourceIssues }, (_, i) => ({
        kind: 'source',
        id: `s${i}`,
        label: 'Unavailable',
      })),
    });
  }
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}
const navs = () => screen.queryAllByRole('navigation', { name: 'Sections' });
// The app bar is the first banner: a screen's own header counts as one in jsdom.
const appBar = () => screen.getAllByRole('banner')[0] as HTMLElement;

describe('routes', () => {
  // Every screen is built: they are covered by their own specs, so here they only have to render their heading and title (their data
  // is not reachable in these tests).
  const built: Array<[path: string, heading: string]> = [
    ['/', 'Overview'],
    ['/trends', 'Trends'],
    ['/hq', 'HQ'],
    ['/setup', 'Setup'],
  ];

  it.each(built)(
    '%s renders its heading and is no longer Under Construction',
    async (path, heading) => {
      mount(path);
      expect(
        await screen.findByRole('heading', { level: 1, name: new RegExp(`^${heading}`) }),
      ).toBeTruthy();
      expect(screen.queryByText('Under Construction')).toBeNull();
      expect(document.title).toBe(`${heading} · Agent Productivity HQ`);
    },
  );

  it('shows a not-found page with a way back, not a blank screen', () => {
    mount('/no/such/page');
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to Overview' }).getAttribute('href')).toBe('/');
  });

  it('setup has no navigation, only the app bar and content', () => {
    mount('/setup');
    expect(navs()).toHaveLength(0);
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
  });
});

describe('landmarks and order', () => {
  it('has a skip link first, then banner, nav, main, and the phone tab bar last', () => {
    const { container } = mount('/trends');
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(skip.getAttribute('href')).toBe('#main');
    expect(container.querySelector('#main')).toBe(screen.getByRole('main'));

    const [side, phone] = navs();
    const main = screen.getByRole('main');
    const banner = screen.getByRole('banner');
    const follows = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(navs()).toHaveLength(2); // both exist; CSS shows exactly one at each width
    expect(follows(skip, banner)).toBe(true);
    expect(follows(banner, side as Node)).toBe(true);
    expect(follows(side as Node, main)).toBe(true);
    // DOM order is visual order: the bar is drawn at the bottom, so it comes after main (WCAG 2.4.3).
    expect(follows(main, phone as Node)).toBe(true);
  });

  it('main can take programmatic focus for the skip link target', () => {
    mount('/');
    expect(screen.getByRole('main').getAttribute('tabindex')).toBe('-1');
  });
});

describe('navigation', () => {
  it.each([
    [0, 'Sources & repos'],
    [1, /^Sources & repos\s*, 1 issue$/],
  ])('puts the Sources link in navigation with %i issues', (sourceIssues, name) => {
    mount('/trends', sourceIssues);
    const banner = within(screen.getByRole('banner'));
    // The banner's only link is HQ's, which shows on a phone in place of a sixth tab; Sources is never one of them.
    expect(banner.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['/hq']);
    expect(banner.getByRole('button', { name: 'Refresh' })).toBeTruthy();
    for (const nav of navs()) {
      expect(within(nav).getByRole('link', { name }).getAttribute('href')).toBe('/sources');
    }
  });

  it("lists six destinations in the side nav and the design's five on the phone tab bar", () => {
    mount('/');
    const [side, phone] = navs() as [HTMLElement, HTMLElement];
    const five = ['Overview', 'Trends', 'Delivery', 'Usage', 'Sources & repos'];
    // HQ follows Usage in the side nav; on a phone it is the app bar's link, never a sixth tab.
    const six = ['Overview', 'Trends', 'Delivery', 'Usage', 'HQ', 'Sources & repos'];
    for (const [nav, expected] of [
      [side, six],
      [phone, five],
    ] as const) {
      const links = within(nav).getAllByRole('link');
      expect(links).toHaveLength(expected.length);
      // Same order as the design, by accessible name.
      expect(expected.map((name) => within(nav).getByRole('link', { name }))).toEqual(links);
    }
    expect(within(phone).queryByRole('link', { name: 'HQ' })).toBeNull();
  });

  it('offers HQ as an app bar link named "HQ", visible only below 720px, marked current on /hq', () => {
    mount('/');
    const link = within(appBar()).getByRole('link', { name: 'HQ' });
    expect(link.getAttribute('href')).toBe('/hq');
    expect(link.getAttribute('aria-current')).toBeNull();
    expect(link.className).toContain('min-[720px]:hidden');
    cleanup();
    mount('/hq');
    const current = within(appBar()).getByRole('link', { name: 'HQ' });
    expect(current.getAttribute('aria-current')).toBe('page');
  });

  it('draws no app bar HQ link on Setup', () => {
    mount('/setup');
    expect(within(appBar()).queryByRole('link', { name: 'HQ' })).toBeNull();
  });

  it('marks only the current page with aria-current in both navs', () => {
    mount('/delivery');
    for (const nav of navs()) {
      const current = within(nav)
        .getAllByRole('link')
        .filter((l) => l.getAttribute('aria-current') === 'page');
      expect(current.map((l) => l.getAttribute('href'))).toEqual(['/delivery']);
    }
  });

  it('does not mark Overview current on other pages', () => {
    mount('/trends');
    for (const nav of navs()) {
      expect(
        within(nav).getByRole('link', { name: 'Overview' }).getAttribute('aria-current'),
      ).toBeNull();
    }
  });

  it('shows "Sources" on the phone bar but keeps the full accessible name', () => {
    mount('/');
    const phone = navs()[1] as HTMLElement;
    const link = within(phone).getByRole('link', { name: 'Sources & repos' });
    expect(link.querySelector('span[aria-hidden="true"]')?.textContent).toBe('Sources');
    expect(link.querySelector('.sr-only')?.textContent).toBe('Sources & repos');
  });
});

describe('focus on route change', () => {
  it('does not move focus on first load', () => {
    mount('/delivery');
    expect(document.activeElement).toBe(document.body);
  });

  it('moves focus to the new page heading and updates the title', async () => {
    mount('/');
    fireEvent.click(within(navs()[0] as HTMLElement).getByRole('link', { name: 'Trends' }));
    const heading = await screen.findByRole('heading', { level: 1, name: 'Trends' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(document.title).toBe('Trends · Agent Productivity HQ');

    fireEvent.click(
      within(navs()[1] as HTMLElement).getByRole('link', { name: 'Sources & repos' }),
    );
    const next = await screen.findByRole('heading', { level: 1, name: 'Sources & repos' });
    await waitFor(() => expect(document.activeElement).toBe(next));
  });
});
