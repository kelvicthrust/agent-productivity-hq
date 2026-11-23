import { Button } from '@astryxdesign/core/Button';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import type {
  ClaudeHooksAction,
  ClaudeHooksFileReason,
  ClaudeHooksPlan,
  ClaudeHooksStatus,
  ExactPrompts,
} from '../../shared/contracts/hq';
import { ApiRequestError } from '../lib/api';
import { useClaudeHooksPreview, useClaudeHooksSwitch } from '../lib/hq';
import { HOOKS_COPY } from '../lib/hooksCopy';
import { queryKeys } from '../lib/queryClient';
import { Icon } from './Icon';

// The switch that has Claude Code tell HQ exactly when an agent needs you (data-and-sources › Claude Code hooks). The control itself, with
// no heading or frame of its own: what it is for, what it is now, a "What will change" disclosure read from the server's preview, and
// the buttons. It lives on the Sources screen (a card with the heading) and, once, in the dialog HQ opens the first time (the dialog's
// title is the heading). Sources applies on and off with one press after checking a fresh plan.
// First-run and repair still ask the owner to review the action's plan. Every write carries its fingerprint.

const COPY = HOOKS_COPY;
/** A press target of 44px on a phone, and a busy button that keeps the focus (aria-disabled, not `disabled`). */
const BUTTON = 'max-[719px]:min-h-11 aria-disabled:cursor-default aria-disabled:opacity-70';

type Action = ClaudeHooksAction;

/** The action a state offers first: what "What will change" shows when no button has been pressed. */
const primaryOf = (state: ExactPrompts): Action | null =>
  state === 'off' ? 'on' : state === 'on' ? 'off' : state === 'needs_repair' ? 'repair' : null;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-caption font-semibold text-ink">{label}</dt>
      <dd className="m-0 min-w-0 text-caption text-ink-muted">{children}</dd>
    </div>
  );
}

const Code = ({ children }: { children: React.ReactNode }) => (
  <code className="font-mono text-ink [overflow-wrap:anywhere]">{children}</code>
);

function Preview({
  status,
  plan,
  action,
}: {
  status: ClaudeHooksStatus;
  plan: ClaudeHooksPlan | undefined;
  action: Action | null;
}) {
  const removing = action === 'off';
  // What the action writes: the plan's own files. With no action to confirm, the files as they are.
  const files = plan?.files ?? status.files;
  const own = plan?.ownFiles ?? [];
  return (
    <div className="flex flex-col gap-3">
      {removing && files.length > 0 && (
        <p className="text-caption text-ink-muted">{COPY.removes}</p>
      )}
      <dl className="m-0 flex flex-col gap-3">
        <Field label={removing ? COPY.removesFrom : COPY.files}>
          {files.length === 0 ? (
            removing && own.length > 0 ? (
              COPY.noEntries
            ) : (
              COPY.noFolder
            )
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {files.map((file) => (
                <li key={file.path} className="min-w-0">
                  <Code>{file.path}</Code>
                  {!file.exists && file.state !== 'blocked' && ` ${COPY.willCreate}`}
                  {file.state === 'blocked' &&
                    file.reason !== null &&
                    ` ${COPY.blocked[file.reason as ClaudeHooksFileReason]}`}
                </li>
              ))}
            </ul>
          )}
          {files.some((file) => file.state === 'blocked') && (
            <span className="mt-1 block">{COPY.blockedNote}</span>
          )}
        </Field>
        {own.length > 0 && (
          <Field
            label={removing ? COPY.ownRemoves(status.ownFolder) : COPY.ownWrites(status.ownFolder)}
          >
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {own.map((name) => (
                <li key={name} className="min-w-0">
                  <Code>{COPY.ownName[name]}</Code>
                </li>
              ))}
            </ul>
          </Field>
        )}
        <Field label={COPY.events}>
          {status.events.map((event, index) => (
            <span key={event}>
              {index > 0 && ', '}
              <Code>{event}</Code>
            </span>
          ))}
        </Field>
        {status.command !== '' && (
          <Field label={COPY.command}>
            <Code>{status.command}</Code>
          </Field>
        )}
        <Field label={COPY.receives}>{COPY.receivesBody}</Field>
      </dl>
      <p className="text-caption text-ink-muted">{COPY.backup}</p>
    </div>
  );
}

