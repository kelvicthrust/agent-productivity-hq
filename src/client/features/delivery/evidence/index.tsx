import { Button } from '@astryxdesign/core/Button';
import type { PullRequest } from '../../../../shared/contracts/prs';
import { useBootstrap } from '../../../lib/bootstrap';
import { useEvidence, type EvidenceItem, type LinkAction } from '../../../lib/links';
import { EVIDENCE_COPY } from './copy';
import { EvidenceItemRow } from './EvidenceItemRow';
import { LinkSession } from './LinkSession';
import { useLinkActions } from './useLinkActions';

// What an opened PR shows (M8: G8_6; ported from app.js `prDetail`): each session linked to the PR with the basis for it and the
// actions the server allows, "Link a session" for the sessions it offers, and the note about what a link means. The route
// finds this file at build time and gives it the PR.
//
// State ownership: the evidence and the candidates are the server's (`useEvidence`, which asks only once a row is open, because
// this panel exists only while it is); the only state the panel keeps is the "Link a session" form (LinkSession.tsx) and which
// change is on its way (`useLinkActions`). A change is judged by the server and shown only after it answers: nothing here is
// optimistic. The order is the server's: evidence, owner, suggested, then marked incorrect.

export function EvidencePanel({ pr }: { pr: PullRequest }) {
  const detail = useEvidence(pr.id);
  const timeZone = useBootstrap().data?.timezone;
  const { pending, perform } = useLinkActions(pr.id);
  const copy = EVIDENCE_COPY;

  if (detail.isError && detail.data === undefined) {
    return (
      <p role="alert" className="flex flex-wrap items-center gap-x-2 text-copy text-danger">
        {copy.loadFailed}
        <Button
          label={copy.retry}
          size="sm"
          variant="ghost"
          className="max-[719px]:min-h-11"
          onClick={() => void detail.refetch()}
        />
      </p>
    );
  }
  if (detail.data === undefined) {
    return (
      <p role="status" className="text-copy text-ink-muted">
        {copy.loading}
      </p>
    );
  }

  const items: readonly EvidenceItem[] = detail.data.evidence ?? [];
  const candidates = detail.data.candidates ?? [];
  const act = (item: EvidenceItem, action: Exclude<LinkAction, 'add'>) =>
    void perform(action, item.session.id, item);

  return (
    <div className="flex w-full flex-col gap-3" aria-busy={detail.isFetching || undefined}>
      <p className="text-caption text-ink-muted">{copy.footnote}</p>
      {items.length > 0 ? (
        <ul aria-label={`${copy.heading}: ${pr.title}`} className="flex flex-col gap-2">
          {items.map((item) => (
            <EvidenceItemRow
              key={item.session.id}
              item={item}
              timeZone={timeZone}
              pending={pending?.sessionId === item.session.id ? pending.action : null}
              onAct={(action) => act(item, action)}
            />
          ))}
        </ul>
      ) : (
        <p className="text-copy text-ink-muted">
          {!pr.authoredByMe && pr.author !== null
            ? copy.empty.byOther(pr.author)
            : copy.empty.none(candidates.length > 0)}
        </p>
      )}
      <LinkSession
        repo={pr.repo}
        candidates={candidates}
        timeZone={timeZone}
        adding={pending?.action === 'add'}
        onAdd={(sessionId) => perform('add', sessionId)}
      />
    </div>
  );
}
