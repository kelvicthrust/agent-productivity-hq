import { Button } from '@astryxdesign/core/Button';

export function RouteLoading() {
  return (
    <p role="status" className="py-3 text-copy text-ink-muted">
      Loading page…
    </p>
  );
}

export function RouteLoadError() {
  return (
    <section className="flex flex-col items-start gap-3" aria-labelledby="route-error-title">
      <h1 id="route-error-title" tabIndex={-1} className="font-display text-title-page text-ink">
        This page couldn’t load
      </h1>
      <p className="text-copy text-ink-muted">Reload to get the current version of this page.</p>
      <Button label="Reload page" variant="secondary" onClick={() => window.location.reload()}>
        Reload page
      </Button>
    </section>
  );
}
