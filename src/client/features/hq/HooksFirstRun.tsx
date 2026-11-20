import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { useEffect, useState } from 'react';
import type { ExactPrompts } from '../../../shared/contracts/hq';
import { ClaudeHooksSwitch } from '../../components/ClaudeHooksSwitch';
import { HOOKS_COPY } from '../../lib/hooksCopy';
import { HQ_HOOKS_PROMPT_KEY, markShown, wasShown } from '../../lib/shownOnce';

// The first time the owner opens HQ on this browser with Claude Code's hooks switch off, the switch is offered once, in a dialog: the
// same control the Sources screen holds (a switch that changes Claude Code's settings is not something to find by accident, and not
// something to leave unasked about). Closing it by any way (the close button, Escape, "Not now", or after turning it on) records that it
// was shown, in `localStorage`, so it never opens by itself again; Sources is where it is found afterwards, and the dialog says so.
//
// It opens only on a roster that was read (`ready`: not loading, not failed, not in setup, with a feeder), and for `off` alone: `on`,
// `needs_repair` and `unavailable` have nothing to offer for the first time. The Astryx Dialog is the app's modal: it traps focus,
// closes on Escape, names itself from the title and returns focus on close.

const COPY = HOOKS_COPY;

export function HooksFirstRun({ state, ready }: { state: ExactPrompts; ready: boolean }) {
  const [open, setOpen] = useState(false);
  // Opened once in this visit, so a poll that finds the switch off again (or storage that will not keep the flag) cannot reopen it.
  const [asked, setAsked] = useState(false);
  if (!asked && ready && state === 'off' && !wasShown(HQ_HOOKS_PROMPT_KEY)) {
    setAsked(true);
    setOpen(true);
  }

  // Turning it on is an answer: the dialog stays to say so, and is not asked again.
  useEffect(() => {
    if (open && state !== 'off') markShown(HQ_HOOKS_PROMPT_KEY);
  }, [open, state]);

  const close = () => {
    markShown(HQ_HOOKS_PROMPT_KEY);
    setOpen(false);
  };

  if (!asked) return null;
  return (
    <Dialog isOpen={open} onOpenChange={(next) => !next && close()} width={560}>
      {open && (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <DialogHeader title={COPY.heading} onOpenChange={(next) => !next && close()} />
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
            <p className="max-w-[60ch] text-caption text-ink-muted">
              {COPY.scope} {COPY.firstTime.foundLater}
            </p>
            <ClaudeHooksSwitch state={state} />
          </div>
          <div className="flex shrink-0 justify-end">
            <Button
              label={state === 'off' ? COPY.firstTime.notNow : COPY.firstTime.done}
              size="sm"
              variant="secondary"
              className="max-[719px]:min-h-11"
              onClick={close}
            />
          </div>
        </div>
      )}
    </Dialog>
  );
}
