import { Button } from '@astryxdesign/core/Button';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Icon } from '../../components/Icon';
import { StatusTag } from '../../components/StatusTag';
import { SETUP_COPY } from './copy';
import { fieldMessageOf, useSaveClientId } from './data';
import { BUTTON } from './parts';
import { WRAPPING_LABEL } from '../../lib/wrapLabel';

// Setup's client-ID field and device-code panel, for the one-time GitHub App sign-in when `gh` is signed out.

const COPY = SETUP_COPY.accounts.github;

const INPUT =
  'h-11 min-w-0 flex-[1_1_240px] rounded-sm border border-control-border bg-surface px-3 font-mono text-[16px] text-ink placeholder:text-ink-muted min-[720px]:h-8 min-[720px]:text-copy aria-invalid:border-danger aria-invalid:shadow-[inset_0_0_0_1px_var(--color-danger)]';

/**
 * The App's client ID. The server never sends it back, so after a save the field is empty again and a tag says one is saved. A save
 * that fails keeps what was typed. "Save" is the secondary action here; the primary one is Connect, in the row above.
 */
export function ClientIdField({ saved }: { saved: boolean }) {
  const ids = useId();
  const input = useRef<HTMLInputElement>(null);
  const save = useSaveClientId();
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const busy = save.isPending;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const typed = value.trim();
    if (typed === '') {
      setProblem(COPY.clientId.empty);
      input.current?.focus();
      return;
    }
    setProblem(null);
    save.mutate(typed, {
      onSuccess: () => setValue(''),
      onError: (error) => {
        setProblem(fieldMessageOf(error, 'clientId', SETUP_COPY.fallback));
        input.current?.focus();
      },
    });
  }

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <label htmlFor={`${ids}-input`} className="text-label font-semibold text-ink">
          {COPY.clientId.label}
        </label>
        {saved && <StatusTag kind="ok">{COPY.clientId.saved}</StatusTag>}
      </div>
      <div className="flex flex-wrap items-start gap-2">
        <input
          ref={input}
          id={`${ids}-input`}
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={40}
          className={INPUT}
          placeholder={COPY.clientId.placeholder}
          value={value}
          aria-invalid={problem !== null || undefined}
          aria-describedby={`${ids}-${problem !== null ? 'problem' : 'hint'}`}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button
          type="submit"
          label={busy ? COPY.clientId.saving : COPY.clientId.save}
          variant="secondary"
          aria-busy={busy || undefined}
          aria-disabled={busy || undefined}
          className={`ml-auto ${BUTTON}`}
        />
      </div>
      {problem !== null ? (
        <p
          id={`${ids}-problem`}
          role="alert"
          className="flex items-start gap-1.5 text-caption text-danger"
        >
          <Icon name="error" className="mt-px" />
          <span className="min-w-0">{problem}</span>
        </p>
      ) : (
        <p id={`${ids}-hint`} className="text-caption text-ink-muted">
          {COPY.clientId.hint}
        </p>
      )}
    </form>
  );
}

export interface DeviceFlow {
  loginId: string;
  userCode: string;
  verificationUri: string;
  /** When the code stops working, already worded; null when the server did not say. */
  expires: string | null;
}

/** The device code in mono, the page to enter it on (the primary action, on the right, with Cancel on its left) and a line that says it is waiting. */
export function DeviceCodePanel({
  flow,
  cancelling,
  onCancel,
}: {
  flow: DeviceFlow;
  cancelling: boolean;
  onCancel: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  // The Connect button this replaced took the focus with it: land on the heading, so the code is what is read next.
  useEffect(() => heading.current?.focus(), []);
  // Only ever open what GitHub says is its own page.
  const href = flow.verificationUri.startsWith('https://github.com/') ? flow.verificationUri : null;
  return (
    <div
      role="group"
      aria-labelledby={`device-${flow.loginId}`}
      className="col-span-full flex flex-col gap-3 rounded-md bg-sunken p-4"
    >
      <div className="flex flex-col gap-1">
        <h3
          ref={heading}
          id={`device-${flow.loginId}`}
          tabIndex={-1}
          className="text-label font-semibold text-ink"
        >
          {COPY.device.heading}
        </h3>
        <p className="text-caption text-ink-muted">{COPY.device.body}</p>
      </div>
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-caption text-ink-muted">{COPY.device.codeLabel}</span>
        <code className="select-all rounded-sm border border-border bg-surface px-3 py-1.5 font-mono text-[20px] font-semibold leading-7 tracking-[0.12em] text-ink">
          {flow.userCode}
        </code>
      </p>
      <p role="status" className="flex items-start gap-1.5 text-caption text-ink-muted">
        <Icon name="spinner" className="mt-px" />
        <span className="min-w-0">
          {COPY.device.waiting}
          {flow.expires && ` ${COPY.device.expires(flow.expires)}`}
        </span>
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          label={cancelling ? SETUP_COPY.accounts.cancelling : SETUP_COPY.accounts.cancel}
          size="sm"
          variant="secondary"
          aria-busy={cancelling || undefined}
          aria-disabled={cancelling || undefined}
          className={BUTTON}
          onClick={() => {
            if (!cancelling) onCancel();
          }}
        />
        {href && (
          <Button
            label={COPY.device.open}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            icon={<Icon name="external" />}
            size="sm"
            variant="primary"
            className={WRAPPING_LABEL}
          />
        )}
      </div>
    </div>
  );
}
