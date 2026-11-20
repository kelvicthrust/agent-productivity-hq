import { Button } from '@astryxdesign/core/Button';
import { Icon } from '../../components/Icon';
import { PROVIDER_NAMES } from '../../lib/copy';
import type { Discovery } from '../../lib/setup';
import { sourceRefreshFailed } from '../../lib/sourceStatus';
import { SETUP_COPY } from './copy';
import { Alert, BUTTON, Notice, StepCard } from './parts';
import { SetupSourceRow } from './SetupSourceRow';

// Step 1, "Finding agent records on this machine": one row for each local source, filled in from what discovery answered. Discovery only
// looks (it imports nothing and is never asked for a path), so the step says what it found and where, and what to do when it found
// nothing. Nothing is shown as found before the server answers: until then every row says "Looking…".

const ROWS = [
  { id: 'codex', name: PROVIDER_NAMES.codex },
  { id: 'claude', name: PROVIDER_NAMES.claude },
  { id: 'paseo', name: 'Paseo' },
] as const;

export function SourcesStep({
  answer,
  looking,
  failed,
  onLookAgain,
}: {
  /** The last answer, kept while the next look is in flight so rows that were found do not flicker. */
  answer: Discovery | null;
  looking: boolean;
  /** The look could not be made (the app could not be reached). */
  failed: boolean;
  onLookAgain: () => void;
}) {
  const copy = SETUP_COPY.sources;
  const answered = answer?.sources ?? [];
  // The server leaves out a source it did not look at (a process with no Paseo), so a row is drawn only for what it answered; before
  // any answer all three rows say "Looking…".
  const rows = answer === null ? ROWS : ROWS.filter((row) => answered.some((s) => s.id === row.id));
  const found = answered.filter((s) => s.status === 'ok' || s.status === 'partial').length;

  return (
    <StepCard id="setup-step-sources" title={copy.title} scope={copy.scope}>
      {failed && answer === null ? (
        <div className="flex flex-col items-start gap-2">
          <Alert>{copy.failed}</Alert>
          <Button
            label={copy.checkAgain}
            icon={<Icon name="refresh" />}
            size="sm"
            variant="secondary"
            aria-busy={looking || undefined}
            aria-disabled={looking || undefined}
            className={BUTTON}
            onClick={() => {
              if (!looking) onLookAgain();
            }}
          />
        </div>
      ) : (
        <ul className="flex flex-col">
          {rows.map((row) => {
            const entry = answered.find((s) => s.id === row.id);
            return (
              <SetupSourceRow
                key={row.id}
                id={row.id}
                name={row.name}
                status={entry?.status}
                refreshFailed={entry ? sourceRefreshFailed(entry) : false}
                location={entry?.location}
                looking={looking}
                onLookAgain={onLookAgain}
              />
            );
          })}
        </ul>
      )}
      {/* One live region for the whole look: "Looking for records…" turns into the summary, and that is what is announced. */}
      <div role="status">
        {answer === null ? (
          !failed && <p className="text-caption text-ink-muted">{copy.looking}</p>
        ) : looking ? (
          <p className="text-caption text-ink-muted">{copy.looking}</p>
        ) : found > 0 ? (
          <Notice tone="info">{copy.someFound(found, answered.length)}</Notice>
        ) : (
          <Notice tone="warn">{copy.noneFound}</Notice>
        )}
      </div>
    </StepCard>
  );
}
