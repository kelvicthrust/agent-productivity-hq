// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { CoverageStrip } from '../../src/client/components/CoverageStrip';
import { describeCoverage } from '../../src/client/components/coverageGroups';
import { ScopeLine } from '../../src/client/components/ScopeLine';
import type { AccountReport } from '../../src/shared/contracts/accounts';
import type { Scope } from '../../src/shared/contracts/common';
import type { OverviewResponse } from '../../src/shared/contracts/overview';

afterEach(cleanup);

type Coverage = OverviewResponse['coverage'];

const when = { timeZone: 'America/Los_Angeles', today: '2026-11-04' };

const healthy: Coverage = {
  sources: [
    // The API's order is not the design's: the strip keeps Codex, Claude Code, Paseo.
    { id: 'paseo', name: 'Paseo', status: 'partial', unreadable: 3, oldestDate: '2026-04-20' },
    {
      id: 'claude',
      name: 'Claude Code',
      status: 'ok',
      oldestDate: '2026-03-14',
      lastSuccessAt: '2026-11-04T17:42:00Z',
      lastAttemptAt: '2026-11-04T17:42:00Z',
      lastAttemptResult: 'succeeded',
    },
    { id: 'codex', name: 'Codex', status: 'ok', oldestDate: '2026-02-02' },
  ],
  github: { tracked: 3, inaccessible: 1 },
  accounts: [
    { id: 'claude', name: 'Claude', status: 'reconnect' },
    { id: 'chatgpt', name: 'ChatGPT', status: 'existing' },
    { id: 'github', name: 'GitHub', status: 'connected' },
  ],
  lastRefreshAt: '2026-11-04T17:42:00Z',
  refreshFailed: false,
};

const chatgptReport: AccountReport = {
  account: 'chatgpt',
  unit: 'tokens',
  bucketSpan: { start: '2026-10-06', end: '2026-11-04' },
  scopeLabel: 'Account-wide',
  refreshedAt: '2026-11-04T17:00:00Z',
};

