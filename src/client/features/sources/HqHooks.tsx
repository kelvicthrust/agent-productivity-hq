import { ClaudeHooksSwitch } from '../../components/ClaudeHooksSwitch';
import { useExactPrompts } from '../../lib/hq';
import { HOOKS_COPY } from '../../lib/hooksCopy';

// "Know when Claude Code needs you": the opt-in switch that has Claude Code tell HQ exactly when an agent needs the owner (data-and-sources
// › Claude Code hooks). It is the one place on this screen that changes something outside the app (entries in Claude Code's own
// settings), so it is a card of its own, after "On this machine", with the same preview-then-confirm control HQ's first-time dialog
// uses. The scope line says it touches only what HQ can show.

const HEADING_ID = 'src-hq-hooks-title';

export function HqHooks() {
  const state = useExactPrompts();
  return (
    <section
      aria-labelledby={HEADING_ID}
      className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4 shadow-card"
    >
      <div className="min-w-0">
        <h2 id={HEADING_ID} className="font-display text-title-section text-ink">
          {HOOKS_COPY.heading}
        </h2>
        <p className="mt-0.5 text-caption text-ink-muted">{HOOKS_COPY.scope}</p>
      </div>
      {state.data !== undefined ? (
        <ClaudeHooksSwitch state={state.data} />
      ) : state.isError ? (
        <p role="alert" className="text-copy text-danger">
          {HOOKS_COPY.stateFailed}
        </p>
      ) : (
        <p role="status" className="text-copy text-ink-muted">
          {HOOKS_COPY.stateLoading}
        </p>
      )}
    </section>
  );
}
