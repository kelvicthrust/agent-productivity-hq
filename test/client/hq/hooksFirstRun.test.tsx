// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExactPrompts } from '../../../src/shared/contracts/hq';
import { HqRoute } from '../../../src/client/features/hq/route';
import { createQueryClient } from '../../../src/client/lib/queryClient';
import { HQ_HOOKS_PROMPT_KEY, markShown } from '../../../src/client/lib/shownOnce';
import { emptyRoster, liveFeeds, officeRoster } from '../../fixtures/hq/scripted';
import { COMMAND, NOW, mountRig, type Rig } from '../hooksRig';

// The first time HQ is opened on this browser with Claude Code's hooks switch off, the same control the Sources screen holds opens once in a
// dialog; closing it by any means records that, and it never opens by itself again. It opens on a roster that was read, with a feeder,
// and for `off` alone. HQ itself holds no switch.

const TITLE = 'Know when Claude Code needs you';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  // jsdom has no modal <dialog>: the stand-in opens and closes it as the browser does, and says so with the `close` event.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const mount = (over: Partial<Rig> = {}) => mountRig(<HqRoute />, over);
const dialog = () => screen.queryByRole('dialog', { name: TITLE });
const flag = () => window.localStorage.getItem(HQ_HOOKS_PROMPT_KEY);

describe('the first time', () => {
  it('opens the control in a labelled dialog that says where to find it later, and leaves the page without a panel', async () => {
    mount({ roster: () => officeRoster(NOW) });
    const open = await screen.findByRole('dialog', { name: TITLE });
    expect(within(open).getByRole('heading', { level: 2, name: TITLE })).toBeTruthy();
    expect(open.textContent).toContain(
      'This only changes what HQ can show. Your usage and delivery numbers are unaffected.',
    );
    expect(open.textContent).toContain('You can find this later under Sources.');
    // The same control: its state in words, the disclosure and the one button that applies.
    expect(
      within(open).getByText('Off. HQ guesses, and says “May be waiting for you”.'),
    ).toBeTruthy();
    expect(within(open).getByRole('button', { name: 'What will change' })).toBeTruthy();
    expect(within(open).getByRole('button', { name: 'Turn on' })).toBeTruthy();
    expect(within(open).getByRole('button', { name: 'Not now' })).toBeTruthy();
    // Nothing is recorded until it is closed, and nothing is written.
    expect(flag()).toBeNull();
    expect(screen.queryByRole('region', { name: TITLE })).toBeNull();
  });

  it.each([
    ['"Not now"', () => fireEvent.click(screen.getByRole('button', { name: 'Not now' }))],
    ['the close button', () => fireEvent.click(screen.getByRole('button', { name: /^close/i }))],
  ])(
    'closing it with %s records that it was shown, and it does not open again',
    async (_name, close) => {
      mount();
      await screen.findByRole('dialog', { name: TITLE });
      close();
      await waitFor(() => expect(dialog()).toBeNull());
      expect(flag()).toBe('1');
      cleanup();
      mount();
      await screen.findByRole('heading', { level: 1, name: 'HQ' });
      await waitFor(() => expect(screen.queryByText('Loading HQ…')).toBeNull());
      expect(dialog()).toBeNull();
    },
  );

  it('does not write anything for being opened or closed, and shows the plan before turning on', async () => {
    const rig = mount();
    const open = await screen.findByRole('dialog', { name: TITLE });
    fireEvent.click(within(open).getByRole('button', { name: 'Turn on' }));
    await within(open).findByText(COMMAND);
    expect(rig.calls.some((call) => call.method === 'PUT')).toBe(false);
    fireEvent.click(within(open).getByRole('button', { name: 'Turn on' }));
    await within(open).findByText(/^Turned on\./);
    expect(rig.calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
    // Turning it on is an answer: recorded, and the dialog stays to say so, with a button that says it is done.
    expect(flag()).toBe('1');
    expect(within(open).getByRole('button', { name: 'Done' })).toBeTruthy();
  });

  it('does not open when it was shown before', async () => {
    markShown(HQ_HOOKS_PROMPT_KEY);
    mount();
    await screen.findByRole('heading', { level: 1, name: 'HQ' });
    await waitFor(() => expect(screen.queryByText('Loading HQ…')).toBeNull());
    expect(dialog()).toBeNull();
  });

  it.each(['on', 'needs_repair', 'unavailable'] as ExactPrompts[])(
    'does not open when the switch is %s, and records nothing',
    async (state) => {
      mount({ state });
      await screen.findByRole('heading', { level: 1, name: 'HQ' });
      await waitFor(() => expect(screen.queryByText('Loading HQ…')).toBeNull());
      expect(dialog()).toBeNull();
      expect(flag()).toBeNull();
    },
  );

  it('does not open while HQ is loading, in setup, with no feeder, or when the roster could not be read', async () => {
    // Loading: the roster never answers.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <HqRoute />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Loading HQ…')).toBeTruthy();
    expect(dialog()).toBeNull();
    cleanup();

    mount({
      roster: () => ({
        ...emptyRoster(NOW),
        feeds: liveFeeds().map((feed) => ({ ...feed, status: 'setup_incomplete' as const })),
      }),
    });
    await screen.findByRole('link', { name: 'Go to Setup' });
    expect(dialog()).toBeNull();
    cleanup();

    mount({
      roster: () => ({
        ...emptyRoster(NOW),
        feeds: [
          { id: 'paseo', status: 'unavailable' },
          { id: 'claude', status: 'unavailable' },
          { id: 'codex', status: 'unavailable' },
        ],
      }),
    });
    await screen.findByText('Live agents aren’t available in this session.');
    expect(dialog()).toBeNull();
    cleanup();

    mount({ roster: () => ({ not: 'a roster' }) });
    await screen.findByText('Couldn’t load HQ');
    expect(dialog()).toBeNull();
    expect(flag()).toBeNull();
  });
});

describe('the words of a waiting agent', () => {
  const waiting = (confidence: 'reported' | 'inferred') => {
    const roster = officeRoster(NOW);
    roster.agents = roster.agents.map((agent) =>
      agent.id === 'hq-solo-claude'
        ? {
            ...agent,
            state: 'waiting' as const,
            activity: 'none' as const,
            waitReason: 'permission' as const,
            confidence,
          }
        : agent,
    );
    return roster;
  };

  it('is exact when a hook reported it, and a guess when it was inferred', async () => {
    markShown(HQ_HOOKS_PROMPT_KEY);
    mount({ state: 'on', roster: () => waiting('reported') });
    const sessions = await screen.findByRole('list', { name: 'Sessions' });
    expect(sessions.textContent).toContain('Fix the flaky checkout test');
    expect((sessions.textContent ?? '').match(/Needs you: permission/g)).toHaveLength(2);
    expect(sessions.textContent).not.toContain('May be waiting for you');
    cleanup();
    mount({ state: 'off', roster: () => waiting('inferred') });
    const guessed = await screen.findByRole('list', { name: 'Sessions' });
    expect(guessed.textContent).toContain('May be waiting for you');
  });
});