describe('describeCoverage', () => {
  it('shows an unchecked Claude plan as optional even when local Claude history is readable', () => {
    const summary = describeCoverage({
      sources: healthy.sources,
      accounts: [{ id: 'claude', name: 'Claude plan limits', status: 'notconnected' }],
    });
    expect(summary.groups.find((group) => group.id === 'accounts')?.items).toEqual([
      { name: 'Claude plan limits', state: 'none', text: 'Not checked yet' },
    ]);
  });

  it('does not tick ChatGPT as ok when the account is not connected, whatever report is stored', () => {
    // The server returns the stored report whatever the status; the card and Sources must tell the same story.
    for (const status of ['notconnected', 'needsapp'] as const) {
      const items = describeCoverage(
        { accounts: [{ id: 'chatgpt', name: 'ChatGPT', status }] },
        [chatgptReport],
        when,
      ).groups.find((group) => group.id === 'accounts')!.items;
      expect(items).toEqual([{ state: 'notfound', name: 'ChatGPT', text: 'not connected' }]);
    }
  });

  it('still ticks a connected ChatGPT that has a report, and a Claude plan whose report came from a legacy snapshot', () => {
    expect(
      describeCoverage(
        { accounts: [{ id: 'chatgpt', name: 'ChatGPT', status: 'connected' }] },
        [chatgptReport],
        when,
      ).groups.find((group) => group.id === 'accounts')!.items[0],
    ).toMatchObject({ state: 'ok', text: 'tokens · Oct 6 – Nov 4, 2026' });
    expect(
      describeCoverage(
        { accounts: [{ id: 'claude', name: 'Claude', status: 'notconnected' }] },
        [{ ...chatgptReport, account: 'claude', unit: 'percent', bucketSpan: null }],
        when,
      ).groups.find((group) => group.id === 'accounts')!.items[0],
    ).toMatchObject({ state: 'ok', text: '% of limit only' });
  });

  it('shows pending ChatGPT sign-in even when the last account report is still present', () => {
    const statusText = 'Waiting for sign-in…';
    const summary = describeCoverage(
      { accounts: [{ id: 'chatgpt', name: 'ChatGPT', status: 'connecting', statusText }] },
      [chatgptReport],
      when,
    );
    expect(summary.groups.find((group) => group.id === 'accounts')?.items).toEqual([
      { name: 'ChatGPT', state: 'info', text: statusText },
    ]);
  });

  it('words each source’s state, in the design’s order', () => {
    const { groups } = describeCoverage(healthy, [chatgptReport], when);
    const machine = groups.find((g) => g.id === 'machine')!;
    expect(machine.items.map((i) => `${i.name} ${i.text}`)).toEqual([
      'Codex since Feb 2, 2026',
      'Claude Code since Mar 14, 2026',
      'Paseo partial · 3 unreadable',
    ]);
    expect(machine.items.map((i) => i.state)).toEqual(['ok', 'ok', 'partial']);
  });

  it('words delivery with a plural that agrees, and marks inaccessible repos', () => {
    const delivery = (github: Coverage['github']) =>
      describeCoverage({ ...healthy, github }, [], when).groups.find((g) => g.id === 'delivery')!
        .items[0]!;
    expect(delivery({ tracked: 3, inaccessible: 1 })).toEqual({
      state: 'partial',
      name: 'GitHub',
      text: '3 repos tracked · 1 inaccessible',
    });
    expect(delivery({ tracked: 1, inaccessible: 0 })).toMatchObject({
      state: 'ok',
      text: '1 repo tracked',
    });
    expect(delivery({ tracked: 0, inaccessible: 0 })).toMatchObject({
      state: 'notfound',
      text: '0 repos tracked',
    });
  });

  it('marks a failed GitHub refresh even when all tracked repos are reachable', () => {
    const coverage: Coverage = {
      sources: [
        {
          id: 'github',
          name: 'GitHub',
          status: 'failed',
          lastAttemptResult: 'failed',
          lastAttemptAt: '2026-11-04T17:40:00Z',
        },
      ],
      github: { tracked: 1, inaccessible: 0 },
    };
    const summary = describeCoverage(coverage, [], when);
    expect(summary.groups.find((group) => group.id === 'delivery')?.items[0]).toEqual({
      state: 'failed',
      name: 'GitHub',
      text: '1 repo tracked · refresh failed',
    });
  });

  it('words account reports: tokens with their window, percent only, reconnect, none', () => {
    const accounts = (coverage: Partial<Coverage>, reports: AccountReport[]) =>
      describeCoverage({ ...healthy, ...coverage }, reports, when).groups.find(
        (g) => g.id === 'accounts',
      )!.items;
    expect(accounts({}, [chatgptReport]).map((i) => `${i.name} ${i.text}`)).toEqual([
      'ChatGPT tokens · Oct 6 – Nov 4, 2026',
      'Claude plan limits reconnect needed',
    ]);
    expect(
      accounts({ accounts: [{ id: 'claude', name: 'Claude', status: 'connected' }] }, [
        { ...chatgptReport, account: 'claude', unit: 'percent', bucketSpan: null },
      ]),
    ).toEqual([{ state: 'ok', name: 'Claude plan limits', text: '% of limit only' }]);
    expect(
      accounts({ accounts: [{ id: 'chatgpt', name: 'ChatGPT', status: 'notconnected' }] }, []),
    ).toEqual([{ state: 'notfound', name: 'ChatGPT', text: 'not connected' }]);
    // Connected with nothing read yet is not "not connected": the card and Sources say Connected.
    expect(
      accounts(
        {
          accounts: [
            { id: 'claude', name: 'Claude', status: 'connected' },
            { id: 'chatgpt', name: 'ChatGPT', status: 'existing' },
          ],
        },
        [],
      ),
    ).toEqual([
      { state: 'ok', name: 'ChatGPT', text: 'connected · no report yet' },
      { state: 'ok', name: 'Claude plan limits', text: 'connected · no report yet' },
    ]);
  });

  it('words the failing and missing source states', () => {
    const states = (sources: Coverage['sources']) =>
      describeCoverage({ ...healthy, sources }, [], when).groups[0]!.items.map(
        (i) => `${i.state}: ${i.text}`,
      );
    expect(
      states([
        {
          id: 'codex',
          name: 'Codex',
          status: 'failed',
          lastAttemptAt: '2026-11-04T17:40:00Z',
          lastAttemptResult: 'failed',
        },
        { id: 'claude', name: 'Claude Code', status: 'notfound' },
        { id: 'paseo', name: 'Paseo', status: 'needspassword' },
      ]),
    ).toEqual(['failed: refresh failed', 'notfound: not found', 'denied: needs a password']);
    expect(
      states([{ id: 'paseo', name: 'Paseo', status: 'notrunning', hasRetainedData: true }]),
    ).toEqual(['stale: not running']);
    expect(states([{ id: 'paseo', name: 'Paseo', status: 'notrunning' }])).toEqual([
      'notfound: not running',
    ]);
  });

  it('distinguishes a completed attempt from the last successful refresh', () => {
    expect(describeCoverage(healthy, [], when)).toMatchObject({
      refreshed: 'Last successful refresh today, 9:42 AM',
      attempted: null,
    });
    const failed: Coverage['sources'] = [
      {
        id: 'codex',
        name: 'Codex',
        status: 'failed',
        lastAttemptAt: '2026-11-04T17:40:00Z',
        lastAttemptResult: 'failed',
      },
    ];
    expect(describeCoverage({ sources: failed }, [], when)).toMatchObject({
      refreshed: null,
      attempted: 'Latest attempt today, 9:40 AM',
    });
    failed[0]!.lastSuccessAt = '2026-11-04T02:12:00Z';
    expect(describeCoverage({ sources: failed }, [], when)).toMatchObject({
      refreshed: 'Last successful refresh Nov 3, 6:12 PM',
      attempted: 'Latest attempt today, 9:40 AM',
    });
  });

  it('drops a group with nothing in it', () => {
    const { groups } = describeCoverage({ github: { tracked: 0 } }, [], when);
    expect(groups.map((g) => g.id)).toEqual(['delivery']);
  });
});

