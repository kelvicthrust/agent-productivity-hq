import { describe, expect, it } from 'vitest';
import * as copy from '../../src/client/lib/copy';

const { attemptLine, failureWord, BANNER_COPY, REFRESH_COPY, SOURCES_COPY, LINK_LABELS } = copy;

describe('the attempt line', () => {
  it('says "failed" for the first failure and "failed again" after that', () => {
    expect(failureWord(1)).toBe('failed');
    expect(failureWord(2)).toBe('failed again');
    expect(failureWord(5)).toBe('failed again');
    // A failed run with no count yet is a first failure, not a repeat.
    expect(failureWord(0)).toBe('failed');
  });

  it('is the same sentence for the banner and for Sources & repos', () => {
    expect(attemptLine('Codex', 1, 'today, 9:40 AM')).toBe('Codex refresh failed today, 9:40 AM');
    expect(attemptLine('Codex', 2, 'today, 9:52 AM')).toBe(
      'Codex refresh failed again today, 9:52 AM',
    );
    expect(REFRESH_COPY.failedAttempt(1, 'today, 9:40 AM')).toBe('Failed today, 9:40 AM');
    expect(REFRESH_COPY.failedAttempt(2, 'today, 9:52 AM')).toBe('Failed again today, 9:52 AM');
  });
});

describe('the failed-refresh banner and Retry', () => {
  it('names the last successful refresh separately from the failure and retained data', () => {
    expect(BANNER_COPY.heading).toBe('Refresh failed.');
    expect(BANNER_COPY.body('Codex', 1, 'today, 9:40 AM', 'Nov 3, 6:12 PM', true)).toBe(
      'Codex refresh failed today, 9:40 AM. Last successful refresh: Nov 3, 6:12 PM. Codex usage since then isn’t collected yet. Previously collected records are kept.',
    );
    expect(BANNER_COPY.body('Claude Code', 2, 'today, 9:52 AM', 'Nov 3, 6:12 PM', true)).toContain(
      'Claude Code refresh failed again today, 9:52 AM. Last successful refresh: Nov 3, 6:12 PM.',
    );
  });

  it('makes no cache claim on a first failure without imported records', () => {
    expect(BANNER_COPY.body('Codex', 1, 'today, 9:40 AM', null, false)).toBe(
      'Codex refresh failed today, 9:40 AM.',
    );
    expect(BANNER_COPY.body('Codex', 1, 'today, 9:40 AM', null, true)).toBe(
      'Codex refresh failed today, 9:40 AM. Previously collected records are kept.',
    );
  });

  it('has the Retry button states', () => {
    expect(BANNER_COPY.viewSource).toBe('View source');
    expect(BANNER_COPY.retry).toBe('Retry');
    expect(BANNER_COPY.retrying).toBe('Retrying…');
  });

  it('has the Retry result toasts, with counts that agree with their numbers', () => {
    const toast = REFRESH_COPY.toast;
    expect(toast.recovered('Codex', 1)).toBe(
      'Codex refreshed · 1 new session imported. Records already imported were skipped.',
    );
    expect(toast.recovered('Codex', 4)).toBe(
      'Codex refreshed · 4 new sessions imported. Records already imported were skipped.',
    );
    expect(toast.failed('Codex', true)).toBe('Codex still couldn’t be refreshed. Try again.');
    expect(toast.failed('Codex', false)).toBe('Codex couldn’t be refreshed. Try again.');
    expect(toast.partial('Paseo', 1)).toBe('Paseo refreshed · 1 record still unreadable.');
    expect(toast.partial('Paseo', 3)).toBe('Paseo refreshed · 3 records still unreadable.');
    expect(toast.noNewRecords('Codex')).toBe(
      'Codex refreshed · no new records. Nothing was duplicated.',
    );
  });
});

describe('the Partial status tag', () => {
  it('says how many records could not be read, as a number only, and stays plain without one', () => {
    expect(copy.STATUS_TEXT.partial).toBe('Partial');
    expect(copy.STATUS_TEXT.partialUnreadable(1)).toBe('Partial · 1 unreadable');
    expect(copy.STATUS_TEXT.partialUnreadable(1234)).toBe('Partial · 1,234 unreadable');
  });
});

