// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExactPrompts, HqFeed, HqRoster } from '../../../src/shared/contracts/hq';
import { HqRoute } from '../../../src/client/features/hq/route';
import { createQueryClient } from '../../../src/client/lib/queryClient';
import { HQ_HOOKS_PROMPT_KEY, markShown } from '../../../src/client/lib/shownOnce';
import {
  agent,
  emptyRoster,
  liveFeeds,
  officeRoster,
  paseoDownRoster,
} from '../../fixtures/hq/scripted';

// The HQ page's states, over a stubbed /api/hq.

// Only `Date` is faked, at one fixed instant, so the idle time the page measures agrees with the roster built below.
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

// What GET /api/hq answers: the roster, and whether the hooks switch is on (off unless a test says otherwise).
const withSwitch = (roster: HqRoster, exactPrompts: ExactPrompts = 'off') => ({
  exactPrompts,
  ...roster,
});
const isRoster = (body: unknown): body is HqRoster =>
  typeof body === 'object' && body !== null && 'feeds' in body && !('exactPrompts' in body);
const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(isRoster(body) ? withSwitch(body, 'off') : body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );

function mount(answer: () => Promise<Response>) {
  const fetchMock = vi.fn(answer);
  vi.stubGlobal('fetch', fetchMock);
  const client = createQueryClient();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <HqRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return Object.assign(fetchMock, { client });
}

const withFeeds = (feeds: HqFeed[]) => withSwitch({ ...emptyRoster(NOW), feeds });
const unavailable: HqFeed[] = [
  { id: 'paseo', status: 'unavailable' },
  { id: 'claude', status: 'unavailable' },
  { id: 'codex', status: 'unavailable' },
];

describe('loading and failure', () => {
  it('names the loading state with a status line until the first answer', async () => {
    mount(() => new Promise(() => undefined));
    expect(screen.getByRole('heading', { level: 1, name: 'HQ' }).id).toBe('page-title');
    expect(screen.getByRole('status').textContent).toBe('Loading HQ…');
  });

  it('says it could not load, with Retry, when there is nothing to keep showing', async () => {
    const fetchMock = mount(() => Promise.reject(new TypeError('offline')));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Couldn’t load HQ')).toBeTruthy();
    expect(screen.queryByText('Loading HQ…')).toBeNull();
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
  });

  it('keeps showing the last roster beside a notice with Retry when a later request fails', async () => {
    let calls = 0;
    const fetchMock = mount(() => {
      calls += 1;
      return calls === 1 ? json(officeRoster(NOW)) : Promise.reject(new TypeError('offline'));
    });
    await screen.findByRole('list', { name: 'Sessions' });
    expect(screen.queryByRole('alert')).toBeNull();
    // The next poll fails.
    await fetchMock.client.refetchQueries({ queryKey: ['hq'] });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(alert.textContent).toContain('last one it received');
    expect(screen.getByRole('list', { name: 'Sessions' })).toBeTruthy();
  });
});

