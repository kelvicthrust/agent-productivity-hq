import { AppBar } from './AppBar';
import { RouteLoadError, RouteLoading } from './RouteState';

export function PaseoBrowserStatus({
  state,
  focusHeading = false,
}: {
  state: 'loading' | 'reopen' | 'setup' | 'error';
  focusHeading?: boolean;
}) {
  const setup = state === 'setup';
  return (
    <div className="min-h-dvh bg-canvas">
      <AppBar setup />
      <main className="mx-auto max-w-[44.5rem] px-4 pt-4 pb-12 min-[720px]:px-6 min-[720px]:pt-6">
        {state === 'loading' ? (
          <RouteLoading />
        ) : state === 'error' ? (
          <RouteLoadError />
        ) : (
          <>
            <h1
              className="font-display text-title-page text-ink"
              tabIndex={-1}
              ref={focusHeading ? (heading) => heading?.focus() : undefined}
            >
              {setup ? 'Finish setup in Paseo' : 'Reopen from Paseo'}
            </h1>
            <p className="mt-2 text-copy text-ink-muted">
              {setup
                ? 'Finish setting up Agent Productivity HQ in Paseo, then open it in your browser again.'
                : 'Open Agent Productivity HQ in your browser from Paseo to start a new session.'}
            </p>
          </>
        )}
      </main>
    </div>
  );
}