describe('Sources & repos copy', () => {
  it('moved verbatim', () => {
    expect(SOURCES_COPY.title).toBe('Sources & repos');
    expect(SOURCES_COPY.subtitle).toBe('Setup and upkeep. Everyday review lives in Overview.');
    expect(SOURCES_COPY.repos.error.malformed).toBe(
      'That doesn’t look like a GitHub repository. Use owner/name, for example kelvin/atlas-api.',
    );
    expect(SOURCES_COPY.repos.confirmHeading('kelvin/atlas-api')).toBe(
      'Stop tracking kelvin/atlas-api?',
    );
    expect(SOURCES_COPY.local.historyFrom('Feb 2, 2026', 1)).toBe(
      'History from Feb 2, 2026 · 1 session',
    );
    expect(SOURCES_COPY.local.historyFrom('Feb 2, 2026', 12)).toBe(
      'History from Feb 2, 2026 · 12 sessions',
    );
  });

  it('names the link bases as Delivery does', () => {
    expect(LINK_LABELS).toEqual({
      evidence: 'Evidence link',
      owner: 'Owner-confirmed',
      suggested: 'Suggested',
      unlinked: 'Unlinked',
      rejected: 'Marked incorrect',
    });
  });
});

// Every string the module can produce, calling the templates with sample arguments.
function collect(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (typeof value === 'function') {
    for (const args of [
      ['Codex', 2, 'today, 9:40 AM', 'Nov 3, 6:12 PM'],
      [2, 'today, 9:40 AM'],
      [2, 3],
      [2],
    ]) {
      try {
        const result = (value as (...a: unknown[]) => unknown)(...args);
        if (typeof result === 'string') out.push(result);
      } catch {
        // A template that does not take these arguments is covered by another sample.
      }
    }
  } else if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) collect(inner, out);
  }
  return out;
}

describe('fixture phrases are not shipped', () => {
  const all = collect(copy);

  it('has strings to check', () => {
    expect(all.length).toBeGreaterThan(100);
  });

  it('drops "(simulated)", the "private" rule and the fixture notes', () => {
    for (const text of all) {
      expect(text, text).not.toMatch(/simulated/i);
      expect(text, text).not.toMatch(/prototype/i);
      expect(text, text).not.toMatch(/fixture/i);
      expect(text, text).not.toMatch(/names containing/i);
      expect(text, text).not.toMatch(/not yet verified/i);
    }
    // The hint keeps the real sentence: private repositories work when GitHub can read them.
    expect(SOURCES_COPY.repos.hint).toBe(
      'Private repos work when your GitHub connection can read them.',
    );
    expect(SOURCES_COPY.accounts.toast.opening('ChatGPT')).toBe(
      'Opening ChatGPT sign-in in your browser…',
    );
  });
});

describe('the GitHub sync is worded as merged PRs, not as usage or sessions', () => {
  const { recordsOf, SOURCE_NAMES } = copy;

  it('names GitHub, and says what is not being collected', () => {
    expect(SOURCE_NAMES.github).toBe('GitHub');
    const github = recordsOf('github');
    expect(
      BANNER_COPY.body(
        'GitHub',
        1,
        'today, 9:40 AM',
        'Nov 3, 6:12 PM',
        true,
        github.uncollected('GitHub'),
      ),
    ).toBe(
      'GitHub refresh failed today, 9:40 AM. Last successful refresh: Nov 3, 6:12 PM. Merged PRs since then aren’t collected yet. Previously collected records are kept.',
    );
    // the local sources keep the prototype's sentence
    expect(recordsOf('codex').uncollected('Codex')).toBe(
      'Codex usage since then isn’t collected yet',
    );
    expect(BANNER_COPY.body('Codex', 1, 'today, 9:40 AM', 'Nov 3, 6:12 PM', true)).toContain(
      'Codex usage since then isn’t collected yet',
    );
  });

  it('counts what GitHub brought in as merged PRs, singular and plural', () => {
    const { noun } = recordsOf('github');
    expect(REFRESH_COPY.toast.recovered('GitHub', 1, noun)).toBe(
      'GitHub refreshed · 1 new merged PR imported. Records already imported were skipped.',
    );
    expect(REFRESH_COPY.toast.recovered('GitHub', 12, noun)).toContain(
      '12 new merged PRs imported',
    );
    expect(REFRESH_COPY.toast.allRecovered('GitHub', 3, noun)).toBe(
      'Refreshed all sources · GitHub recovered with 3 new merged PRs; nothing duplicated.',
    );
    // and the local sources still count sessions
    expect(REFRESH_COPY.toast.recovered('Codex', 4)).toContain('4 new sessions imported');
  });
});
