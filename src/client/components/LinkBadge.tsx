import { LINK_LABELS } from '../lib/copy';
import { cx } from '../lib/cx';
import { Icon, type IconName } from './Icon';

// The link-basis badge Delivery and the Usage tree share (ported from ui.js LINKS and linkBadge). The fill style encodes
// the class and the label says it in words, so neither colour nor shape is the only signal: a soft selection-coloured fill
// is an evidence link, an outline is owner-confirmed, a dashed outline is a suggestion, a quiet fill is unlinked, a struck-through
// label is marked incorrect.

export type LinkKind = keyof typeof LINK_LABELS;

// Each style names its own border colour: two border-colour utilities on one element are decided by the order of the
// generated stylesheet, not by the order they are written in, which is how the owner and suggested outlines went missing.
const BADGE: Record<LinkKind, { icon: IconName; style: string }> = {
  evidence: { icon: 'dotSolid', style: 'border-transparent bg-selection-surface text-action' },
  owner: { icon: 'check', style: 'bg-surface text-ink border-ink' },
  suggested: {
    icon: 'dotDashed',
    style: 'bg-surface text-ink-muted border-dashed border-control-border',
  },
  unlinked: { icon: 'dash', style: 'border-transparent bg-sunken text-ink-muted' },
  rejected: {
    icon: 'close',
    style: 'bg-surface text-ink-muted border-border-strong line-through',
  },
};

export function LinkBadge({ kind, className }: { kind: LinkKind; className?: string }) {
  const { icon, style } = BADGE[kind];
  return (
    <span
      className={cx(
        'inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-full border pl-[7px] pr-[9px] text-caption font-semibold',
        style,
        className,
      )}
    >
      <Icon name={icon} size={12} />
      {LINK_LABELS[kind]}
    </span>
  );
}
