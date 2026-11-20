// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IssueBadge } from '../../src/client/app/IssueBadge';
import { createQueryClient, queryKeys } from '../../src/client/lib/queryClient';

// The issue count the shell shows comes from /api/bootstrap, and says nothing until it is known.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const bootstrap = (issues: number) => ({
  setupComplete: true,
  timezone: 'America/Los_Angeles',
  today: '2026-11-04',
  lookbackStart: '2025-11-04',
  issues: Array.from({ length: issues }, (_, i) => ({ kind: 'source', id: `s${i}`, label: 'x' })),
});

function mount(answer: () => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(answer));
  const client = createQueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <IssueBadge />
    </QueryClientProvider>,
  );
  return { ...view, client };
}
const ok = (issues: number) => () =>
  Promise.resolve(
    new Response(JSON.stringify(bootstrap(issues)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

describe('the issue count', () => {
  it('shows nothing while it is unknown, and nothing when the app cannot be reached', async () => {
    const { container } = mount(() => new Promise(() => undefined));
    expect(container.textContent).toBe('');
    cleanup();
    const failed = mount(() => Promise.reject(new TypeError('offline')));
    await new Promise((r) => setTimeout(r, 20));
    expect(failed.container.textContent).toBe('');
  });

  it('shows no badge when the reported count is zero', async () => {
    const { client, container } = mount(ok(0));
    await waitFor(() => expect(client.getQueryState(queryKeys.bootstrap)?.status).toBe('success'));
    expect(container.textContent).toBe('');
  });

  it('shows the numeric badge and reads it as words', async () => {
    const { container } = mount(ok(2));
    expect(await screen.findByText(', 2 issues')).toBeTruthy();
    const badge = container.querySelector('[aria-hidden="true"]');
    expect(badge?.textContent).toBe('2');
  });

  it('uses the singular for one issue', async () => {
    mount(ok(1));
    expect(await screen.findByText(', 1 issue')).toBeTruthy();
  });
});
