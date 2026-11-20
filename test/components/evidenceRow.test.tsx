// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EvidenceItemRow } from '../../src/client/features/delivery/evidence/EvidenceItemRow';
import type { EvidenceItem } from '../../src/client/lib/links';

// The Delivery evidence row: the badge keeps its own 22px pill height instead of stretching down the grid's rows, and the
// session's buddy leads the identity without changing any accessible name.

afterEach(cleanup);

const ITEM: EvidenceItem = {
  session: {
    id: 7,
    provider: 'claude',
    kind: 'root',
    nameLead: 'planner',
    named: true,
    providerSessionRef: 'thread 7f3a…2c91',
    model: 'claude-sonnet',
    tokens: 12_000,
    startedAt: '2026-11-02T18:52:00Z',
    startedBasis: 'source_start',
    firstEventAt: '2026-11-02T18:52:00Z',
    lastEventAt: '2026-11-02T19:52:00Z',
    linkStatus: 'linked',
    linkedPrs: [],
  },
  effectiveClass: 'evidence',
  basis: 'pr_reference',
  basisText: 'The PR text names this session.',
  actions: ['reject'],
};

describe('EvidenceItemRow', () => {
  it('keeps the badge a pill at its own height: it aligns to the start of its grid area, not stretched', () => {
    render(<EvidenceItemRow item={ITEM} timeZone="UTC" pending={null} onAct={vi.fn()} />);
    const badge = screen.getByText('Evidence link');
    expect(badge.classList.contains('self-start')).toBe(true);
    expect(badge.classList.contains('justify-self-start')).toBe(true);
  });

  it('leads the session with its buddy at 18px, hidden from assistive technology', () => {
    const { container } = render(
      <EvidenceItemRow item={ITEM} timeZone="UTC" pending={null} onAct={vi.fn()} />,
    );
    const buddy = container.querySelector('li svg[width="18"]');
    expect(buddy?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('button', { name: /^Mark incorrect: planner/ })).toBeTruthy();
  });
});
