// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SessionIdentity,
  relationshipOf,
  type SessionIdentityData,
} from '../../src/client/components/SessionIdentity';

afterEach(cleanup);

const TZ = 'America/Los_Angeles';

const base: SessionIdentityData = {
  kind: 'root',
  nameLead: 'Root session',
  named: false,
  providerSessionRef: 'thread 7f3a…2c91',
  provider: 'codex',
  model: 'gpt-5.2-codex',
  startedAt: '2026-11-02T18:52:00Z',
  startedBasis: 'source_start',
};

/** The three lines under the lead, as plain text: [relationship line, id line, meta line]. */
function lines(container: HTMLElement) {
  const spans = Array.from(container.firstElementChild!.children) as HTMLElement[];
  return { lead: spans[0]!, sub: spans[1]!, ref: spans[2]!, meta: spans[3] };
}

describe('SessionIdentity lead', () => {
  it('leads with the recorded name when there is one', () => {
    const { container } = render(
      <SessionIdentity
        timeZone={TZ}
        session={{ ...base, named: true, nameLead: 'planner', paseo: { workspace: 'atlas-api' } }}
      />,
    );
    expect(lines(container).lead.textContent).toBe('planner');
  });

  it('leads with the recorded relationship, and says no name was recorded, when there is none', () => {
    const { container } = render(<SessionIdentity timeZone={TZ} session={base} />);
    const { lead, sub } = lines(container);
    expect(lead.textContent).toBe('Root session');
    expect(sub.textContent).toBe('No name recorded');
  });

  it('never makes a name up: an unknown relationship stays "Unknown relationship"', () => {
    const { container } = render(
      <SessionIdentity
        timeZone={TZ}
        session={{ ...base, kind: 'unknown', nameLead: 'Unknown relationship' }}
      />,
    );
    expect(lines(container).lead.textContent).toBe('Unknown relationship');
    expect(lines(container).sub.textContent).toBe('No name recorded');
  });

  it('derives the relationship from the kind when the server does not send a label', () => {
    expect(relationshipOf(base)).toBe('Root session');
    expect(relationshipOf({ ...base, kind: 'unknown' })).toBe('Unknown relationship');
    expect(relationshipOf({ ...base, kind: 'child' })).toBe('Native subagent');
    expect(relationshipOf({ ...base, kind: 'child', paseo: { workspace: 'x' } })).toBe(
      'Paseo child agent',
    );
    expect(relationshipOf({ ...base, relationshipLabel: 'Native subagent' })).toBe(
      'Native subagent',
    );
  });
});

describe('SessionIdentity relationship line', () => {
  const named = (extra: Partial<SessionIdentityData>): SessionIdentityData => ({
    ...base,
    named: true,
    nameLead: 'planner',
    ...extra,
  });

  it('reads relationship · Paseo · workspace for a named Paseo root', () => {
    const { container } = render(
      <SessionIdentity session={named({ paseo: { workspace: 'atlas-api' } })} timeZone={TZ} />,
    );
    expect(lines(container).sub.textContent).toBe('Root session · Paseo · atlas-api');
  });

  it('does not say Paseo twice for a Paseo child agent', () => {
    const { container } = render(
      <SessionIdentity
        session={named({ kind: 'child', paseo: { workspace: 'atlas-api' } })}
        timeZone={TZ}
      />,
    );
    expect(lines(container).sub.textContent).toBe('Paseo child agent · atlas-api');
  });

  it('does not claim Paseo for a session named by its provider title (no Paseo record)', () => {
    const { container } = render(<SessionIdentity session={named({})} timeZone={TZ} />);
    expect(lines(container).sub.textContent).toBe('Root session');
  });

  it('appends details, skipping empty ones', () => {
    const { container } = render(
      <SessionIdentity
        session={base}
        details={['2 children', false, undefined, 'parent outside current filters']}
        timeZone={TZ}
      />,
    );
    expect(lines(container).sub.textContent).toBe(
      'No name recorded · 2 children · parent outside current filters',
    );
  });
});

describe('SessionIdentity id and meta line', () => {
  it('shows the technical id, prefixed for screen readers only', () => {
    const { container } = render(<SessionIdentity session={base} timeZone={TZ} />);
    const { ref } = lines(container);
    expect(ref.textContent).toBe('Session ID: thread 7f3a…2c91');
    const prefix = ref.querySelector('.sr-only');
    expect(prefix?.textContent).toBe('Session ID: ');
    expect(ref.className).toContain('font-mono');
  });

  it('reads provider · model · Started <time> in the report timezone', () => {
    const { container } = render(<SessionIdentity session={base} timeZone={TZ} />);
    expect(lines(container).meta?.textContent).toBe(
      'Codex · gpt-5.2-codex · Started Nov 2, 10:52 AM',
    );
    const time = container.querySelector('time');
    expect(time?.textContent).toBe('Started Nov 2, 10:52 AM');
    expect(time?.getAttribute('datetime')).toBe('2026-11-02T18:52:00Z');
  });

  it('names Claude Code in full and leaves a missing model out', () => {
    const { container } = render(
      <SessionIdentity session={{ ...base, provider: 'claude', model: undefined }} timeZone={TZ} />,
    );
    expect(lines(container).meta?.textContent).toBe('Claude Code · Started Nov 2, 10:52 AM');
  });

  it('can leave the meta line out where the table has columns for those values', () => {
    const { container } = render(<SessionIdentity session={base} showMeta={false} timeZone={TZ} />);
    expect(lines(container).meta).toBeUndefined();
    expect(container.querySelector('time')).toBeNull();
    expect(screen.queryByText(/Started/)).toBeNull();
  });

  it('says in its accessible description when Started is the first recorded activity', () => {
    const { container } = render(
      <SessionIdentity session={{ ...base, startedBasis: 'first_event' }} timeZone={TZ} />,
    );
    const time = container.querySelector('time')!;
    const description = document.getElementById(time.getAttribute('aria-describedby')!);
    expect(description?.textContent).toBe(
      'First recorded activity; this source doesn’t record a start time',
    );
    expect(description?.className).toContain('sr-only');
    // The visible words do not change: it is "Started" either way.
    expect(time.textContent).toBe('Started Nov 2, 10:52 AM');
  });

  it('has no description when the source recorded its start', () => {
    const { container } = render(<SessionIdentity session={base} timeZone={TZ} />);
    expect(container.querySelector('time')?.hasAttribute('aria-describedby')).toBe(false);
  });
});
