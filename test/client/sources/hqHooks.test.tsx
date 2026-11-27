// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeHooksStatus, ExactPrompts } from '../../../src/shared/contracts/hq';
import { ClaudeHooksSwitch } from '../../../src/client/components/ClaudeHooksSwitch';
import { HqHooks } from '../../../src/client/features/sources/HqHooks';
import { useExactPrompts } from '../../../src/client/lib/hq';
import { COMMAND, NOW, PREVIEW, json, mountRig, status, type Rig } from '../hooksRig';

// The Sources card uses one-press Turn on and Turn off. Exercise the default
// review flow separately because the first-time HQ dialog still uses it.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const mount = (over: Partial<Rig> = {}) => mountRig(<HqHooks />, over);

function ReviewedSwitch() {
  const { data } = useExactPrompts();
  return (
    <section aria-label="Know when Claude Code needs you">
      {data !== undefined && <ClaudeHooksSwitch state={data} />}
    </section>
  );
}

const mountReview = (over: Partial<Rig> = {}) => mountRig(<ReviewedSwitch />, over);

/** The card, once the switch's state has been read (before that it holds only a loading line). */
const section = async () => {
  await screen.findByRole('button', { name: 'What will change' });
  return screen.getByRole('region', { name: 'Know when Claude Code needs you' });
};
const paths = (rig: Rig) => rig.calls.map((call) => `${call.method} ${call.path}`);
const showPreview = async (panel: HTMLElement) => {
  const disclosure = within(panel).getByRole('button', { name: 'What will change' });
  if (disclosure.getAttribute('aria-expanded') === 'false') fireEvent.click(disclosure);
  return within(panel).findByText(COMMAND);
};