describe('feed states', () => {
  it('says live agents are not available when every feed is unavailable', async () => {
    mount(() => json(withFeeds(unavailable)));
    expect(await screen.findByText('Live agents aren’t available in this session.')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('points to Setup when setup is not finished', async () => {
    mount(() =>
      json(
        withFeeds([
          { id: 'paseo', status: 'setup_incomplete' },
          { id: 'claude', status: 'setup_incomplete' },
          { id: 'codex', status: 'setup_incomplete' },
        ]),
      ),
    );
    const link = await screen.findByRole('link', { name: 'Go to Setup' });
    expect(link.getAttribute('href')).toBe('/setup');
    expect(screen.queryByText('Live agents aren’t available in this session.')).toBeNull();
  });

  it.each([
    ['notrunning', 'Not running', 'Start Paseo, then check again.'],
    [
      'needspassword',
      'Needs a password',
      'Paseo is asking for a password, which this dashboard doesn’t support.',
    ],
  ] as const)(
    'shows a Paseo line for %s with the Sources screen’s words',
    async (status, tag, detail) => {
      mount(() => json(withFeeds([{ id: 'paseo', status }, ...liveFeeds().slice(1)])));
      expect(await screen.findByText(tag)).toBeTruthy();
      expect(screen.getByText(detail)).toBeTruthy();
      expect(screen.getByText('Paseo')).toBeTruthy();
      // The transcript feeds are live and nobody is running, but Paseo has a problem: the page does not claim the machine is quiet.
      expect(screen.queryByText('A quiet one. No agents are running right now.')).toBeNull();
      expect(screen.getByText('No agents to show right now.')).toBeTruthy();
    },
  );

  it.each([
    { label: 'all feeds', feeds: liveFeeds() },
    {
      label: 'only Paseo',
      feeds: unavailable.map((feed) =>
        feed.id === 'paseo' ? { ...feed, status: 'live' as const } : feed,
      ),
    },
  ])('shows the quiet state for an empty roster from $label', async ({ feeds }) => {
    mount(() => json(withFeeds(feeds)));
    expect(await screen.findByText('A quiet one. No agents are running right now.')).toBeTruthy();
  });

  it('draws the AFK room above the quiet sentence, decorative, with the sentence as the statement', async () => {
    mount(() => json(emptyRoster(NOW)));
    const sentence = await screen.findByText('A quiet one. No agents are running right now.');
    const afk = screen.getByTestId('hq-afk');
    // Decorative: hidden from assistive technology, nothing to focus, no role, name, title or description.
    expect(afk.getAttribute('aria-hidden')).toBe('true');
    expect(
      afk.querySelectorAll(
        'a[href], button, input, select, textarea, [tabindex], [contenteditable], [role], [aria-label], [aria-live], title, desc',
      ),
    ).toHaveLength(0);
    // The drawn words are the scene's own; the sentence below the drawing says the state.
    expect(afk.textContent).toContain('AFK');
    expect(afk.textContent).toContain('back');
    expect(afk.textContent).toContain('soon');
    expect(afk.compareDocumentPosition(sentence) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(afk.contains(sentence)).toBe(false);
    // Neither the roster's scene nor the small crew art is drawn in this state.
    expect(screen.queryByTestId('hq-scene')).toBeNull();
    expect(screen.queryByTestId('hq-room')).toBeNull();
  });

  it('draws no AFK room while loading, when the request fails, or when agents are running', async () => {
    mount(() => new Promise(() => undefined));
    expect(screen.queryByTestId('hq-afk')).toBeNull();
    cleanup();
    mount(() => json({}, 500));
    await screen.findByText('Couldn’t load HQ');
    expect(screen.queryByTestId('hq-afk')).toBeNull();
    cleanup();
    mount(() => json(officeRoster(NOW)));
    await screen.findByRole('list', { name: 'Sessions' });
    expect(screen.queryByTestId('hq-afk')).toBeNull();
  });

  it.each([
    [
      'notfound',
      'Not found',
      'Nothing in its usual locations on this machine. If you use it here, run it once, then check again.',
      true,
    ],
    [
      'denied',
      'Access denied',
      'Claude Code’s data is here but couldn’t be read. Allow read access, then reload this page.',
      false,
    ],
    [
      'failed',
      'Unavailable',
      'Claude Code’s recent sessions couldn’t be read. It will keep trying.',
      false,
    ],
  ] as const)(
    'says so for a Claude Code feed that is %s, with words that fit it (quiet: %s only when nothing is wrong)',
    async (status, tag, detail, quiet) => {
      mount(() =>
        json(
          withFeeds([
            { id: 'paseo', status: 'live' },
            { id: 'claude', status },
            { id: 'codex', status: 'live' },
          ]),
        ),
      );
      expect(await screen.findByText(tag)).toBeTruthy();
      expect(screen.getByText('Claude Code')).toBeTruthy();
      expect(screen.getByText(detail)).toBeTruthy();
      // `notfound` is a machine without that provider (not set up, nothing wrong); `denied` and `failed` are problems.
      expect(screen.queryByText('A quiet one. No agents are running right now.') !== null).toBe(
        quiet,
      );
      expect(screen.queryByText('No agents to show right now.') !== null).toBe(!quiet);
    },
  );

  it('says a Codex feed is starting, with a tag only, and does not call the machine quiet yet', async () => {
    mount(() =>
      json(
        withFeeds([
          { id: 'paseo', status: 'live' },
          { id: 'claude', status: 'live' },
          { id: 'codex', status: 'starting' },
        ]),
      ),
    );
    expect(await screen.findByText('Starting…')).toBeTruthy();
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.queryByText('A quiet one. No agents are running right now.')).toBeNull();
  });

  it('shows the quiet state when only a transcript feed is live', async () => {
    mount(() =>
      json(
        withFeeds([
          { id: 'paseo', status: 'unavailable' },
          { id: 'claude', status: 'live' },
          { id: 'codex', status: 'notfound' },
        ]),
      ),
    );
    expect(await screen.findByText('A quiet one. No agents are running right now.')).toBeTruthy();
    expect(screen.queryByText('Live agents aren’t available in this session.')).toBeNull();
  });

  // The quiet state needs at least one live feed and no feed with a problem. `unavailable` (not on in this process) and `notfound` (a
  // provider with nothing on this machine, which Sources shows as muted "not set up") are not problems; `starting` is not yet known.
  type Status = HqFeed['status'];
  const matrix: [Status, Status, Status, 'quiet' | 'none' | 'unavailable' | 'setup'][] = [
    ['live', 'live', 'live', 'quiet'],
    ['live', 'unavailable', 'unavailable', 'quiet'],
    ['unavailable', 'live', 'notfound', 'quiet'],
    ['unavailable', 'notfound', 'live', 'quiet'],
    ['live', 'notfound', 'notfound', 'quiet'],
    ['live', 'live', 'starting', 'none'],
    ['starting', 'live', 'live', 'none'],
    ['live', 'live', 'notrunning', 'none'],
    ['notrunning', 'live', 'live', 'none'],
    ['needspassword', 'live', 'live', 'none'],
    ['live', 'denied', 'live', 'none'],
    ['live', 'live', 'denied', 'none'],
    ['live', 'failed', 'live', 'none'],
    ['live', 'live', 'failed', 'none'],
    ['live', 'denied', 'notfound', 'none'],
    ['notrunning', 'live', 'unavailable', 'none'],
    ['notrunning', 'notfound', 'notfound', 'none'],
    ['starting', 'starting', 'starting', 'none'],
    ['unavailable', 'unavailable', 'unavailable', 'unavailable'],
    ['setup_incomplete', 'setup_incomplete', 'setup_incomplete', 'setup'],
  ];
  it.each(matrix)(
    'with feeds paseo=%s claude=%s codex=%s and an empty roster it shows: %s',
    async (paseo, claude, codex, shows) => {
      mount(() =>
        json(
          withFeeds([
            { id: 'paseo', status: paseo },
            { id: 'claude', status: claude },
            { id: 'codex', status: codex },
          ]),
        ),
      );
      const quiet = 'A quiet one. No agents are running right now.';
      const none = 'No agents to show right now.';
      const unavailableText = 'Live agents aren’t available in this session.';
      await screen.findByRole('heading', { level: 1, name: 'HQ' });
      // (The loading line is the page's status, so it is the line that is asked for.)
      await waitFor(() => expect(screen.queryByText('Loading HQ…')).toBeNull());
      expect(screen.queryByText(quiet) !== null).toBe(shows === 'quiet');
      expect(screen.queryByText(none) !== null).toBe(shows === 'none');
      expect(screen.queryByText(unavailableText) !== null).toBe(shows === 'unavailable');
      expect(screen.queryByRole('link', { name: 'Go to Setup' }) !== null).toBe(shows === 'setup');
      // The AFK drawing belongs to the quiet state alone.
      expect(screen.queryByTestId('hq-afk') !== null).toBe(shows === 'quiet');
    },
  );

  it('says there is nothing to show, not "quiet", when no feed is live and some are down', async () => {
    mount(() =>
      json(
        withFeeds([
          { id: 'paseo', status: 'notrunning' },
          { id: 'claude', status: 'notfound' },
          { id: 'codex', status: 'notfound' },
        ]),
      ),
    );
    expect(await screen.findByText('No agents to show right now.')).toBeTruthy();
    expect(screen.queryByText('A quiet one. No agents are running right now.')).toBeNull();
  });

  it('shows agents seen only by a transcript, with their inferred activity in words', async () => {
    const roster = officeRoster(NOW);
    roster.agents = roster.agents.map((a) =>
      a.id === 'hq-solo-claude'
        ? {
            ...a,
            confidence: 'inferred' as const,
            state: 'working' as const,
            activity: 'editing' as const,
            seenBy: { paseo: false, transcript: true },
          }
        : a,
    );
    mount(() => json(roster));
    const sessions = await screen.findByRole('list', { name: 'Sessions' });
    expect(sessions.textContent).toContain('Editing');
  });

  it('shows the Paseo line above the roster when the other feeds still see agents', async () => {
    mount(() => json(paseoDownRoster(NOW)));
    expect(await screen.findByText('Not running')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Sessions' })).toBeTruthy();
  });

  it('says when the roster was cut', async () => {
    mount(() => json({ ...officeRoster(NOW), truncated: true }));
    expect(await screen.findByText(/cut to fit/)).toBeTruthy();
  });
});

describe('the roster', () => {
  it('shows a fresh background report in the focused roster and keeps older counts in Recent idle', async () => {
    const backgroundWork = {
      subagents: 1,
      shellJobs: 1,
      monitors: 0,
      reportedAt: new Date(NOW - 8 * 60_000).toISOString(),
      stale: false,
    };
    const roster = emptyRoster(NOW);
    roster.agents = [
      agent(NOW, { id: 'parent', provider: 'claude', state: 'idle', backgroundWork }),
      agent(NOW, {
        id: 'child',
        provider: 'claude',
        kind: 'child',
        parentId: 'parent',
        state: 'finished',
        backgroundSubagent: true,
      }),
      agent(NOW, {
        id: 'older',
        provider: 'claude',
        state: 'idle',
        backgroundWork: { ...backgroundWork, subagents: 0, stale: true },
      }),
    ];
    mount(() => json(roster));

    const focused = within(await screen.findByRole('list', { name: 'Sessions' }));
    expect(
      focused.getByText(
        'Idle for 5 min · 1 background subagent · 1 shell job · last reported 8 min ago',
      ),
    ).toBeTruthy();
    expect(focused.getByText('Background subagent reported')).toBeTruthy();
    expect(focused.queryByText('Background work running')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Recent idle (1)' }));
    expect(
      within(screen.getByRole('list', { name: 'Recent idle' })).getByText(
        'Idle for 5 min · 1 shell job · last reported 8 min ago',
      ),
    ).toBeTruthy();
  });

  it('opens Recent idle on demand below the AFK scene when no session needs a room', async () => {
    const roster = officeRoster(NOW);
    roster.agents = roster.agents.filter((agent) => agent.state === 'idle');
    mount(() => json(roster));

    const disclosure = await screen.findByRole('button', { name: 'Recent idle (1)' });
    expect(screen.getByTestId('hq-afk')).toBeTruthy();
    expect(screen.queryByTestId('hq-scene')).toBeNull();
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('list', { name: 'Recent idle' })).toBeNull();

    fireEvent.click(disclosure);
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('list', { name: 'Recent idle' }).textContent).toContain(
      'Idle for 12 min',
    );
  });

  it('lists three focused sessions as nested lists, the one that needs you first, with a summary and state words', async () => {
    mount(() => json(officeRoster(NOW)));
    const sessions = await screen.findByRole('list', { name: 'Sessions' });
    const cards = Array.from(sessions.children);
    expect(cards).toHaveLength(3);
    // The waiting session leads and says what it needs.
    expect(cards[0]!.textContent).toContain('Sync shared instructions');
    expect(cards[0]!.textContent).toContain('Needs you: permission');
    expect(cards[0]!.className).toContain('border-warning');
    expect(cards[1]!.className).not.toContain('border-warning');
    // A session's root is first and its children are in a nested list inside it.
    const build = within(sessions).getByRole('list', { name: 'Build the HQ page: 4 agents' });
    const rows = within(build).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(rows[0]!.textContent).toContain('Build the HQ page');
    expect(within(rows[0]!).getAllByRole('list')).toHaveLength(1);
    // Provider names, repo, activity words and idle time.
    expect(build.textContent).toContain('Claude Code · kelvin/agent-productivity');
    expect(build.textContent).toContain('Editing');
    expect(build.textContent).toContain('Reading');
    expect(build.textContent).toContain('Running a command');
    expect(build.textContent).toContain('Thinking');
    const disclosure = screen.getByRole('button', { name: 'Recent idle (1)' });
    fireEvent.click(disclosure);
    const recent = screen.getByRole('list', { name: 'Recent idle' });
    expect(recent.textContent).toContain('No name recorded');
    expect(recent.textContent).toContain('Idle for 12 min');
    // One-line summary under the heading.
    expect(screen.getByText('6 working · 1 needs you')).toBeTruthy();
  });

  it('is plain content: decorative art, no focusable rows and no live region', async () => {
    const { container } = render(<></>);
    container.remove();
    mount(() => json(officeRoster(NOW)));
    const sessions = await screen.findByRole('list', { name: 'Sessions' });
    expect(sessions.querySelectorAll('[tabindex], a, button')).toHaveLength(0);
    expect(sessions.querySelectorAll('svg:not([aria-hidden="true"])')).toHaveLength(0);
    // The roster has no live region, and the page holds no hooks switch of its own: it is on Sources (and offered once, in a dialog).
    expect(screen.queryByRole('region', { name: 'Know when Claude Code needs you' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'What will change' })).toBeNull();
    expect(
      [...document.querySelectorAll('[aria-live], [role="status"]')].filter((region) =>
        sessions.contains(region),
      ),
    ).toHaveLength(0);
  });

  it('words an inferred wait as "May be waiting for you" and still sorts it first', async () => {
    const roster = officeRoster(NOW);
    roster.agents = roster.agents.map((a) =>
      a.id === 'hq-sync' ? { ...a, waitReason: null, confidence: 'inferred' as const } : a,
    );
    mount(() => json(roster));
    const sessions = await screen.findByRole('list', { name: 'Sessions' });
    expect(sessions.children[0]!.textContent).toContain('May be waiting for you');
    expect(screen.getByText('6 working · 1 may need you')).toBeTruthy();
  });
});
