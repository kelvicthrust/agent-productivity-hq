import { Button } from '@astryxdesign/core/Button';
import { useId, useRef, useState, type FormEvent } from 'react';
import { StatusTag } from '../../../components/StatusTag';
import { Icon } from '../../../components/Icon';
import { GITHUB_COPY } from './copy';
import { fieldMessageOf, useSaveClientId } from './data';

// The App's client ID: a plain text field, because it is a setting and not a secret (the server stores it in app_meta and never
// takes a client secret; it refuses any other field). The server never sends the ID back, so after it is saved the field is
// empty again and a tag says one is saved; typing a new one replaces it. A save that fails keeps what was typed. Primary actions
// sit on the right, and "Save" is the secondary action of this block (the primary one is Connect, in the row above).

const INPUT =
  'h-11 min-w-0 flex-[1_1_240px] rounded-sm border border-control-border bg-surface px-3 font-mono text-[16px] text-ink placeholder:text-ink-muted min-[720px]:h-8 min-[720px]:text-copy aria-invalid:border-danger aria-invalid:shadow-[inset_0_0_0_1px_var(--color-danger)]';

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
      setProblem(GITHUB_COPY.clientId.empty);
      input.current?.focus();
      return;
    }
    setProblem(null);
    save.mutate(typed, {
      onSuccess: () => setValue(''),
      onError: (error) => {
        setProblem(fieldMessageOf(error, 'clientId', GITHUB_COPY.fallback));
        input.current?.focus();
      },
    });
  }

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <label htmlFor={`${ids}-input`} className="text-label font-semibold text-ink">
          {GITHUB_COPY.clientId.label}
        </label>
        {saved && <StatusTag kind="ok">{GITHUB_COPY.clientId.saved}</StatusTag>}
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
          placeholder={GITHUB_COPY.clientId.placeholder}
          value={value}
          aria-invalid={problem !== null || undefined}
          aria-describedby={`${ids}-${problem !== null ? 'problem' : 'hint'}`}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button
          type="submit"
          label={busy ? GITHUB_COPY.clientId.saving : GITHUB_COPY.clientId.save}
          variant="secondary"
          aria-busy={busy || undefined}
          aria-disabled={busy || undefined}
          className="ml-auto max-[719px]:min-h-11 aria-disabled:cursor-default aria-disabled:opacity-70"
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
          {GITHUB_COPY.clientId.hint}
        </p>
      )}
    </form>
  );
}
