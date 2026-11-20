// One layout for every recovery page. The pages are PURE: a function from a few facts to an HTML string. They import nothing that
// reads, deletes, moves or rewrites a file (test/security/recovery-pages.test.ts holds them to that), so showing a page can never
// change the owner's data. What the owner can do is written out as steps; the owner runs them, the page never does.
//
// Every page says plainly that nothing was deleted or changed (TECH › Failure modes: "Data is never deleted automatically").
// The page is served under the app's CSP (`style-src 'self' 'unsafe-inline'`, no script), so it carries one <style> block and no script.

export const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

/**
 * A step's sentence as HTML: escaped text, where a name between backticks (`-wal`) is drawn as code that never breaks across lines (the style block below).
 * A browser may break after the hyphen of "-wal", leaving "-" at the end of one line and "wal" at the start of the next, which
 * reads as a different word to someone about to type it.
 */
const stepText = (text: string): string =>
  text
    .split('`')
    .map((part, index) => (index % 2 === 1 ? `<code>${escapeHtml(part)}</code>` : escapeHtml(part)))
    .join('');

/** A path or value as one shell word, safe to paste: wrapped in single quotes, each embedded single quote closed and reopened. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

export interface RecoveryStep {
  /** What to do, in a sentence. Plain text; it is escaped. */
  text: string;
  /** A command the owner can paste into Terminal. Plain text; it is escaped. */
  command?: string;
}

export interface RecoveryLayout {
  /** The browser tab title after "Agent Productivity HQ · ". */
  title: string;
  headline: string;
  /** The sentence that opens the page, before "Nothing was deleted or changed." */
  lead: string;
  /** Label and value pairs: a path, a port, the step that failed. Values show in code. */
  facts?: ReadonlyArray<{ label: string; value: string }>;
  /** Anything more to say about what happened, one short sentence each. */
  notes?: readonly string[];
  /** The heading over the steps, and the steps. */
  stepsTitle: string;
  steps: readonly RecoveryStep[];
}

/** What every page says, in these words, so the owner finds the reassurance in the same place each time. */
export const NOTHING_CHANGED = 'Nothing was deleted or changed.';

// The Agent Productivity HQ palette and type stacks are inlined so recovery can render without the application or its assets.
const STYLE = `
  :root {
    color-scheme: light;
    --canvas: #FBF8F3;
    --surface: #FFFFFF;
    --sunken: #F3EEE6;
    --border: #E8E1D6;
    --ink: #1F1B16;
    --ink-muted: #5F574D;
    --action: #5A3FD6;
    --selection: #EFEBFF;
    /* Not the dashboard stack: this page is a standalone document and does not load the self-hosted Nunito file, so Nunito is
       only a last-resort local fallback here (design-system/DESIGN.md D9). */
    --display: ui-rounded, "SF Pro Rounded", "Nunito", ui-sans-serif, system-ui, sans-serif;
  }
  body {
    margin: clamp(1.5rem, 5vw, 3rem) auto;
    padding: 0 1rem;
    max-width: 42rem;
    background: var(--canvas);
    color: var(--ink);
    font: 1rem/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  header p { margin: 0 0 1rem; font: 700 1rem/1.5 var(--display); }
  main {
    padding: clamp(1rem, 4vw, 2rem);
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--surface);
  }
  h1 { margin: 0 0 0.75rem; font: 700 1.5rem/1.25 var(--display); text-wrap: balance; }
  h2 { margin: 1.5rem 0 0.5rem; font: 700 1.125rem/1.4 var(--display); }
  p { margin: 0 0 0.75rem; color: var(--ink-muted); }
  header p { color: var(--ink); }
  p:has(> strong) { padding: 0.5rem 0.75rem; border-radius: 8px; background: var(--selection); color: var(--ink); }
  code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
  pre { margin: 0.5rem 0 0; padding: 0.5rem 0.75rem; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--sunken); border-radius: 8px; }
  ol { margin: 0; padding-left: 1.5rem; }
  li + li { margin-top: 0.75rem; }
  li::marker { color: var(--action); font-weight: 700; }
  li > code { white-space: nowrap; }
  ::selection { background: var(--selection); color: var(--ink); }
`;

export function renderRecoveryPage(layout: RecoveryLayout): string {
  const facts = (layout.facts ?? [])
    .map((f) => `<p>${escapeHtml(f.label)}: <code>${escapeHtml(f.value)}</code></p>`)
    .join('\n');
  const notes = (layout.notes ?? []).map((n) => `<p>${escapeHtml(n)}</p>`).join('\n');
  const steps = layout.steps
    .map(
      (s) =>
        `<li>${stepText(s.text)}${s.command ? `\n<pre><code>${escapeHtml(s.command)}</code></pre>` : ''}</li>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Productivity HQ · ${escapeHtml(layout.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header><p>Agent Productivity HQ</p></header>
<main>
<h1>${escapeHtml(layout.headline)}</h1>
<p>${escapeHtml(layout.lead)}</p>
<p><strong>${NOTHING_CHANGED}</strong></p>
${notes}
${facts}
<h2>${escapeHtml(layout.stepsTitle)}</h2>
<ol>
${steps}
</ol>
</main>
</body>
</html>`;
}
