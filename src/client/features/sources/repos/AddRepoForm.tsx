import { Button } from '@astryxdesign/core/Button';
import { useToast } from '@astryxdesign/core/Toast';
import { useId, useState, type FormEvent, type RefObject } from 'react';
import { Icon } from '../../../components/Icon';
import { SOURCES_COPY } from '../../../lib/copy';
import { REPO_COPY } from './copy';
import { problemOf, useAddRepo, type Problem } from '../../../lib/repos';
import { ProblemLine } from './ProblemLine';

// "Add a GitHub repository". What was typed stays in the field when the add fails (P-16): only a success clears it. The error
// stays under the field, named by aria-describedby, and focus goes back to the field so the next try starts where the last
// ended. The primary action is on the right of the field; while the server asks GitHub it says "Checking access…" and ignores
// a second press, but stays focusable (aria-disabled, not `disabled`), as the refresh buttons do.

const INPUT =
  'h-11 min-w-0 flex-[1_1_260px] rounded-sm border border-control-border bg-surface px-3 text-[16px] text-ink placeholder:text-ink-muted min-[720px]:h-8 min-[720px]:text-copy aria-invalid:border-danger aria-invalid:shadow-[inset_0_0_0_1px_var(--color-danger)]';

export function AddRepoForm({
  inputRef,
  onNeedsGithub,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  onNeedsGithub: () => void;
}) {
  const ids = useId();
  const toast = useToast();
  const add = useAddRepo();
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const busy = add.isPending;
  const copy = SOURCES_COPY.repos;

  function fail(next: Problem) {
    setProblem(next);
    inputRef.current?.focus();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const typed = value.trim();
    if (typed === '') return fail({ message: copy.error.empty });
    setProblem(null);
    add.mutate(typed, {
      onSuccess: (repo) => {
        setValue('');
        toast({
          body: repo.reactivated
            ? copy.toast.trackingAgain(repo.displayName)
            : copy.toast.tracking(repo.displayName, true),
        });
        inputRef.current?.focus();
      },
      onError: (error) => fail(problemOf(error, REPO_COPY.fallback)),
    });
  }

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-1.5">
      <label htmlFor={`${ids}-input`} className="text-label font-semibold text-ink">
        {copy.fieldLabel}
      </label>
      <div className="flex flex-wrap items-start gap-2">
        <input
          ref={inputRef}
          id={`${ids}-input`}
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          className={INPUT}
          placeholder={copy.placeholder}
          value={value}
          aria-invalid={problem !== null || undefined}
          aria-describedby={problem !== null ? `${ids}-problem` : `${ids}-hint`}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button
          type="submit"
          label={busy ? copy.adding : copy.add}
          icon={<Icon name={busy ? 'spinner' : 'plus'} />}
          variant="primary"
          aria-busy={busy || undefined}
          aria-disabled={busy || undefined}
          className="max-[719px]:min-h-11 aria-disabled:cursor-default aria-disabled:opacity-70"
        />
      </div>
      {problem !== null ? (
        <ProblemLine id={`${ids}-problem`} problem={problem} onNeedsGithub={onNeedsGithub} />
      ) : (
        <p id={`${ids}-hint`} className="text-caption text-ink-muted">
          {copy.hint}
        </p>
      )}
    </form>
  );
}
