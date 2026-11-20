import { Button } from '@astryxdesign/core/Button';
import { useEffect, useRef } from 'react';
import { Icon } from '../../../components/Icon';
import { GITHUB_COPY } from './copy';
import { WRAPPING_LABEL } from '../../../lib/wrapLabel';

// The device code, as the panel GitHub's own flow needs: the code in mono, the page to enter it on (the primary action, on the
// right, with Cancel on its left) and a line that says the dashboard is waiting. The server does the polling of GitHub; this page
// only asks the server how it is going. The panel is not in the D7 design (see AppGuide); it is built from the same parts.

export interface DeviceFlow {
  loginId: string;
  userCode: string;
  verificationUri: string;
  /** When the code stops working, already worded ("today, 9:57 AM"); null when the server did not say. */
  expires: string | null;
}

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
  // The Connect button this replaced took focus with it: land on the heading, so the code is what is read next.
  useEffect(() => heading.current?.focus(), []);
  // Only ever open what GitHub says is its own page.
  const href = flow.verificationUri.startsWith('https://github.com/') ? flow.verificationUri : null;

  return (
    <div
      role="group"
      aria-labelledby={`device-${flow.loginId}`}
      className="flex flex-col gap-3 rounded-md bg-sunken p-4"
    >
      <div className="flex flex-col gap-1">
        <h3
          ref={heading}
          id={`device-${flow.loginId}`}
          tabIndex={-1}
          className="text-label font-semibold text-ink"
        >
          {GITHUB_COPY.device.heading}
        </h3>
        <p className="text-caption text-ink-muted">{GITHUB_COPY.device.body}</p>
      </div>
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-caption text-ink-muted">{GITHUB_COPY.device.codeLabel}</span>
        <code className="select-all rounded-sm border border-border bg-surface px-3 py-1.5 font-mono text-[20px] font-semibold leading-7 tracking-[0.12em] text-ink">
          {flow.userCode}
        </code>
      </p>
      <p role="status" className="flex items-start gap-1.5 text-caption text-ink-muted">
        <Icon name="spinner" className="mt-px" />
        <span className="min-w-0">
          {GITHUB_COPY.device.waiting}
          {flow.expires && ` ${GITHUB_COPY.device.expires(flow.expires)}`}
        </span>
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          label={cancelling ? GITHUB_COPY.device.cancelling : GITHUB_COPY.device.cancel}
          size="sm"
          variant="secondary"
          aria-busy={cancelling || undefined}
          aria-disabled={cancelling || undefined}
          className="max-[719px]:min-h-11 aria-disabled:cursor-default aria-disabled:opacity-70"
          onClick={() => {
            if (!cancelling) onCancel();
          }}
        />
        {href && (
          <Button
            label={GITHUB_COPY.device.open}
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