describe('CoverageStrip', () => {
  function renderStrip(coverage: Coverage = healthy) {
    return render(
      <MemoryRouter>
        <CoverageStrip {...describeCoverage(coverage, [chatgptReport], when)} />
      </MemoryRouter>,
    );
  }

  it('is a labelled region with three named groups', () => {
    renderStrip();
    const region = screen.getByRole('region', { name: 'Source coverage' });
    const groups = within(region).getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('aria-labelledby')).every(Boolean)).toBe(true);
    for (const name of ['This machine', 'Delivery', 'Account reports'])
      expect(screen.getByRole('group', { name })).toBeTruthy();
  });

  it('carries state as words beside decorative icons', () => {
    const { container } = renderStrip();
    const machine = screen.getByRole('group', { name: 'This machine' });
    expect(machine.textContent).toContain('Codex since Feb 2, 2026');
    expect(machine.textContent).toContain('Paseo partial · 3 unreadable');
    expect(screen.getByRole('group', { name: 'Delivery' }).textContent).toContain(
      'GitHub 3 repos tracked · 1 inaccessible',
    );
    const accounts = screen.getByRole('group', { name: 'Account reports' }).textContent;
    expect(accounts).toContain('ChatGPT tokens · Oct 6 – Nov 4, 2026');
    expect(accounts).toContain('Claude plan limits reconnect needed');
    const icons = Array.from(container.querySelectorAll('[role="group"] svg'));
    expect(icons.length).toBe(6);
    for (const icon of icons) expect(icon.getAttribute('aria-hidden')).toBe('true');
  });

  it('ends with the refresh time and a link to manage sources', () => {
    renderStrip();
    expect(screen.getByText('Last successful refresh today, 9:42 AM')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Manage sources' }).getAttribute('href')).toBe(
      '/sources',
    );
  });

  it('says "Last successful refresh" while a refresh is failing', () => {
    renderStrip({ ...healthy, refreshFailed: true });
    expect(screen.getByText('Last successful refresh today, 9:42 AM')).toBeTruthy();
  });

  it('adapts to its own width: compact by default, a capsule from 900px', () => {
    const { container } = renderStrip();
    const host = container.firstElementChild!;
    expect(host.className).toContain('@container');
    const region = screen.getByRole('region', { name: 'Source coverage' });
    expect(region.className).toContain('grid');
    expect(region.className).toContain('@[900px]:flex');
    expect(region.className).toContain('@[900px]:rounded-full');
  });
});

describe('ScopeLine', () => {
  const delivery = { repos: [], author: 'mine' } satisfies Pick<Scope, 'repos' | 'author'>;
  const usage = { repos: ['kelvin/atlas-api'], provider: 'codex' } satisfies Pick<
    Scope,
    'repos' | 'provider'
  >;

  it('says what a delivery figure covers', () => {
    render(<ScopeLine delivery={delivery} />);
    expect(screen.getByText('All repos · Authored by you')).toBeTruthy();
  });

  it('says what a usage figure covers', () => {
    render(<ScopeLine usage={usage} />);
    expect(screen.getByText('This machine · kelvin/atlas-api · Codex')).toBeTruthy();
  });

  it('labels both when a card shows both', () => {
    render(
      <ScopeLine
        delivery={{ repos: ['a/b', 'c/d'], author: 'all' }}
        usage={{ repos: [], provider: 'all' }}
      />,
    );
    expect(
      screen.getByText(
        'PRs: 2 repos · All authors · Tokens: This machine · All repos · All providers',
      ),
    ).toBeTruthy();
  });

  it('adds words after the scope and a tag chip', () => {
    const { container } = render(
      <ScopeLine tag="Not filtered by repo">Account-wide · own reporting window</ScopeLine>,
    );
    expect(container.textContent).toBe('Account-wide · own reporting windowNot filtered by repo');
    expect(screen.getByText('Not filtered by repo').className).toContain('rounded-full');
    cleanup();
    const both = render(<ScopeLine usage={usage}>Repo → root session → child agents</ScopeLine>);
    expect(both.container.textContent).toBe(
      'This machine · kelvin/atlas-api · Codex · Repo → root session → child agents',
    );
  });
});
