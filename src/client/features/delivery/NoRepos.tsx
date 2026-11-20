import { Button } from '@astryxdesign/core/Button';
import type { ComponentProps } from 'react';
import { Link } from 'react-router';
import { CrewArt } from '../../components/CrewArt';
import { EMPTY_REPOS } from '../../lib/copy';

/** React Router's Link under the `href` name Astryx's Button passes to a custom link component. */
function RouterLink({ href, ...rest }: Omit<ComponentProps<typeof Link>, 'to'> & { href: string }) {
  return <Link to={href} {...rest} />;
}

/**
 * The page when no repository is tracked (ported from app.js `emptyRepos`): merged PRs come only from tracked repos, so there is
 * no table to show. The way forward is adding one, in Sources & repos.
 */
export function NoRepos() {
  return (
    <section
      aria-labelledby="dl-empty-title"
      className="flex flex-col items-start gap-2 rounded-md border border-dashed border-border-strong bg-surface p-6"
    >
      <CrewArt mood="search" />
      <h2 id="dl-empty-title" className="font-display text-title-section text-ink">
        {EMPTY_REPOS.heading}
      </h2>
      <p className="max-w-[60ch] text-copy text-ink-muted">{EMPTY_REPOS.body}</p>
      <Button
        label={EMPTY_REPOS.action}
        href="/sources"
        as={RouterLink}
        size="sm"
        variant="primary"
        className="max-[719px]:min-h-11"
      />
    </section>
  );
}
