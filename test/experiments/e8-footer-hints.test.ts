import { describe, expect, it } from 'vitest';
import { hintList } from '../../scripts/experiments/e8-claude-probe.ts';

// E8's footer-hint lists are typed by the owner ("--footer-hints-without" and "--footer-hints-with"): the small keyboard reminders at
// the bottom of Claude Code, named with short lowercase words so they can only ever be identifiers (decision D10). The owner could not
// tell what to type when a view showed no hints, so `none` now means exactly that: an empty list, never a hint that is named none.

describe('E8 footer hint lists', () => {
  it('reads short lowercase words, trimmed, lowercased and without repeats', () => {
    expect(hintList(['Shortcuts, esc-to-interrupt ,shortcuts'])).toEqual({
      ids: ['esc-to-interrupt', 'shortcuts'],
      ignored: 0,
    });
    expect(hintList(['hold-space-to-speak', 'shift-tab-to-cycle'])).toEqual({
      ids: ['hold-space-to-speak', 'shift-tab-to-cycle'],
      ignored: 0,
    });
  });

  it('reads none as an empty list, whatever its case, and not as a mistake', () => {
    expect(hintList(['none'])).toEqual({ ids: [], ignored: 0 });
    expect(hintList(['NONE'])).toEqual({ ids: [], ignored: 0 });
    expect(hintList([' none '])).toEqual({ ids: [], ignored: 0 });
  });

  it('keeps the hints that are named beside a none, and does not take none out of a longer name', () => {
    expect(hintList(['none,shortcuts'])).toEqual({ ids: ['shortcuts'], ignored: 0 });
    expect(hintList(['none-of-them'])).toEqual({ ids: ['none-of-them'], ignored: 0 });
  });

  it('still counts what is not a short lowercase word as ignored, and never keeps it', () => {
    expect(hintList(['Press Esc!'])).toEqual({ ids: [], ignored: 1 });
    expect(hintList(['true'])).toEqual({ ids: [], ignored: 1 }); // what a flag with no value reads as
    expect(hintList(['x'.repeat(41)])).toEqual({ ids: [], ignored: 1 });
    expect(hintList(['/Users/someone/x'])).toEqual({ ids: [], ignored: 1 });
  });
});