export function ClaudeHooksSwitch({
  state,
  quickToggle = false,
}: {
  state: ExactPrompts;
  quickToggle?: boolean;
}) {
  const regionId = useId();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [checking, setChecking] = useState<Action | null>(null);
  const checkingRef = useRef(false);
  const [checkProblem, setCheckProblem] = useState<string | null>(null);
  // The action whose plan is on screen: what the owner pressed, or the state's first action when they only opened the disclosure.
  const [reviewed, setReviewed] = useState<Action | null>(null);
  const preview = useClaudeHooksPreview(open);
  const change = useClaudeHooksSwitch();

  const primary = primaryOf(state);
  const busy = checking !== null || change.isPending;
  // A plan the owner can confirm: it is open on screen, it was read successfully and is not being read again, it describes the state
  // the page is in now (another tab or the app itself may have changed it since), and it is the plan of the action pressed.
  const shown = open && !preview.isError && !preview.isFetching ? preview.data : undefined;
  const current = shown !== undefined && shown.state === state ? shown : undefined;
  const onScreen = reviewed ?? primary;
  const planOnScreen = onScreen === null ? undefined : preview.data?.plans[onScreen];
  async function send(action: Action) {
    if (busy || checkingRef.current) return;
    const quick = quickToggle && (action === 'on' || (action === 'off' && state !== 'off'));
    setResult(null);
    setCheckProblem(null);
    let plan = reviewed === action ? current?.plans[action] : undefined;
    if (!quick && plan === undefined) {
      // Nothing is written by this press: it opens this action's plan, and reads it again if it was not this one or not good.
      setReviewed(action);
      setReviewing(true);
      if (open) void preview.refetch();
      else setOpen(true);
      return;
    }
    setReviewing(false);
    if (quick) {
      checkingRef.current = true;
      setChecking(action);
      change.reset();
    }
    try {
      if (quick) {
        const checked = await preview.refetch({ cancelRefetch: false });
        if (checked.isError) {
          setCheckProblem(COPY.checkFailed);
          return;
        }
        plan = checked.data?.state === state ? checked.data.plans[action] : undefined;
        if (!plan) {
          void client.invalidateQueries({ queryKey: queryKeys.hq });
          setCheckProblem(COPY.planChanged);
          return;
        }
      }
      if (!plan) return;
      await change.mutateAsync(
        { enabled: action !== 'off', preview: plan.preview },
        {
          onSuccess: (status) => {
            // The plan that was confirmed is spent: the next press, of any button, reads the plan of its own action first.
            setReviewed(null);
            setResult(
              action === 'off' && status.leftover !== null
                ? COPY.done.offLeftover(status.leftover.folder)
                : COPY.done[action],
            );
          },
          onError: () => {
            if (!quick) setOpen(true);
          },
        },
      );
    } catch {
      // The mutation exposes its refusal below.
    } finally {
      if (quick) {
        checkingRef.current = false;
        setChecking(null);
      }
    }
  }
  // Once the plans have been read, a state that offers no repair (the Node the hook would run is gone; a path HQ cannot quote) shows no
  // button for it: a press that can never be confirmed would only say "read what will change" again.
  const repairNotOffered =
    preview.data !== undefined &&
    preview.data.state === state &&
    preview.data.plans.repair === undefined;
  const pendingLabel = (checking ? checking === 'off' : change.variables?.enabled === false)
    ? COPY.turningOff
    : primary === 'repair'
      ? COPY.repairing
      : COPY.turningOn;
  const said = busy ? pendingLabel : (result ?? (reviewing ? COPY.reviewFirst : null));
  const reasonNote =
    preview.data !== undefined &&
    preview.data.state === state &&
    preview.data.reason !== null &&
    preview.data.reason !== 'no_claude_folder'
      ? COPY.reasonNote(preview.data.reason, preview.data.leftover?.folder)
      : null;
  const refusal =
    checkProblem ??
    (change.isError && change.error instanceof ApiRequestError && change.error.message !== ''
      ? change.error.message
      : change.isError
        ? COPY.failed
        : null);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <p className="max-w-[60ch] text-caption text-ink-muted">{COPY.intro}</p>
        <p className="max-w-[60ch] text-caption text-ink-muted">{COPY.summary}</p>
      </div>

      <p className="text-caption font-semibold text-ink">{COPY.status[state]}</p>
      {reasonNote !== null && <p className="text-caption text-ink-muted">{reasonNote}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          label={COPY.disclosure}
          size="sm"
          variant="secondary"
          className={BUTTON}
          aria-expanded={open}
          aria-controls={regionId}
          onClick={() => {
            setReviewing(false);
            // Opening it shows the state's first action's plan; closing it forgets which was on screen.
            setReviewed(open ? null : primary);
            setOpen((was) => !was);
          }}
        />
        {primary === 'on' && (
          <Button
            label={busy ? pendingLabel : COPY.turnOn}
            size="sm"
            variant="primary"
            className={BUTTON}
            aria-busy={busy || undefined}
            aria-disabled={busy || undefined}
            onClick={() => void send('on')}
          />
        )}
        {primary === 'repair' && !repairNotOffered && (
          <Button
            label={busy && change.variables?.enabled === true ? COPY.repairing : COPY.repair}
            size="sm"
            variant="primary"
            className={BUTTON}
            aria-busy={busy || undefined}
            aria-disabled={busy || undefined}
            onClick={() => void send('repair')}
          />
        )}
        {(primary === 'off' ||
          primary === 'repair' ||
          (state === 'off' && preview.data?.plans.off !== undefined)) && (
          <Button
            label={
              busy && (checking === 'off' || change.variables?.enabled === false)
                ? COPY.turningOff
                : state === 'off'
                  ? COPY.removeFiles
                  : COPY.turnOff
            }
            size="sm"
            variant="destructive"
            className={BUTTON}
            aria-busy={busy || undefined}
            aria-disabled={busy || undefined}
            onClick={() => void send('off')}
          />
        )}
      </div>

      <div id={regionId} hidden={!open} className="rounded-sm bg-sunken p-3">
        {open &&
          (preview.isError ? (
            <div className="flex flex-col items-start gap-2">
              <p className="flex items-start gap-1.5 text-caption text-danger">
                <Icon name="error" className="mt-px" />
                <span className="min-w-0">{COPY.readFailed}</span>
              </p>
              <Button
                label={COPY.retry}
                size="sm"
                variant="secondary"
                className={BUTTON}
                onClick={() => void preview.refetch()}
              />
            </div>
          ) : preview.data === undefined ? (
            <p role="status" className="flex items-center gap-1.5 text-caption text-ink-muted">
              <Icon name="spinner" />
              {COPY.loading}
            </p>
          ) : (
            <Preview status={preview.data} plan={planOnScreen} action={onScreen} />
          ))}
      </div>

      {/* Said politely once the owner has acted (the pending words, then the result); the roster's polling is never announced. */}
      {said !== null && (
        <p role="status" className="text-caption text-ink-muted">
          {said}
        </p>
      )}
      {refusal !== null && (
        <p role="alert" className="flex items-start gap-1.5 text-caption text-danger">
          <Icon name="error" className="mt-px" />
          <span className="min-w-0">
            {refusal} {COPY.failed}
          </span>
        </p>
      )}
    </div>
  );
}
