// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BrandMark } from '../../src/client/components/BrandMark';
import { Buddy } from '../../src/client/components/Buddy';
import { CrewArt, type CrewMood } from '../../src/client/components/CrewArt';
import { Icon, type IconName } from '../../src/client/components/Icon';
import { LinkBadge, type LinkKind } from '../../src/client/components/LinkBadge';
import { StatusTag, type StatusKind } from '../../src/client/components/StatusTag';

afterEach(cleanup);

const svgs = (container: HTMLElement) => Array.from(container.querySelectorAll('svg'));

describe('decorative art is hidden from assistive technology', () => {
  it.each(['codex', 'claude', 'unknown'] as const)('the %s buddy', (kind) => {
    const { container } = render(<Buddy kind={kind} />);
    const [svg] = svgs(container);
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('focusable')).toBe('false');
  });

  it.each<CrewMood>(['awake', 'sleep', 'dizzy', 'search'])('the %s crew art', (mood) => {
    const { container } = render(<CrewArt mood={mood} />);
    expect(svgs(container)[0]?.getAttribute('aria-hidden')).toBe('true');
  });

  it('the brand mark', () => {
    const { container } = render(<BrandMark />);
    const mark = container.querySelector('img');
    expect(mark?.getAttribute('alt')).toBe('');
    expect(mark?.getAttribute('src')).toBe('/logbook.svg');
  });
});

describe('Buddy', () => {
  const markup = (kind: 'codex' | 'claude' | 'unknown', mood?: 'awake' | 'sleep' | 'dizzy') => {
    const { container } = render(<Buddy kind={kind} mood={mood} />);
    const html = svgs(container)[0]!.innerHTML;
    cleanup();
    return html;
  };

  it('draws a different shape for each provider, so colour is not the only cue', () => {
    const codex = markup('codex');
    const claude = markup('claude');
    const unknown = markup('unknown');
    // The owl is a boxy rounded rectangle with a yellow tuft; the fox is a round body with two pointed ears; the unknown is a dashed outline.
    expect(codex).toContain('<rect');
    expect(codex).toContain('stroke-sunshine');
    expect(codex).not.toContain('<ellipse');
    expect(claude).toContain('<circle');
    expect(claude).toContain('<ellipse'); // the pale muzzle
    expect(claude).not.toContain('<rect');
    expect(claude).not.toContain('stroke-sunshine');
    expect(unknown).toContain('stroke-dasharray');
    expect(codex).not.toContain('stroke-dasharray');
    expect(claude).not.toContain('stroke-dasharray');
    expect(new Set([codex, claude, unknown]).size).toBe(3);
  });

  it('keeps the colour of each provider on its own body', () => {
    expect(markup('claude')).toContain('fill-series-claude');
    expect(markup('codex')).toContain('fill-series-codex');
    expect(markup('unknown')).toContain('stroke-series-neutral');
  });

  it('has no animation and no outline filter, so it stays crisp at 16px', () => {
    for (const kind of ['codex', 'claude', 'unknown'] as const) {
      const html = markup(kind);
      expect(html).not.toMatch(/animate|filter|wobble/);
    }
  });

  it.each(['codex', 'claude', 'unknown'] as const)(
    'closes the eyes of the %s when asleep and crosses them when dizzy',
    (kind) => {
      const awake = markup(kind);
      const asleep = markup(kind, 'sleep');
      const dizzy = markup(kind, 'dizzy');
      expect(new Set([awake, asleep, dizzy]).size).toBe(3);
      // Open eyes are discs; closed lids and crossed eyes are strokes, in a different path each.
      const eyeCircles = (html: string) => (html.match(/<circle/g) ?? []).length;
      expect(eyeCircles(asleep)).toBeLessThan(eyeCircles(awake));
      expect(eyeCircles(dizzy)).toBe(eyeCircles(asleep));
      expect(asleep).toContain('Q');
      expect(dizzy).toContain('l3 3');
      expect(awake).not.toContain('Q');
    },
  );

  it('takes a size', () => {
    const { container } = render(<Buddy kind="codex" size={18} />);
    expect(svgs(container)[0]?.getAttribute('width')).toBe('18');
    expect(svgs(container)[0]?.getAttribute('viewBox')).toBe('0 0 20 20');
  });
});

describe('CrewArt', () => {
  it('shows the owl and the fox, and adds the neutral blob only when searching', () => {
    const shapes = (mood: CrewMood) => {
      const { container } = render(<CrewArt mood={mood} />);
      const html = svgs(container)[0]!.innerHTML;
      cleanup();
      return html;
    };
    for (const mood of ['awake', 'sleep', 'dizzy', 'search'] as const) {
      const html = shapes(mood);
      expect(html).toContain('<rect'); // the owl
      expect(html).toContain('<ellipse'); // the fox's muzzle (and the shadows)
    }
    expect(shapes('search')).toContain('stroke-dasharray');
    expect(shapes('awake')).not.toContain('stroke-dasharray');
  });
});

