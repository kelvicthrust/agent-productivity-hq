import { Button } from '@astryxdesign/core/Button';
import { useState } from 'react';
import type { SourceStatus } from '../../../shared/contracts/sources';
import { Buddy } from '../../components/Buddy';
import { Icon } from '../../components/Icon';
import { StatusTag } from '../../components/StatusTag';
import { cx } from '../../lib/cx';
import { discoveryTag } from '../../lib/setup';
import { SETUP_COPY } from './copy';
import { ACTIONS, BUTTON, ROW } from './parts';

// One local source in step 1 (design-to-code: `SetupSourceRow`): its name, what discovery found in the five words, where, and the
// button that looks again. `status` is undefined until the server has answered, which is "Looking…".
//
// The buddy pop (design-to-code › Motion mapping, 300ms, opacity and scale from .9, opacity only under reduced motion) is a plain
// mount transition: the awake buddy of a FOUND source is an element that mounts when the answer arrives, and `starting:` gives it
// the state it transitions from. React mounts it once, so the prototype's `takeEnter` flag is not needed. A row that opens already
// found (the owner came back to this step) draws the buddy without the transition: it is not news.
const POP =
  'transition-[opacity,scale] duration-(--dur-pop) ease-crew-out starting:opacity-0 motion-safe:starting:scale-90';

type Status = SourceStatus['status'];

const isFound = (status: Status | undefined): boolean => status === 'ok' || status === 'partial';

/** The sentence under the name: what was found and where, or what the owner can do about it. Never a path the owner is asked for. */
function detailFor(
  id: SourceStatus['id'],
  name: string,
  status: Status | undefined,
  location: string | null | undefined,
): string[] {
  const copy = SETUP_COPY.sources;
  switch (status) {
    case undefined:
    case 'checking':
      return [copy.checking];
    case 'ok':
    case 'partial': {
      const where = location
        ? [`${copy.location} ${location} · ${copy.foundAutomatically}`]
        : [copy.foundAutomatically];
      return status === 'partial' ? [...where, copy.partial] : where;
    }
    case 'denied':
      return [copy.denied(name)];
    case 'needspassword':
      return [copy.needsPassword];
    case 'notrunning':
      return [copy.notRunning];
    case 'failed':
      return [copy.checkFailed(name)];
    case 'notfound':
      return [id === 'paseo' ? copy.notRunning : copy.notFound(name)];
  }
}

export function SetupSourceRow({
  id,
  name,
  status,
  refreshFailed,
  location,
  onLookAgain,
  looking,
}: {
  id: 'codex' | 'claude' | 'paseo';
  name: string;
  status: Status | undefined;
  refreshFailed: boolean;
  location?: string | null | undefined;
  onLookAgain: () => void;
  /** A look is in flight: its button waits, and the words say so. */
  looking: boolean;
}) {
  const shown: Status | undefined = looking && !isFound(status) ? undefined : status;
  const found = isFound(shown);
  const tag = discoveryTag(shown, refreshFailed);
  // Whether the row opened already found. Only a source that BECOMES found while the owner watches gets the pop.
  const [openedFound] = useState(found);
  const detail = detailFor(id, name, shown, location);
  const retry = shown === 'denied' || shown === 'needspassword';

  return (
    <li className={ROW}>
      <div className="flex min-w-0 flex-col gap-1">
        <b className="inline-flex items-center gap-1.5 text-copy font-bold text-ink">
          {/* Paseo is enrichment, not a provider, so it gets an icon rather than a buddy. */}
          {id === 'paseo' ? (
            <Icon name="layers" />
          ) : found ? (
            <Buddy
              key="found"
              kind={id}
              mood="awake"
              size={18}
              className={cx(!openedFound && POP)}
            />
          ) : (
            <Buddy
              key="resting"
              kind={id}
              mood={shown === undefined ? 'awake' : 'sleep'}
              size={18}
            />
          )}
          {name}
        </b>
        {/* Polite: "Looking…" turning into the answer is announced where it happens. */}
        <span aria-live="polite">
          <StatusTag kind={tag.kind}>{tag.text}</StatusTag>
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-1 text-caption text-ink-muted">
        {detail.map((line) => (
          <span key={line} className="[overflow-wrap:anywhere]">
            {line}
          </span>
        ))}
      </div>
      <div className={ACTIONS}>
        {shown !== undefined && !found && (
          <Button
            label={retry ? SETUP_COPY.sources.retry : SETUP_COPY.sources.checkAgain}
            icon={<Icon name="refresh" />}
            size="sm"
            variant="secondary"
            aria-busy={looking || undefined}
            aria-disabled={looking || undefined}
            className={BUTTON}
            onClick={() => {
              if (!looking) onLookAgain();
            }}
          />
        )}
      </div>
    </li>
  );
}
