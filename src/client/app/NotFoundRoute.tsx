import { Link } from 'react-router';

export function NotFoundRoute() {
  return (
    <section aria-labelledby="page-title" className="flex flex-col gap-4">
      <h1 id="page-title" tabIndex={-1} className="font-display text-title-page text-ink">
        Page not found
      </h1>
      <p className="text-ink-muted">
        There is no page at this address. <Link to="/">Back to Overview</Link>
      </p>
    </section>
  );
}
