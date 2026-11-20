// "Shown once on this browser": a small flag in `localStorage` that says a first-time prompt has been seen, so it never opens by itself
// again. Nothing about the owner or their machine is stored, only that the named prompt was shown. Where the browser will not keep it
// (storage blocked), the prompt is simply treated as not yet shown, and the caller opens it at most once per visit to the page.

/** The key of HQ's first-time prompt for Claude Code's hooks switch. */
export const HQ_HOOKS_PROMPT_KEY = 'agent-productivity:hq-hooks-prompt-shown';

export function wasShown(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function markShown(key: string): void {
  try {
    window.localStorage.setItem(key, '1');
  } catch {
    // Not kept: the prompt may come again on the next visit.
  }
}
