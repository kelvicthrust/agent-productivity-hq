import { Button } from '@astryxdesign/core/Button';
import type { ComponentProps } from 'react';
import { Link } from 'react-router';
import { CrewArt } from '../../components/CrewArt';
import { USAGE_COPY } from './copy';

/** React Router's Link under the `href` name Astryx's Button passes to a custom link component. */
function RouterLink({ href, ...rest }: Omit<ComponentProps<typeof Link>, 'to'> & { href: string }) {
  return <Link to={href} {...rest} />;
}

/**
 * The page when this machine has no Codex, Claude Code or Paseo records at all (ported from app.js `pageUsage`). There is
 * no session detail to show, so there are no ledgers and no tree: the way forward is the account totals on Overview, or
 * checking the sources. The primary action is on the right.
 */
export function NoRecords() {
  const copy = USAGE_COPY.noRecords;
  return (
    <section
      aria-labelledby="us-empty-title"
      className="flex flex-col items-start gap-2 rounded-md border border-dashed border-border-strong bg-surface p-6"
    >
      <CrewArt mood="search" />
      <h2 id="us-empty-title" className="font-display text-title-section text-ink">
        {copy.heading}
      </h2>
      <p className="max-w-[60ch] text-copy text-ink-muted">{copy.body}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          label={copy.accounts}
          href="/"
          as={RouterLink}
          size="sm"
          variant="secondary"
          className="max-[719px]:min-h-11"
        />
        <Button
          label={copy.sources}
          href="/sources"
          as={RouterLink}
          size="sm"
          variant="primary"
          className="max-[719px]:min-h-11"
        />
      </div>
    </section>
  );
}