describe('before the owner acts', () => {
  it('says what it is for, what it is now and what turning it on does, and asks for nothing else', async () => {
    const rig = mount();
    const panel = await section();
    expect(panel.textContent).toContain(
      'HQ can only guess when an agent outside Paseo is waiting for you. Turn this on to have Claude Code tell HQ directly.',
    );
    expect(panel.textContent).toContain(
      'Turning it on adds five entries to your Claude Code settings.',
    );
    expect(
      within(panel).getByText('Off. HQ guesses, and says “May be waiting for you”.'),
    ).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Turn on' })).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: 'Turn off' })).toBeNull();
    // (Astryx's Button carries an empty hidden live region of its own; nothing is said until the owner acts.)
    expect(
      within(panel)
        .queryAllByRole('status')
        .filter((node) => (node.textContent ?? '') !== ''),
    ).toHaveLength(0);
    // The preview is not read, and nothing is written.
    expect(paths(rig).sort()).toEqual(['GET /api/hq', 'GET /api/hq/claude-hooks/background-work']);
  });

  it('is a labelled region with a heading, and says it changes only what HQ can show', async () => {
    mount();
    const panel = await section();
    expect(within(panel).getByRole('heading', { level: 2 }).textContent).toBe(
      'Know when Claude Code needs you',
    );
    expect(panel.textContent).toContain(
      'This only changes what HQ can show. Your usage and delivery numbers are unaffected.',
    );
  });

  it.each([
    ['on', 'On. Claude Code tells HQ when it needs you.', ['Turn off']],
    [
      'needs_repair',
      'Needs repair. HQ’s entries in Claude Code’s settings don’t match this version of the app.',
      ['Repair', 'Turn off'],
    ],
    [
      'unavailable',
      'Not available. HQ can’t find a Claude Code settings file it is able to change.',
      [],
    ],
  ] as const)(
    'in the %s state says so and offers only what applies',
    async (state, words, buttons) => {
      mount({ state });
      const panel = await section();
      expect(within(panel).getByText(words)).toBeTruthy();
      const names = within(panel)
        .getAllByRole('button')
        .map((button) => button.textContent);
      expect(names).toEqual(['What will change', ...buttons]);
    },
  );

  it('says so, under its heading, when the switch’s state cannot be read', async () => {
    mount({ roster: () => ({ not: 'a roster' }) });
    const alert = await screen.findByText(
      'Couldn’t read this setting. Reload the page to try again.',
    );
    expect(alert.getAttribute('role')).toBe('alert');
    expect(screen.getByRole('region', { name: 'Know when Claude Code needs you' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Turn on' })).toBeNull();
  });
});

describe('Claude Code background reporting consent', () => {
  const name = 'Report Claude Code background work';
  const path = '/api/hq/claude-hooks/background-work';

  it('previews the extra fields with the switch disabled while the wait hooks are off', async () => {
    const rig = mount();
    const toggle = await screen.findByRole('switch', { name });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    expect(
      screen.getByText(/background task IDs, categories, states and observation times/),
    ).toBeTruthy();
    expect(await screen.findByText(/Turn on or repair the wait hooks above/)).toBeTruthy();
    fireEvent.click(toggle);
    expect(rig.calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('requires an explicit switch action and turns background reporting off independently', async () => {
    const rig = mount({ state: 'on' });
    const toggle = (await screen.findByRole('switch', { name })) as HTMLInputElement;
    await waitFor(() => expect(toggle.hasAttribute('aria-disabled')).toBe(false));
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(true));
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(false));
    expect(
      rig.calls.filter((call) => call.method === 'PUT').map(({ path, body }) => [path, body]),
    ).toEqual([
      [path, { enabled: true }],
      [path, { enabled: false }],
    ]);
    expect(screen.getByText('On. Claude Code tells HQ when it needs you.')).toBeTruthy();
  });
});

describe('what will change', () => {
  it('opens on demand, reads the preview, and lists the file, the events and the exact command', async () => {
    const rig = mount();
    const panel = await section();
    const toggle = within(panel).getByRole('button', { name: 'What will change' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const region = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    await waitFor(() => expect(region.textContent).toContain('~/.claude/settings.json'));
    expect(region.textContent).toContain(
      'PermissionRequest, Notification, Stop, SessionStart, SessionEnd',
    );
    expect(region.textContent).toContain(COMMAND);
    expect(region.textContent).toContain(
      'Never your prompts, commands, replies or notification text.',
    );
    expect(region.textContent).toContain('settings.json.agent-productivity-backup');
    expect(paths(rig)).toContain('GET /api/hq/claude-hooks');
    expect(paths(rig).filter((call) => call.startsWith('PUT'))).toEqual([]);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(region.hidden).toBe(true);
  });

  it('says a file will be created, and why a file cannot be changed', async () => {
    mount({
      state: 'unavailable',
      preview: () =>
        json(
          status({
            state: 'unavailable',
            reason: 'settings_blocked',
            files: [
              {
                path: '~/.claude/settings.json',
                exists: true,
                state: 'blocked',
                reason: 'not_json',
              },
              {
                path: '~/.config/claude/settings.json',
                exists: false,
                state: 'absent',
                reason: null,
              },
            ],
          }),
        ),
    });
    const panel = await section();
    fireEvent.click(within(panel).getByRole('button', { name: 'What will change' }));
    await waitFor(() => expect(panel.textContent).toContain('isn’t valid JSON'));
    expect(panel.textContent).toContain('will be created');
    expect(panel.textContent).toContain('HQ leaves a file it can’t change exactly as it is.');
  });

  it('says there is no folder when there is none, and offers to read again when the read fails', async () => {
    let fail = true;
    mount({
      preview: () =>
        fail
          ? json({ error: { code: 'internal', message: 'x', retryable: true } }, 500)
          : json(status({ state: 'unavailable', reason: 'no_claude_folder', files: [] })),
    });
    const panel = await section();
    fireEvent.click(within(panel).getByRole('button', { name: 'What will change' }));
    expect(
      await within(panel).findByText('Couldn’t read the settings to show what will change.'),
    ).toBeTruthy();
    fail = false;
    fireEvent.click(within(panel).getByRole('button', { name: 'Read again' }));
    await waitFor(() =>
      expect(panel.textContent).toContain(
        'HQ couldn’t find a Claude Code folder on this computer.',
      ),
    );
  });
});

describe('turning it on and off', () => {
  it('turns on with one PUT that carries the app header, says so politely, and the page follows', async () => {
    const rig = mount();
    const panel = await section();
    // The background-work switch can announce loading in Astryx's shared live region.
    expect(
      within(panel)
        .queryAllByRole('status')
        .every((node) => (node.textContent ?? '') === ''),
    ).toBe(true);
    fireEvent.click(within(panel).getByRole('button', { name: 'Turn on' }));
    const puts = () => rig.calls.filter((call) => call.method === 'PUT');
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(
      within(panel).getByRole('button', { name: 'What will change' }).getAttribute('aria-expanded'),
    ).toBe('false');
    expect(puts()[0]).toMatchObject({
      path: '/api/hq/claude-hooks',
      body: { enabled: true, preview: PREVIEW },
      headers: { 'X-Agent-Productivity-Request': '1', 'Content-Type': 'application/json' },
    });
    const said = await within(panel).findByText(/^Turned on\. Claude Code will tell HQ/);
    expect(said.getAttribute('role')).toBe('status');
    // The roster is read again at once, and the switch now offers Turn off.
    expect(await within(panel).findByRole('button', { name: 'Turn off' })).toBeTruthy();
    expect(within(panel).getByText('On. Claude Code tells HQ when it needs you.')).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: 'Turn on' })).toBeNull();
  });

  it('checks a fresh plan even when the disclosure has already loaded one', async () => {
    let fingerprint = 'aa'.repeat(32);
    const rig = mount({ preview: () => json(status({ preview: fingerprint })) });
    const panel = await section();
    await showPreview(panel);
    expect(paths(rig)).not.toContain('PUT /api/hq/claude-hooks');
    fingerprint = 'bb'.repeat(32);
    fireEvent.click(within(panel).getByRole('button', { name: 'Turn on' }));
    await waitFor(() =>
      expect(rig.calls.find((call) => call.method === 'PUT')?.body).toEqual({
        enabled: true,
        preview: fingerprint,
      }),
    );
  });

  it('turns off, and repairs', async () => {
    const rig = mount({ state: 'on' });
    const panel = await section();
    fireEvent.click(within(panel).getByRole('button', { name: 'Turn off' }));
    expect(
      await within(panel).findByText(
        /^Turned off\. HQ’s entries are removed from Claude Code’s settings/,
      ),
    ).toBeTruthy();
    expect(rig.calls.find((call) => call.method === 'PUT')?.body).toEqual({
      enabled: false,
      preview: PREVIEW,
    });
    expect(
      within(panel).getByRole('button', { name: 'What will change' }).getAttribute('aria-expanded'),
    ).toBe('false');

    cleanup();
    const again = mount({ state: 'needs_repair' });
    const repairPanel = await section();
    await showPreview(repairPanel);
    fireEvent.click(within(repairPanel).getByRole('button', { name: 'Repair' }));
    expect(
      await within(repairPanel).findByText(
        'Repaired. HQ’s entries match this version of the app again.',
      ),
    ).toBeTruthy();
    expect(again.calls.find((call) => call.method === 'PUT')?.body).toEqual({
      enabled: true,
      preview: PREVIEW,
    });
  });

  it('says the pending words while it works, and does not send a second request for a second press', async () => {
    let resolvePreview: (response: Response) => void = () => undefined;
    let resolvePut: (response: Response) => void = () => undefined;
    const preview = new Promise<Response>((resolve) => {
      resolvePreview = resolve;
    });
    const put = new Promise<Response>((resolve) => {
      resolvePut = resolve;
    });
    const rig = mount({
      preview: () => preview,
      put: () => put,
    });
    const panel = await section();
    const button = within(panel).getByRole('button', { name: 'Turn on' });
    fireEvent.click(button);
    expect(await within(panel).findByRole('button', { name: 'Turning on…' })).toBeTruthy();
    expect(within(panel).getAllByText('Turning on…').length).toBeGreaterThan(0);
    fireEvent.click(within(panel).getByRole('button', { name: 'Turning on…' }));
    expect(paths(rig).filter((call) => call === 'GET /api/hq/claude-hooks')).toHaveLength(1);
    expect(paths(rig)).not.toContain('PUT /api/hq/claude-hooks');
    resolvePreview(await json(status()));
    await waitFor(() => expect(paths(rig)).toContain('PUT /api/hq/claude-hooks'));
    fireEvent.click(within(panel).getByRole('button', { name: 'Turning on…' }));
    expect(rig.calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
    resolvePut(await json(status({ state: 'on' })));
    expect(await within(panel).findByText(/^Turned on\./)).toBeTruthy();
  });

  it('shows the server’s fixed sentence when it refuses, says nothing was changed, and keeps the switch as it was', async () => {
    mount({
      put: () =>
        json(
          {
            error: {
              code: 'claude_hooks_blocked',
              message: 'Claude Code’s settings file isn’t valid JSON, so HQ didn’t change it.',
              retryable: false,
              details: { reason: 'not_json' },
            },
          },
          422,
        ),
    });
    const panel = await section();
    fireEvent.click(within(panel).getByRole('button', { name: 'Turn on' }));
    const alert = await within(panel).findByRole('alert');
    expect(alert.textContent).toContain(
      'Claude Code’s settings file isn’t valid JSON, so HQ didn’t change it.',
    );
    expect(alert.textContent).toContain('Nothing was turned on or off.');
    expect(
      within(panel).getByRole('button', { name: 'What will change' }).getAttribute('aria-expanded'),
    ).toBe('false');
    expect(within(panel).getByRole('button', { name: 'Turn on' })).toBeTruthy();
    expect(
      within(panel).getByText('Off. HQ guesses, and says “May be waiting for you”.'),
    ).toBeTruthy();
  });

  it('shows what a refusal left behind, whatever its code (here a stale plan)', async () => {
    mount({
      put: () =>
        json(
          {
            error: {
              code: 'claude_hooks_stale',
              message:
                'Claude Code’s settings are not what HQ showed you. Read what will change again, then confirm. HQ left the copy of your settings it made where it is, because it was changed after HQ wrote it or could not be removed. You can delete it.',
              retryable: false,
              details: { reason: 'stale_preview', left: ['backup'] },
            },
          },
          409,
        ),
    });
    const panel = await section();
    await showPreview(panel);
    fireEvent.click(within(panel).getByRole('button', { name: 'Turn on' }));
    const alert = await within(panel).findByRole('alert');
    expect(alert.textContent).toContain('HQ left the copy of your settings it made where it is');
    expect(alert.textContent).toContain('You can delete it.');
  });

  it('says it plainly when the app cannot be reached', async () => {
    mount({ put: () => Promise.reject(new TypeError('offline')) });
    const panel = await section();
    await showPreview(panel);
    fireEvent.click(within(panel).getByRole('button', { name: 'Turn on' }));
    const alert = await within(panel).findByRole('alert');
    expect(alert.textContent).toContain('Agent Productivity HQ could not be reached.');
    expect(alert.textContent).toContain('Nothing was turned on or off.');
  });
});

describe('confirming a change', () => {
  const puts = (rig: Rig) => rig.calls.filter((call) => call.method === 'PUT');
  const gets = (rig: Rig) =>
    rig.calls.filter((call) => call.method === 'GET' && call.path === '/api/hq/claude-hooks');

  it('does nothing but show the plan on the first press, and writes only on the second, carrying the plan’s fingerprint', async () => {
    const fingerprint = 'cd'.repeat(32);
    const rig = mountReview({ preview: () => json(status({ preview: fingerprint })) });
    const panel = await section();
    expect(gets(rig)).toHaveLength(0);
    fireEvent.click(within(panel).getByRole('button', { name: 'Turn on' }));
    expect(await within(panel).findByText(COMMAND)).toBeTruthy();
    expect(
      within(panel).getByText(
        'Nothing has changed. Read what will change below, then press the button again to confirm.',
      ),
    ).toBeTruthy();
    expect(puts(rig)).toHaveLength(0);
    expect(
      within(panel).getByRole('button', { name: 'What will change' }).getAttribute('aria-expanded'),
    ).toBe('true');

    fireEvent.click(within(panel).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(puts(rig)).toHaveLength(1));
    expect(puts(rig)[0]!.body).toEqual({ enabled: true, preview: fingerprint });
  });

  it('does not write when the plan could not be read, and says so in the fixed words', async () => {
    const rig = mount({
      preview: () => json({ error: { code: 'internal', message: 'x', retryable: true } }, 500),
    });
    const panel = await section();
    fireEvent.click(within(panel).getByRole('button', { name: 'Turn on' }));
    expect(await within(panel).findByText(/Couldn’t check your Claude Code settings/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(gets(rig).length).toBeGreaterThan(1)); // it reads again
    expect(puts(rig)).toHaveLength(0);
  });

  it('does not write for a plan that describes another state than the page is in', async () => {
    const rig = mount({ preview: () => json(status({ state: 'on' })) });
    const panel = await section();
    fireEvent.click(within(panel).getByRole('button', { name: 'Turn on' }));
    expect((await within(panel).findByRole('alert')).textContent).toContain(
      'The available Claude Code settings actions changed.',
    );
    expect(gets(rig)).toHaveLength(1);
    expect(puts(rig)).toHaveLength(0);
  });

  it('does not write while the plan is shut, even with a plan already read', async () => {
    const rig = mountReview();
    const panel = await section();
    await showPreview(panel);
    fireEvent.click(within(panel).getByRole('button', { name: 'What will change' })); // closed again
    fireEvent.click(within(panel).getByRole('button', { name: 'Turn on' }));
    expect(puts(rig)).toHaveLength(0);
    expect(
      within(panel).getByRole('button', { name: 'What will change' }).getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('reads the plan and the page again when the server says the plan is stale, and writes nothing until it is confirmed again', async () => {
    let fingerprint = 'aa'.repeat(32);
    const rig = mountReview({
      preview: () => json(status({ preview: fingerprint })),
      put: () =>
        json(
          {
            error: {
              code: 'claude_hooks_stale',
              message:
                'Claude Code’s settings are not what HQ showed you. Read what will change again, then confirm.',
              retryable: false,
            },
          },
          409,
        ),
    });
    const panel = await section();
    await showPreview(panel);
    fingerprint = 'bb'.repeat(32); // the files changed meanwhile
    const before = gets(rig).length;
    const rosterBefore = rig.calls.filter((call) => call.path === '/api/hq').length;
    fireEvent.click(within(panel).getByRole('button', { name: 'Turn on' }));
    const alert = await within(panel).findByRole('alert');
    expect(alert.textContent).toContain('are not what HQ showed you');
    expect(alert.textContent).toContain('Nothing was turned on or off.');
    await waitFor(() => expect(gets(rig).length).toBeGreaterThan(before));
    await waitFor(() =>
      expect(rig.calls.filter((call) => call.path === '/api/hq').length).toBeGreaterThan(
        rosterBefore,
      ),
    );
    expect(puts(rig)).toHaveLength(1);
    await waitFor(() =>
      expect(within(panel).getByRole('button', { name: 'Turn on' })).toBeTruthy(),
    );
    fireEvent.click(within(panel).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(puts(rig)).toHaveLength(2));
    expect(puts(rig)[1]!.body).toEqual({ enabled: true, preview: fingerprint });
  });

  it.each(['on', 'needs_repair'] as const)(
    'shows what will be removed before turning off from %s, and only the files that hold HQ’s entries',
    async (state) => {
      const rig = mountReview({
        state,
        preview: () =>
          json(
            status({
              state,
              files: [
                { path: '~/.claude/settings.json', exists: true, state: 'present', reason: null },
                {
                  path: '~/.config/claude/settings.json',
                  exists: true,
                  state: 'absent',
                  reason: null,
                },
              ],
            }),
          ),
      });
      const panel = await section();
      fireEvent.click(within(panel).getByRole('button', { name: 'Turn off' }));
      expect(await within(panel).findByText('~/.claude/settings.json')).toBeTruthy();
      expect(
        within(panel).getByText(
          'Turning it off removes only HQ’s entries from these files, and from no others.',
        ),
      ).toBeTruthy();
      expect(within(panel).queryByText('~/.config/claude/settings.json')).toBeNull();
      expect(puts(rig)).toHaveLength(0);
      fireEvent.click(within(panel).getByRole('button', { name: 'Turn off' }));
      await waitFor(() => expect(puts(rig)).toHaveLength(1));
      expect(puts(rig)[0]!.body).toMatchObject({ enabled: false });
    },
  );

  it('says in plain words why HQ needs repair, once the plan is on screen', async () => {
    mount({
      state: 'needs_repair',
      preview: () => json(status({ state: 'needs_repair', reason: 'registry_unpublished' })),
    });
    const panel = await section();
    fireEvent.click(within(panel).getByRole('button', { name: 'Repair' }));
    expect(
      await within(panel).findByText(
        'HQ could not tell the hook script where it is running, so Claude Code’s hook could not reach it.',
      ),
    ).toBeTruthy();
  });

  it('says the Node cannot be found and, once that is read, offers no Repair that could never be confirmed', async () => {
    mount({
      state: 'needs_repair',
      preview: () =>
        json(
          status({
            state: 'needs_repair',
            reason: 'node_missing',
            plans: {
              off: { preview: PREVIEW, files: [], ownFiles: [] },
            },
          }),
        ),
    });
    const panel = await section();
    fireEvent.click(within(panel).getByRole('button', { name: 'What will change' }));
    expect(
      await within(panel).findByText(/The Node that Claude Code’s hook would run can’t be found/),
    ).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: 'Repair' })).toBeNull();
    expect(within(panel).getByRole('button', { name: 'Turn off' })).toBeTruthy();
  });

  it('shows what is on disk after a refusal: the roster is read again and the switch stays as it was', async () => {
    const rig = mount({
      put: () =>
        json(
          {
            error: {
              code: 'claude_hooks_failed',
              message:
                'HQ couldn’t make itself reachable by Claude Code’s hooks, so it left the settings as they were.',
              retryable: false,
            },
          },
          500,
        ),
    });
    const panel = await section();
    await showPreview(panel);
    const rosterBefore = rig.calls.filter((call) => call.path === '/api/hq').length;
    fireEvent.click(within(panel).getByRole('button', { name: 'Turn on' }));
    expect((await within(panel).findByRole('alert')).textContent).toContain(
      'left the settings as they were',
    );
    await waitFor(() =>
      expect(rig.calls.filter((call) => call.path === '/api/hq').length).toBeGreaterThan(
        rosterBefore,
      ),
    );
    expect(within(panel).getByRole('button', { name: 'Turn on' })).toBeTruthy();
    expect(
      within(panel).getByText('Off. HQ guesses, and says “May be waiting for you”.'),
    ).toBeTruthy();
  });
});

/** A plan for each action with its own fingerprint and its own file list, so a plan shown for the wrong action cannot pass for the right one. */
const FILE = (name: string, state: 'absent' | 'present' | 'needs_repair') => ({
  path: `~/${name}/settings.json`,
  exists: true,
  state,
  reason: null,
});
const planOf = (
  action: string,
  files: ReturnType<typeof FILE>[],
  ownFiles: ('script' | 'registry')[] = [],
) => ({
  preview: action
    .padEnd(2, 'x')
    .split('')
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .padEnd(64, '0')
    .slice(0, 64),
  files,
  ownFiles,
});

describe('every state shows the plan of the action pressed, before any write is possible', () => {
  type Case = {
    name: string;
    state: ExactPrompts;
    status: Partial<ClaudeHooksStatus>;
    /** Button label, action, and the settings file only that action's plan lists. */
    buttons: [string, 'on' | 'off' | 'repair', string][];
  };
  const on = planOf('on', [FILE('on-only', 'absent')], ['script']);
  const off = planOf('off', [FILE('off-only', 'present')], ['script', 'registry']);
  const repair = planOf('repair', [FILE('repair-only', 'needs_repair')], ['script']);
  const cases: Case[] = [
    {
      name: 'off',
      state: 'off',
      status: { plans: { on } },
      buttons: [['Turn on', 'on', '~/on-only/settings.json']],
    },
    {
      name: 'on',
      state: 'on',
      status: { plans: { off } },
      buttons: [['Turn off', 'off', '~/off-only/settings.json']],
    },
    ...(['entries_changed', 'script_missing', 'registry_unpublished'] as const).map(
      (reason): Case => ({
        name: `needs_repair (${reason})`,
        state: 'needs_repair',
        status: { reason, plans: { repair, off } },
        buttons: [
          ['Repair', 'repair', '~/repair-only/settings.json'],
          ['Turn off', 'off', '~/off-only/settings.json'],
        ],
      }),
    ),
    {
      name: 'needs_repair (node_missing): only turning off',
      state: 'needs_repair',
      status: { reason: 'node_missing', plans: { off } },
      buttons: [['Turn off', 'off', '~/off-only/settings.json']],
    },
    {
      name: 'needs_repair (unsupported_path): only turning off',
      state: 'needs_repair',
      status: { reason: 'unsupported_path', plans: { off } },
      buttons: [['Turn off', 'off', '~/off-only/settings.json']],
    },
    {
      name: 'off with files HQ could not remove',
      state: 'off',
      status: {
        reason: 'cleanup_incomplete',
        leftover: { folder: '~/data/claude-hooks', items: ['script'] },
        plans: { on, off: planOf('off', [], ['script']) },
      },
      buttons: [
        ['Turn on', 'on', '~/on-only/settings.json'],
        ['Remove HQ’s files', 'off', 'No settings file holds HQ’s entries.'],
      ],
    },
  ];

  for (const c of cases) {
    for (const [label, action, shown] of c.buttons) {
      it(`${c.name}: pressing “${label}” shows that action’s plan first, and only a second press sends its fingerprint`, async () => {
        const rig = mountReview({
          state: c.state,
          preview: () => json(status({ state: c.state, ...c.status })),
        });
        const panel = await section();
        // A button that is offered only once the status has been read (retrying the removal) needs the disclosure opened first.
        if (c.state === 'off' && c.status.reason === 'cleanup_incomplete') {
          fireEvent.click(within(panel).getByRole('button', { name: 'What will change' }));
          await within(panel).findByRole('button', { name: label });
        }
        fireEvent.click(within(panel).getByRole('button', { name: label }));
        expect(await within(panel).findByText(shown)).toBeTruthy();
        const others = c.buttons.filter(([, a]) => a !== action).map(([, , file]) => file);
        for (const other of others) expect(within(panel).queryByText(other)).toBeNull();
        expect(rig.calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
        fireEvent.click(within(panel).getByRole('button', { name: label }));
        await waitFor(() =>
          expect(rig.calls.filter((call) => call.method === 'PUT')).toHaveLength(1),
        );
        const plan = (c.status.plans as Record<string, { preview: string }>)[action]!;
        expect(rig.calls.find((call) => call.method === 'PUT')!.body).toEqual({
          enabled: action !== 'off',
          preview: plan.preview,
        });
      });
    }
  }

  it('switching the action after a preview needs a new preview: the other button only shows its plan', async () => {
    const rig = mountReview({
      state: 'needs_repair',
      preview: () =>
        json(status({ state: 'needs_repair', reason: 'entries_changed', plans: { repair, off } })),
    });
    const panel = await section();
    fireEvent.click(within(panel).getByRole('button', { name: 'Repair' }));
    expect(await within(panel).findByText('~/repair-only/settings.json')).toBeTruthy();
    // The owner changes their mind: turn off. That press shows turning off's plan and writes nothing.
    fireEvent.click(within(panel).getByRole('button', { name: 'Turn off' }));
    expect(await within(panel).findByText('~/off-only/settings.json')).toBeTruthy();
    expect(within(panel).queryByText('~/repair-only/settings.json')).toBeNull();
    expect(rig.calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
    // And back: pressing repair again shows repair's plan, still without a write.
    fireEvent.click(within(panel).getByRole('button', { name: 'Repair' }));
    expect(await within(panel).findByText('~/repair-only/settings.json')).toBeTruthy();
    expect(rig.calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
    // Confirming sends the fingerprint of the plan on screen.
    fireEvent.click(within(panel).getByRole('button', { name: 'Repair' }));
    await waitFor(() => expect(rig.calls.filter((call) => call.method === 'PUT')).toHaveLength(1));
    expect(rig.calls.find((call) => call.method === 'PUT')!.body).toEqual({
      enabled: true,
      preview: repair.preview,
    });
  });

  it('unavailable shows its reason and offers no button to press', async () => {
    for (const reason of ['no_claude_folder', 'settings_blocked', 'unsupported_path'] as const) {
      cleanup();
      mount({
        state: 'unavailable',
        preview: () => json(status({ state: 'unavailable', reason, files: [], plans: {} })),
      });
      const panel = await section();
      expect(
        within(panel).queryByRole('button', { name: /^(Turn on|Turn off|Repair)$/ }),
      ).toBeNull();
      fireEvent.click(within(panel).getByRole('button', { name: 'What will change' }));
      await waitFor(() =>
        expect(within(panel).queryByText('Reading your Claude Code settings…')).toBeNull(),
      );
    }
  });

  it('says in plain words what could not be removed, in the preview and after turning off', async () => {
    mount({
      state: 'off',
      preview: () =>
        json(
          status({
            state: 'off',
            reason: 'cleanup_incomplete',
            leftover: { folder: '~/data/claude-hooks', items: ['script', 'registry'] },
            plans: { on, off: planOf('off', [], ['script', 'registry']) },
          }),
        ),
    });
    const panel = await section();
    fireEvent.click(within(panel).getByRole('button', { name: 'What will change' }));
    expect(
      await within(panel).findByText(
        'HQ’s entries are out of Claude Code’s settings, but HQ could not remove its own files in ~/data/claude-hooks; you can delete them.',
      ),
    ).toBeTruthy();
  });

  it('says it was turned off but HQ’s own files remain, when the answer to turning off says so', async () => {
    mount({
      state: 'on',
      preview: () => json(status({ state: 'on', plans: { off } })),
      put: () =>
        json(
          status({
            state: 'off',
            reason: 'cleanup_incomplete',
            leftover: { folder: '~/data/claude-hooks', items: ['script'] },
          }),
        ),
    });
    const panel = await section();
    fireEvent.click(within(panel).getByRole('button', { name: 'Turn off' }));
    expect(
      await within(panel).findByText(
        'Turned off. HQ’s entries are removed from Claude Code’s settings, but HQ could not remove its own files in ~/data/claude-hooks; you can delete them.',
      ),
    ).toBeTruthy();
  });
});
