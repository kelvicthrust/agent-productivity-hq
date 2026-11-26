import { Switch } from '@astryxdesign/core/Switch';
import { ClaudeHooksSwitch } from '../../components/ClaudeHooksSwitch';
import { ApiRequestError } from '../../lib/api';
import {
  useClaudeBackgroundWorkStatus,
  useClaudeBackgroundWorkSwitch,
  useExactPrompts,
} from '../../lib/hq';
import { HOOKS_COPY } from '../../lib/hooksCopy';

// "Know when Claude Code needs you": the opt-in switch that has Claude Code tell HQ exactly when an agent needs the owner (data-and-sources
// › Claude Code hooks). It is the one place on this screen that changes something outside the app (entries in Claude Code's own
// settings), so it is a card of its own, after "On this machine", with the same preview-then-confirm control HQ's first-time dialog
// uses. The scope line says it touches only what HQ can show.

const HEADING_ID = 'src-hq-hooks-title';

function ClaudeBackgroundWorkSwitch() {
  const status = useClaudeBackgroundWorkStatus();
  const change = useClaudeBackgroundWorkSwitch();
  const copy = HOOKS_COPY.backgroundWork;
  const enabled = status.data?.enabled ?? false;
  const problem = change.isError
    ? change.error instanceof ApiRequestError
      ? change.error.message || copy.changeFailed
      : copy.changeFailed
    : status.isError
      ? copy.readFailed
      : null;

  return (
    <div className="flex flex-col gap-1 border-t border-border pt-3">
      <Switch
        label={copy.label}
        description={copy.description}
        value={enabled}
        isDisabled={status.data === undefined || (!status.data.available && !enabled)}
        isLoading={status.isPending || change.isPending}
        onChange={(next) => change.mutate(next)}
      />
      {status.data !== undefined && !status.data.available && (
        <p className="text-caption text-ink-muted">{copy.prerequisite}</p>
      )}
      {problem !== null && (
        <p role="alert" className="text-caption text-danger">
          {problem}
        </p>
      )}
    </div>
  );
}

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
        <ClaudeHooksSwitch state={state.data} quickToggle />
      ) : state.isError ? (
        <p role="alert" className="text-copy text-danger">
          {HOOKS_COPY.stateFailed}
        </p>
      ) : (
        <p role="status" className="text-copy text-ink-muted">
          {HOOKS_COPY.stateLoading}
        </p>
      )}
      <ClaudeBackgroundWorkSwitch />
    </section>
  );
}
