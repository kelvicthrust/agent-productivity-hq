import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { NativeRequest } from '../client/native-api.ts';
import { ReportingProvider, useDashboard, useReportFilters } from '../client/native-reporting.tsx';

vi.mock('react-native', () => ({}));
vi.mock('@getpaseo/plugin/client', () => ({}));
vi.mock('@getpaseo/plugin/client/ui', () => ({}));
afterEach(cleanup);

it.each(['delivery', 'usage'] as const)(
  'applies the selected chart bucket when opening %s',
  (page) => {
    const open = vi.fn();
    const request = vi.fn() as unknown as NativeRequest;

    function Report() {
      const { changeFilters, navigate } = useDashboard();
      const { start, end, provider } = useReportFilters();
      return (
        <>
          <button onClick={() => changeFilters({ provider: 'codex' })}>Only Codex</button>
          <button onClick={() => navigate(page, { start: '2026-11-04', end: '2026-11-04' })}>
            Open bucket
          </button>
          <output>{[start, end, provider].join(' / ')}</output>
        </>
      );
    }

    render(
      <ReportingProvider
        bootstrap={{
          setupComplete: true,
          today: '2026-11-04',
          lookbackStart: '2025-11-04',
          timezone: 'UTC',
          issues: [],
        }}
        hostId="host"
        request={request}
        navigate={open}
      >
        <Report />
      </ReportingProvider>,
    );
    fireEvent.click(screen.getByText('Only Codex'));
    expect(screen.getByText('2026-11-02 / 2026-11-08 / codex')).toBeTruthy();
    fireEvent.click(screen.getByText('Open bucket'));
    expect(screen.getByText('2026-11-04 / 2026-11-04 / codex')).toBeTruthy();
    expect(open).toHaveBeenCalledExactlyOnceWith(page, { start: '2026-11-04', end: '2026-11-04' });
  },
);
