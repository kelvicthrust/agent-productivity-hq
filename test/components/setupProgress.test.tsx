// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SetupProgress } from '../../src/client/features/setup/SetupProgress';

// SETUP_STEPPER_MAPPING: the Setup indicator is D7's three pills (a product-owned ordered list), not the Astryx Stepper's connected track.
// Geometry at 1280, 390 and 320px is held in the browser by test/e2e/setup.spec.ts; these hold what needs no layout engine: the list's
// meaning (one current step, passed steps announced as done, nothing to focus) and that the route no longer draws the Stepper.

afterEach(cleanup);

const items = () =>
  within(screen.getByRole('list', { name: 'Setup progress' })).getAllByRole('listitem');

describe('SetupProgress', () => {
  it.each([0, 1, 2])(
    'marks exactly one current step, and every step before step %i as passed',
    (active) => {
      render(<SetupProgress activeStep={active} />);
      const rows = items();
      expect(rows.map((li) => li.getAttribute('aria-current'))).toEqual(
        [0, 1, 2].map((i) => (i === active ? 'step' : null)),
      );
      rows.forEach((li, i) => {
        // A passed step shows a check and is read as done; the others show their number. The marker itself is hidden from assistive technology.
        const marker = li.querySelector('[aria-hidden="true"]')!;
        expect(marker.querySelector('svg') !== null, `step ${i}`).toBe(i < active);
        expect(marker.textContent, `step ${i}`).toBe(i < active ? '' : String(i + 1));
        expect(li.querySelector('.sr-only')?.textContent ?? null, `step ${i}`).toBe(
          i < active ? ' (done)' : null,
        );
      });
    },
  );

  it('names the three steps in order, whole', () => {
    render(<SetupProgress activeStep={0} />);
    expect(items().map((li) => li.textContent)).toEqual([
      '1Local sources',
      '2Accounts',
      '3Repositories',
    ]);
  });

  it('is informational: no button, link or tab stop, and no progressbar, tab or track role', () => {
    const { container } = render(<SetupProgress activeStep={1} />);
    expect(container.querySelectorAll('a, button, input, [tabindex]')).toHaveLength(0);
    expect(container.querySelectorAll('[role]')).toHaveLength(0);
    const list = screen.getByRole('list', { name: 'Setup progress' });
    expect(list.tagName).toBe('OL');
    expect(Array.from(list.children).map((child) => child.tagName)).toEqual(['LI', 'LI', 'LI']);
  });

  it('wraps at pill boundaries in a row, with the design’s 8px gap, and never in a column', () => {
    render(<SetupProgress activeStep={0} />);
    const classes = screen.getByRole('list', { name: 'Setup progress' }).className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(['flex', 'flex-wrap', 'gap-2']));
    expect(classes.some((name) => /flex-col|max-\[|min-\[/.test(name))).toBe(false);
  });
});

describe('the Setup route', () => {
  const route = readFileSync(
    join(import.meta.dirname, '../../src/client/features/setup/route.tsx'),
    'utf8',
  );

  it('draws SetupProgress and does not use the Astryx Stepper or a phone-only orientation', () => {
    expect(route).toContain("import { SetupProgress } from './SetupProgress';");
    expect(route).toContain('<SetupProgress activeStep={step} />');
    expect(route).not.toMatch(/Stepper|orientation=|density=/);
  });
});
