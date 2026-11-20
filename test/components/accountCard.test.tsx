// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountCard, type ReportingAccount } from '../../src/client/components/AccountCard';
import { AccountCards } from '../../src/client/features/overview/AccountCards';
import type { AccountReport } from '../../src/shared/contracts/accounts';

afterEach(cleanup);

const when = {
  timeZone: 'America/Los_Angeles',
  today: '2026-11-04',
  now: Date.parse('2026-11-04T17:42:00Z'),
};
const chatgpt = { id: 'chatgpt', name: 'ChatGPT', status: 'existing' } as const;
const claude = {
  id: 'claude',
  name: 'Claude',
  status: 'connected',
  planLimits: { state: 'ok', lastCheckedAt: null, retryAt: null, report: null },
} as const;

const weekly = {
  limitId: 'seven_day',
  label: 'Weekly',
  windowMinutes: 10_080,
  usedPercent: 62,
  resetsAt: '2026-11-05T17:00:00Z',
};
const short = {
  limitId: 'five_hour',
  label: '5-hour',
  windowMinutes: 300,
  usedPercent: 23,
  resetsAt: '2026-11-04T18:00:00Z',
};

const show = (account: ReportingAccount, report: AccountReport | null) =>
  render(
    <ul>
      <AccountCard account={account} report={report} when={when} />
    </ul>,
  );

const showSection = (accounts: ReportingAccount[]) =>
  render(
    <MemoryRouter>
      <AccountCards
        accounts={accounts}
        reports={[]}
        scope={{ provider: 'all' }}
        timeZone={when.timeZone}
        today={when.today}
      />
    </MemoryRouter>,
  );

const limitReport = (
  account: AccountReport['account'],
  rateLimits: AccountReport['rateLimits'],
): AccountReport => ({
  account,
  unit: 'percent',
  scopeLabel: 'Reported account scope',
  refreshedAt: '2026-11-04T17:00:00Z',
  rateLimits,
});

describe('the account section', () => {
  it.each(['connected', 'existing'] as const)(
    'has no action when ChatGPT is %s and Claude has been checked',
    (status) => {
      showSection([{ ...chatgpt, status }, claude]);
      const section = screen.getByRole('region', { name: 'Account-reported usage' });
      const heading = within(section).getByRole('heading');
      const scope = within(section).getByText('Not filtered by repo');
      expect(scope.parentElement).toBe(heading.parentElement);
      expect(within(section).queryByRole('link')).toBeNull();
      expect(within(section).queryByRole('button')).toBeNull();
    },
  );

  it('links to Sources for an unconnected account and one that needs to sign in again', () => {
    showSection([
      { ...chatgpt, status: 'reconnect' },
      { id: 'claude', name: 'Claude', status: 'notconnected' },
    ]);
    expect(
      screen.getByRole('link', { name: 'Reconnect ChatGPT in Sources' }).getAttribute('href'),
    ).toBe('/sources');
    expect(
      screen
        .getByRole('link', { name: 'Check Claude plan limits in Sources' })
        .getAttribute('href'),
    ).toBe('/sources');
  });
});

describe('the ChatGPT account card', () => {
  it('shows the weekly figure and reset, with no token totals or scope explanation', () => {
    show(chatgpt, limitReport('chatgpt', [short, weekly]));
    expect(screen.getByText('62%')).toBeTruthy();
    expect(screen.getByText('of weekly usage limit used')).toBeTruthy();
    expect(screen.getByText('Resets Nov 5, 9:00 AM')).toBeTruthy();
    expect(screen.getByText('As of today, 9:00 AM')).toBeTruthy();
    expect(screen.queryAllByText(/23%|Reported account scope|tokens/)).toHaveLength(0);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps weekly usage unavailable when the payload only has a token report', () => {
    show(chatgpt, {
      account: 'chatgpt',
      unit: 'tokens',
      periodTokens: 83_000,
      bucketSpan: { start: '2026-11-02', end: '2026-11-04' },
      scopeLabel: 'Reported account scope',
      refreshedAt: '2026-11-04T17:00:00Z',
    });
    expect(screen.getByText('Weekly usage unavailable.')).toBeTruthy();
    expect(screen.queryByText('83K')).toBeNull();
    expect(screen.queryByText(/tokens/)).toBeNull();
  });

  it('keeps the failure details without a connection action', () => {
    showSection([{ ...chatgpt, status: 'failed', statusText: 'Couldn’t read your ChatGPT usage' }]);
    expect(screen.getByText('Refresh failed')).toBeTruthy();
    expect(screen.getByText('Couldn’t read your ChatGPT usage')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('the Claude account card', () => {
  it('headlines the general weekly reading and always shows the 5-hour footnote', () => {
    const modelWeekly = { ...weekly, limitId: 'seven_day_sonnet', usedPercent: 95 };
    show(claude, limitReport('claude', [modelWeekly, short, weekly]));
    expect(screen.getByText('62%')).toBeTruthy();
    expect(screen.queryByText(/95%/)).toBeNull();
    expect(
      screen.getByText('5-hour window: 23% · resets today, 10:00 AM').closest('[hidden]'),
    ).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps the 5-hour footnote when neither window was reported', () => {
    show(claude, null);
    expect(screen.getByText('Weekly usage unavailable.')).toBeTruthy();
    expect(screen.getByText('5-hour window unavailable.')).toBeTruthy();
  });

  it('does not substitute a model-specific or 5-hour reading for a missing weekly window', () => {
    const modelWeekly = { ...weekly, limitId: 'seven_day_sonnet', usedPercent: 95 };
    show(claude, limitReport('claude', [modelWeekly, short]));
    expect(screen.getByText('Weekly usage unavailable.')).toBeTruthy();
    expect(screen.getByText('5-hour window: 23% · resets today, 10:00 AM')).toBeTruthy();
    expect(screen.queryByText(/95%/)).toBeNull();
  });

  it('identifies a legacy snapshot and hides old percentages for independently reset windows', () => {
    const resetsAt = '2026-11-04T17:00:00Z';
    show(claude, {
      ...limitReport('claude', [
        { ...short, resetsAt },
        { ...weekly, resetsAt },
      ]),
      provenance: 'claude_statusline',
      stale: true,
    });
    expect(screen.getByText(/Saved status-line snapshot/)).toBeTruthy();
    expect(screen.getByText('Weekly window reset today, 9:00 AM.')).toBeTruthy();
    expect(screen.getByText('5-hour window reset today, 9:00 AM.')).toBeTruthy();
    expect(screen.queryByText(/23%|62%/)).toBeNull();
  });
});
