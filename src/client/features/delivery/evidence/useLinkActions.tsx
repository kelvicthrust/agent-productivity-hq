import { Button } from '@astryxdesign/core/Button';
import { useToast } from '@astryxdesign/core/Toast';
import { useRef, useState } from 'react';
import { focusRowToggle } from '../../../components/DeliveryTable';
import {
  LINK_SAVE_FAILED,
  STATE_AFTER,
  priorStateOf,
  useLinkChange,
  type EvidenceItem,
  type LinkAction,
  type LinkState,
} from '../../../lib/links';
import { EVIDENCE_COPY } from './copy';

// What happens when the owner changes a link (journey J4): ask the server, and only when it says yes change anything on screen.
//
//   success   the answer has already refreshed every number that reads links (`useLinkChange` invalidates `analytics` and waits
//             for it), so the toast comes with the list already right. It carries an Undo that puts the pair back in the state
//             it was in (`priorStateOf`), and focus goes to the PR's row toggle: the button that was pressed may be gone by now
//             (a dismissed suggestion leaves the list), and a keyboard reader must not be dropped at the top of the page.
//   failure   nothing was written and nothing on screen moved (G8_7: no optimistic persistence). The toast says so, and focus
//             stays on the button that was pressed, which is still there, so the owner can press it again.
//
// One change at a time per panel: while one is on its way the panel's buttons are inert (`aria-disabled`, not `disabled`, so
// focus is not lost with the button).
//
// The calls use `mutateAsync` and not the per-call callbacks of `mutate`: those never run once the component that asked has been
// unmounted, and a change can unmount its own panel (a PR that no longer belongs to the tab it was listed under).

/** One toast at a time, as the design has it: a newer change replaces the Undo of an older one. */
const TOAST_ID = 'delivery-link-change';
/** The toast with an Undo stays 8 seconds, one without 5 (design-to-code, "Toast with Undo"). */
const UNDO_MS = 8000;

/**
 * Focus after a change or its Undo: the PR's row toggle. A change can also take the PR out of the list it was shown in (Confirm on
 * the "Suggested only" tab moves it to Owner-confirmed), and then the toggle goes with the refreshed list; focus is checked again
 * once that has been drawn and, if it fell to the page, goes to the page heading, where a keyboard reader would start again.
 */
function returnFocus(prId: string): void {
  focusRowToggle(prId);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const lost = document.activeElement === null || document.activeElement === document.body;
      if (lost) document.getElementById('page-title')?.focus();
    }),
  );
}

export interface LinkActions {
  /** The change on its way: which session and which action, or null. */
  pending: { sessionId: number; action: LinkAction } | null;
  /** Applies `action` to `sessionId`; `item` is what the owner acted on, none for a session offered from the candidates. */
  perform: (action: LinkAction, sessionId: number, item?: EvidenceItem) => Promise<boolean>;
}

export function useLinkActions(prId: string): LinkActions {
  const toast = useToast();
  const change = useLinkChange();
  const [pending, setPending] = useState<LinkActions['pending']>(null);
  const busy = useRef(false);

  const failed = () =>
    toast({ body: LINK_SAVE_FAILED, type: 'error', isAutoHide: true, uniqueID: TOAST_ID });

  /** The one request that puts the pair in `state`; false when it did not save (and the owner has been told). */
  async function save(sessionId: number, state: LinkState): Promise<boolean> {
    try {
      await change.mutateAsync({ prId, sessionId, state });
      return true;
    } catch {
      failed();
      return false;
    }
  }

  async function undo(sessionId: number, prior: LinkState) {
    const saved = await save(sessionId, prior);
    if (saved) toast({ body: EVIDENCE_COPY.undone, isAutoHide: true, uniqueID: TOAST_ID });
    // The toast and its Undo button are gone either way, so focus has nowhere of its own to be.
    returnFocus(prId);
  }

  async function perform(action: LinkAction, sessionId: number, item?: EvidenceItem) {
    if (busy.current) return false;
    busy.current = true;
    setPending({ sessionId, action });
    const prior = priorStateOf(item);
    const saved = await save(sessionId, STATE_AFTER[action]);
    busy.current = false;
    setPending(null);
    if (!saved) return false;

    const dismiss = toast({
      body: EVIDENCE_COPY.toast[action],
      isAutoHide: true,
      autoHideDuration: UNDO_MS,
      uniqueID: TOAST_ID,
      endContent: (
        <Button
          label={EVIDENCE_COPY.undo}
          size="sm"
          variant="ghost"
          className="max-[719px]:min-h-11"
          onClick={() => {
            dismiss();
            void undo(sessionId, prior);
          }}
        />
      ),
    });
    returnFocus(prId);
    return true;
  }

  return { pending, perform };
}
