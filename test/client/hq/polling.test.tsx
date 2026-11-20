// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HqRoute } from '../../../src/client/features/hq/route';
import { createQueryClient } from '../../../src/client/lib/queryClient';
import { HQ_HOOKS_PROMPT_KEY, markShown } from '../../../src/client/lib/shownOnce';
import { NOW } from '../../server/helpers';
import { emptyRoster } from '../../fixtures/hq/scripted';

// The page polls /api/hq every 2 s, and every 10 s after a failed request (docs/tech/local-api.md). Timers are faked so the
// intervals are measured, not waited for.

beforeEach(() => {
  // The hooks switch's first-time dialog has been seen on this browser, so these tests are about the page itself.
  markShown(HQ_HOOKS_PROMPT_KEY);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mount(answers: Array<'ok' | 'fail'>) {
  let call = 0;
  const fetchMock = vi.fn(() => {
    const answer = answers[Math.min(call, answers.length - 1)];
    call += 1;
    return answer === 'ok'
      ? Promise.resolve(
          new Response(JSON.stringify({ ...emptyRoster(NOW), exactPrompts: 'off' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
      : Promise.reject(new TypeError('offline'));
  });
  vi.stubGlobal('fetch', fetchMock);
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <HqRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return fetchMock;
}

describe('polling', () => {
  it('asks again every 2 seconds while the answers keep coming', async () => {
    const fetchMock = mount(['ok']);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('A quiet one. No agents are running right now.')).toBeTruthy();
    await vi.advanceTimersByTimeAsync(1_900);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('slows to every 10 seconds after a failure, and goes back to 2 once an answer arrives', async () => {
    const fetchMock = mount(['fail', 'fail', 'ok']);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_100);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
