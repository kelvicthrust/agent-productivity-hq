import { Button } from '@astryxdesign/core/Button';
import { Dialog } from '@astryxdesign/core/Dialog';
import { useRef, useState } from 'react';
import { ApiRequestError } from '../../lib/api';
import { SOURCES_COPY } from '../../lib/copy';
import { resetSetup } from '../../lib/setup';
import { clearShown, HQ_HOOKS_PROMPT_KEY } from '../../lib/shownOnce';

const copy = SOURCES_COPY.reset;
const BUTTON = 'max-[719px]:min-h-11 aria-disabled:cursor-default aria-disabled:opacity-70';

export function ResetApp() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);

  function close() {
    if (inFlight.current) return;
    setError(undefined);
    setOpen(false);
  }

  async function confirm() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await resetSetup();
    } catch (error) {
      setError(error instanceof ApiRequestError && error.message ? error.message : copy.failed);
      inFlight.current = false;
      setBusy(false);
      return;
    }
    clearShown(HQ_HOOKS_PROMPT_KEY);
    // A fresh document drops the query cache and reads the reset bootstrap.
    window.location.replace('/setup');
  }

  return (
    <section
      aria-labelledby="src-reset-title"
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-md border border-border bg-surface p-4 shadow-card"
    >
      <div className="min-w-0">
        <h2 id="src-reset-title" className="font-display text-title-section text-ink">
          {copy.title}
        </h2>
        <p className="mt-0.5 text-caption text-ink-muted">{copy.scope}</p>
      </div>
      <Button
        label={copy.open}
        size="sm"
        variant="destructive"
        className={BUTTON}
        onClick={(event) => {
          event.currentTarget.focus();
          setOpen(true);
        }}
      />
      <Dialog
        isOpen={open}
        onOpenChange={(next) => !next && close()}
        purpose="form"
        role="alertdialog"
        aria-labelledby="src-reset-confirm-title"
        aria-describedby="src-reset-confirm-description"
        width={480}
      >
        {open && (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <h2 id="src-reset-confirm-title" className="font-display text-title-section text-ink">
              {copy.confirmTitle}
            </h2>
            <div className="flex min-h-0 flex-col gap-2 overflow-y-auto text-copy">
              <div id="src-reset-confirm-description" className="flex flex-col gap-2 text-ink">
                <p>{copy.removes}</p>
                <p>{copy.keeps}</p>
              </div>
              {error && (
                <p role="alert" className="text-danger">
                  {error}
                </p>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap justify-end gap-2">
              <Button
                label={copy.cancel}
                size="sm"
                variant="secondary"
                className={BUTTON}
                aria-disabled={busy || undefined}
                onClick={close}
                data-autofocus
              />
              <Button
                label={busy ? copy.pending : copy.confirm}
                size="sm"
                variant="destructive"
                className={`${BUTTON} bg-danger text-on-action shadow-press hover:bg-danger-hover`}
                aria-busy={busy || undefined}
                aria-disabled={busy || undefined}
                onClick={confirm}
              />
            </div>
          </div>
        )}
      </Dialog>
    </section>
  );
}
