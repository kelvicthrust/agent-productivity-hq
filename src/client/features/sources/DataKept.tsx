import { SOURCES_COPY } from '../../lib/copy';

// "Data kept on this machine" (D7; requirements P-29 to P-31) states how
// long usage history is kept, what is never stored, and which reads leave the machine. The sentence is the product's promise, so it
// is held to the code by tests elsewhere (the retention horizon, the no-conversation-bodies scan and the single outbound module).

export function DataKept() {
  const copy = SOURCES_COPY.dataKept;
  return (
    <section
      aria-labelledby="src-data-title"
      className="flex min-w-0 flex-col gap-2 rounded-md border border-border bg-surface p-4 shadow-card"
    >
      <div className="min-w-0">
        <h2 id="src-data-title" className="font-display text-title-section text-ink">
          {copy.title}
        </h2>
        <p className="mt-0.5 text-caption text-ink-muted">{copy.scope}</p>
      </div>
      <p className="max-w-[75ch] text-copy text-ink">{copy.body}</p>
    </section>
  );
}
