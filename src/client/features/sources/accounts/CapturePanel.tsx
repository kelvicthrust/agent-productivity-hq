import { Button } from '@astryxdesign/core/Button';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from '../../../components/Icon';
import { captureErrorKind, useCapturePreview, type CaptureErrorKind } from '../../../lib/accounts';
import { ACCOUNTS_COPY } from './copy';
import { messageOf } from './data';
import { Alert, BUTTON } from './parts';

const COPY = ACCOUNTS_COPY.preview;

/** A refusal in words: the server's own sentence, and what the owner can do about it. */
export function refusalOf(
  error: unknown,
  fallback: string,
): { kind: CaptureErrorKind; message: string; hint: string | null } {
  const kind = captureErrorKind(error);
  return {
    kind,
    message: messageOf(error, fallback),
    hint: kind === 'other' ? null : COPY.refusal[kind],
  };
}

/** A `statusLine` object as the settings file spells it. */
function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <pre
      aria-label={label}
      className="m-0 rounded-sm border border-border bg-surface p-3 font-mono text-caption whitespace-pre-wrap text-ink [overflow-wrap:anywhere]"
    >
      {value === null ? COPY.none : JSON.stringify(value, null, 2)}
    </pre>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-caption font-semibold text-ink">{label}</dt>
      <dd className="m-0 min-w-0 text-caption text-ink-muted">{children}</dd>
    </div>
  );
}

export function CapturePanel({
  pending,
  refusal,
  onClose,
  onSubmit,
}: {
  pending: boolean;
  refusal: ReturnType<typeof refusalOf> | null;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const preview = useCapturePreview();
  const data = preview.data;
  const previewRefusal = preview.isError ? refusalOf(preview.error, ACCOUNTS_COPY.fallback) : null;
  const ready = !pending && !preview.isFetching;

  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className="col-span-full flex flex-col gap-3 rounded-md bg-sunken p-4"
    >
      <div className="flex flex-col gap-1">
        <h3
          ref={heading}
          id={headingId}
          tabIndex={-1}
          className="text-label font-semibold text-ink"
        >
          {COPY.heading}
        </h3>
        <p className="text-caption text-ink-muted">{COPY.intro}</p>
      </div>

      {previewRefusal ? (
        <>
          <Alert>{previewRefusal.message}</Alert>
          {previewRefusal.hint && (
            <p className="text-caption text-ink-muted">{previewRefusal.hint}</p>
          )}
        </>
      ) : data === undefined ? (
        <p role="status" className="flex items-center gap-1.5 text-caption text-ink-muted">
          <Icon name="spinner" />
          {COPY.loading}
        </p>
      ) : (
        <div aria-busy={preview.isFetching || undefined} className="flex flex-col gap-3">
          <dl className="m-0 flex flex-col gap-3">
            <Field label={COPY.file}>
              <code className="font-mono text-ink [overflow-wrap:anywhere]">
                {data.settingsPath}
              </code>
            </Field>
          </dl>
          {data.files.map((file) => (
            <div key={file.path} className="flex flex-col gap-3">
              <dl className="m-0 flex flex-col gap-3">
                {file.path !== data.settingsPath && (
                  <Field label={COPY.resolvedFile}>
                    <code className="font-mono text-ink [overflow-wrap:anywhere]">{file.path}</code>
                  </Field>
                )}
                <Field label={COPY.current}>
                  <Json label={COPY.current} value={file.current} />
                </Field>
                {file.hookReferenced && (
                  <Field label={COPY.restore}>
                    {file.next === null ? (
                      COPY.removeKey
                    ) : (
                      <Json label={COPY.restore} value={file.next} />
                    )}
                  </Field>
                )}
              </dl>
              {!file.hookReferenced && (
                <p className="text-caption text-ink-muted">{COPY.alreadyRemoved}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {refusal !== null && refusal.message !== previewRefusal?.message && (
        <>
          <Alert>{refusal.message}</Alert>
          {refusal.hint && <p className="text-caption text-ink-muted">{refusal.hint}</p>}
        </>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          label={ACCOUNTS_COPY.claude.close}
          size="sm"
          variant="secondary"
          className={BUTTON}
          aria-disabled={pending || undefined}
          onClick={onClose}
        />
        {previewRefusal && (
          <Button
            label={COPY.retry}
            size="sm"
            variant="secondary"
            className={BUTTON}
            aria-disabled={pending || preview.isFetching || undefined}
            onClick={() => {
              if (!pending && !preview.isFetching) void preview.refetch();
            }}
          />
        )}
        <Button
          label={pending ? ACCOUNTS_COPY.claude.saving : COPY.button}
          size="sm"
          variant="primary"
          aria-busy={pending || undefined}
          aria-disabled={!ready || undefined}
          className={BUTTON}
          onClick={() => {
            if (ready) onSubmit();
          }}
        />
      </div>
    </div>
  );
}