describe('Icon', () => {
  const names: IconName[] = [
    'check',
    'alert',
    'error',
    'none',
    'lock',
    'clock',
    'refresh',
    'external',
    'chevronRight',
    'chevronDown',
    'plus',
    'close',
    'info',
    'overview',
    'trends',
    'merge',
    'layers',
    'plug',
    'filter',
    'calendar',
    'dotSolid',
    'dotDashed',
    'dash',
    'spinner',
  ];

  it.each(names)('%s is drawn and decorative', (name) => {
    const { container } = render(<Icon name={name} />);
    const [svg] = svgs(container);
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('width')).toBe('16');
    expect(svg?.children.length).toBeGreaterThan(0);
  });

  it('scales the 16px drawing to a requested size', () => {
    const { container } = render(<Icon name="check" size={12} />);
    const [svg] = svgs(container);
    expect(svg?.getAttribute('width')).toBe('12');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 16 16');
  });

  it('stops spinning under reduced motion', () => {
    const { container } = render(<Icon name="spinner" />);
    const circle = container.querySelector('circle');
    expect(circle?.getAttribute('class')).toContain('animate-spin');
    expect(circle?.getAttribute('class')).toContain('motion-reduce:animate-none');
  });
});

describe('StatusTag', () => {
  const kinds: Array<[StatusKind, string]> = [
    ['ok', 'Found'],
    ['partial', 'Partial'],
    ['failed', 'Refresh failed'],
    ['denied', 'Access denied'],
    ['reconnect', 'Reconnect needed'],
    ['checking', 'Looking…'],
    ['notfound', 'Not found'],
  ];

  it.each(kinds)('%s says its status in words, with the icon decorative', (kind, words) => {
    const { container } = render(<StatusTag kind={kind}>{words}</StatusTag>);
    expect(screen.getByText(words)).toBeTruthy();
    expect(svgs(container)).toHaveLength(1);
    expect(svgs(container)[0]?.getAttribute('aria-hidden')).toBe('true');
  });

  it('uses a different icon for each family of status, not just a different colour', () => {
    const icon = (kind: StatusKind) => {
      const { container } = render(<StatusTag kind={kind}>x</StatusTag>);
      const markup = svgs(container)[0]!.innerHTML;
      cleanup();
      return markup;
    };
    const markups = [icon('ok'), icon('partial'), icon('failed'), icon('denied'), icon('notfound')];
    expect(new Set(markups).size).toBe(markups.length);
    expect(icon('checking')).toContain('animate-spin');
  });

  it('colours by tone', () => {
    const { container } = render(<StatusTag kind="failed">Refresh failed</StatusTag>);
    expect(container.firstElementChild?.className).toContain('text-danger');
  });
});

describe('LinkBadge', () => {
  const labels: Array<[LinkKind, string]> = [
    ['evidence', 'Evidence link'],
    ['owner', 'Owner-confirmed'],
    ['suggested', 'Suggested'],
    ['unlinked', 'Unlinked'],
    ['rejected', 'Marked incorrect'],
  ];

  it.each(labels)('%s is the words "%s"', (kind, label) => {
    const { container } = render(<LinkBadge kind={kind} />);
    expect(screen.getByText(label)).toBeTruthy();
    expect(svgs(container)[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(svgs(container)[0]?.getAttribute('width')).toBe('12');
  });

  it('gives each class its own fill style and icon', () => {
    const styles = labels.map(([kind]) => {
      const { container } = render(<LinkBadge kind={kind} />);
      const badge = container.firstElementChild!;
      const out = [badge.className, svgs(container)[0]!.innerHTML].join('|');
      cleanup();
      return out;
    });
    expect(new Set(styles).size).toBe(labels.length);
  });

  it('draws an evidence link as a soft selection pill, not a black fill', () => {
    const { container } = render(<LinkBadge kind="evidence" />);
    const classes = container.firstElementChild!.classList;
    expect(classes.contains('bg-selection-surface')).toBe(true);
    expect(classes.contains('text-action')).toBe(true);
    expect(classes.contains('bg-ink')).toBe(false);
  });

  it('strikes through only a link marked incorrect', () => {
    for (const [kind] of labels) {
      const { container } = render(<LinkBadge kind={kind} />);
      expect(container.firstElementChild?.className.includes('line-through')).toBe(
        kind === 'rejected',
      );
      cleanup();
    }
  });
});
