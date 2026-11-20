import type { ReactNode } from 'react';
import { cx } from '../lib/cx';
import { Icon, type IconName } from './Icon';

// A status as an icon plus words (ported from ui.js STATUS and statusTag). The words carry the meaning and the icon shape
// repeats it, so the tag never depends on colour alone. Kinds are the prototype's; a screen maps its own API status to the
// nearest kind (for example Paseo's `needspassword` is "denied", its `notrunning` is "notfound").

export type StatusKind =
  | 'ok'
  | 'connected'
  | 'existing'
  | 'partial'
  | 'warn'
  | 'reconnect'
  | 'stale'
  | 'failed'
  | 'error'
  | 'denied'
  | 'inaccessible'
  | 'notfound'
  | 'none'
  | 'notconnected'
  | 'checking'
  | 'connecting'
  | 'info';

type Tone = 'ok' | 'warn' | 'error' | 'muted';

const APPEARANCE: Record<StatusKind, { icon: IconName; tone: Tone }> = {
  ok: { icon: 'check', tone: 'ok' },
  connected: { icon: 'check', tone: 'ok' },
  existing: { icon: 'check', tone: 'ok' },
  partial: { icon: 'alert', tone: 'warn' },
  warn: { icon: 'alert', tone: 'warn' },
  reconnect: { icon: 'alert', tone: 'warn' },
  stale: { icon: 'clock', tone: 'warn' },
  failed: { icon: 'error', tone: 'error' },
  error: { icon: 'error', tone: 'error' },
  denied: { icon: 'lock', tone: 'error' },
  inaccessible: { icon: 'lock', tone: 'error' },
  notfound: { icon: 'none', tone: 'muted' },
  none: { icon: 'none', tone: 'muted' },
  notconnected: { icon: 'none', tone: 'muted' },
  checking: { icon: 'spinner', tone: 'muted' },
  connecting: { icon: 'spinner', tone: 'muted' },
  info: { icon: 'info', tone: 'muted' },
};

const TONE_CLASS: Record<Tone, string> = {
  ok: 'text-success',
  warn: 'text-warning',
  error: 'text-danger',
  muted: 'text-ink-muted',
};

/** The icon and the text colour for a status kind, for parts that draw their own layout (the coverage strip). */
export function statusAppearance(kind: StatusKind): { icon: IconName; toneClass: string } {
  const { icon, tone } = APPEARANCE[kind];
  return { icon, toneClass: TONE_CLASS[tone] };
}

export function StatusTag({
  kind,
  children,
  className,
}: {
  kind: StatusKind;
  /** The words: "Found", "Refresh failed", "Looking…". Required, because they carry the status. */
  children: ReactNode;
  className?: string;
}) {
  const { icon, toneClass } = statusAppearance(kind);
  return (
    <span
      className={cx(
        'inline-flex items-center gap-[5px] whitespace-nowrap text-caption font-semibold',
        toneClass,
        className,
      )}
    >
      <Icon name={icon} />
      <span>{children}</span>
    </span>
  );
}
