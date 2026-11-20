import { Button } from '@astryxdesign/core/Button';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { useEffect, useId, useRef, useState, type ComponentProps, type Ref } from 'react';
import { Link } from 'react-router';
import { deliveryScopeLabel, usageScopeLabel } from '../../../shared/domain/scope';
import { CrewArt } from '../../components/CrewArt';
import { Icon } from '../../components/Icon';
import { DEFAULT_RECORDS_LIMIT, useRecords, type Records } from '../../lib/analytics';
import { EMPTY_REPOS, PERIOD_NOT_HAPPENED } from '../../lib/copy';
import type { FilterContext, Filters } from '../../lib/filters';
import { bucketDrillUrl, type BucketRef } from '../../lib/recordsDrawer';
import { coverageNote, DRAWER_COPY, isMeasured } from './copy';
import { Note, PrList, Said, SessionList } from './RecordLists';

// What the drawer shows for one bucket: its heading and scope, the two record lists (merged PRs and sessions) and the ways on
// to Delivery and Usage. The records are the API's (GET /api/records for exactly this bucket, under the page's repo, provider
// and author filters); what an empty list MEANS comes from the response's `coverage`:
//
//   a covered zero     "No merged PRs in this period…, so this is a true zero"
//   history nobody has  the shared coverage phrase for that provider, never a 0 and never an empty list that reads as one
//   a period to come    PERIOD_NOT_HAPPENED
//
// Providers are never added together: a session shows its own tokens, and a count here is a count of records.

/** The API's largest page. "Show more" goes straight to it; past it the list says so and points at the full page. */
const MORE_LIMIT = 100;

const PROVIDERS = ['codex', 'claude'] as const;

type Tab = 'prs' | 'sessions';

/** React Router's Link under the `href` name Astryx's Button passes to a custom link component. */
function RouterLink({ href, ...rest }: Omit<ComponentProps<typeof Link>, 'to'> & { href: string }) {
  return <Link to={href} {...rest} />;
}

/**
 * A link styled as a button. A plain click goes through `onNavigate`, so the drawer can finish leaving before the page changes
 * (the page behind a modal drawer cannot take focus until the drawer lets go of it); a click with a modifier, or a middle
 * click, is left to the browser, so "open in a new tab" still works.
 */
function NavButton({
  href,
  label,
  variant,
  onNavigate,
}: {
  href: string;
  label: string;
  variant: 'primary' | 'secondary';
  onNavigate: (href: string) => void;
}) {
  return (
    <Button
      as={RouterLink}
      href={href}
      label={label}
      size="sm"
      variant={variant}
      className="max-[719px]:min-h-11"
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onNavigate(href);
      }}
    />
  );
}

/** The state when no repository is tracked: there are no merged PRs to list, and the way forward is to add one. */
function NoRepos({ onNavigate }: { onNavigate: (href: string) => void }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-md border border-dashed border-border-strong bg-surface p-4">
      <CrewArt mood="search" />
      <h3 className="font-display text-title-section text-ink">{EMPTY_REPOS.heading}</h3>
      <p className="text-copy text-ink-muted">{EMPTY_REPOS.body}</p>
      <NavButton
        href="/sources"
        label={EMPTY_REPOS.action}
        variant="primary"
        onNavigate={onNavigate}
      />
    </div>
  );
}

/** How far a list has got, and the one step more the API allows; at the end of that, where to go for the rest. */
function More({
  shown,
  total,
  limit,
  busy,
  capped,
  onMore,
}: {
  shown: number;
  total: number;
  limit: number;
  busy: boolean;
  capped: string;
  onMore: () => void;
}) {
  if (shown >= total) return null;
  if (limit >= MORE_LIMIT) return <p className="text-caption text-ink-muted">{capped}</p>;
  return (
    <div
      aria-busy={busy || undefined}
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2"
    >
      <span className="text-caption text-ink-muted">{DRAWER_COPY.progress(shown, total)}</span>
      <Button
        label={DRAWER_COPY.showMore}
        size="sm"
        variant="secondary"
        isLoading={busy}
        className="max-[719px]:min-h-11"
        onClick={onMore}
      />
    </div>
  );
}

function Skeleton() {
  return (
    <>
      <div aria-hidden="true" className="flex flex-col gap-3">
        {[0, 1, 2].map((row) => (
          <div key={row} className="h-12 animate-pulse rounded-sm bg-sunken" />
        ))}
      </div>
      <p role="status" className="sr-only">
        {DRAWER_COPY.loading}
      </p>
    </>
  );
}

export function RecordsPanel({
  bucket,
  filters,
  ctx,
  timeZone,
  onClose,
  onNavigate,
}: {
  bucket: BucketRef;
  filters: Filters;
  ctx: FilterContext;
  /** The report timezone, for the times in the lists (the response's own scope says the same once it lands). */
  timeZone: string;
  onClose: () => void;
  onNavigate: (href: string) => void;
}) {
  const titleId = useId();
  const [limit, setLimit] = useState(DEFAULT_RECORDS_LIMIT);
  const [chosen, setChosen] = useState<Tab | null>(null);
  const records = useRecords(filters, bucket, limit);
  const data: Records | undefined = records.data;

  // "Show more" removes the button that had focus, so focus waits for the longer list and then goes to it (without scrolling:
  // the reader stays where they were, with the new rows below).
  const listRef = useRef<HTMLUListElement>(null);
  const focusList = useRef(false);
  useEffect(() => {
    if (!focusList.current || !data || records.isPlaceholderData) return;
    focusList.current = false;
    listRef.current?.focus({ preventScroll: true });
  }, [data, records.isPlaceholderData]);

  const coverage = data?.coverage;
  const deliveryMeasured = coverage?.delivery === 'ok' || coverage?.delivery === 'syncing';
  const providers = PROVIDERS.filter((provider) => coverage?.[provider] !== undefined);
  const sessionsMeasured = providers.some((provider) => isMeasured(coverage?.[provider]));
  // A count nobody measured is a dash, not a 0.
  const prCount = data && deliveryMeasured ? (data.prTotal ?? 0) : null;
  const sessionCount = data && sessionsMeasured ? (data.sessionTotal ?? 0) : null;
  // PRs first when there are some; otherwise what the machine recorded.
  const tab: Tab = chosen ?? ((data?.prTotal ?? 0) > 0 ? 'prs' : 'sessions');
  const zone = data?.scope?.timezone ?? timeZone;

  const more = () => {
    focusList.current = true;
    setLimit(MORE_LIMIT);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 pt-5 pb-3">
        <div className="min-w-0">
          {/* Focus lands here when the drawer opens (Astryx moves it to [data-autofocus]); it names what the list is about. */}
          <h2
            id={titleId}
            tabIndex={-1}
            data-autofocus
            className="font-display text-[20px]/[30px] font-bold text-ink outline-none [overflow-wrap:anywhere]"
          >
            {bucket.label}
          </h2>
          <p className="mt-0.5 text-caption text-ink-muted">
            {DRAWER_COPY.scope(deliveryScopeLabel(filters), usageScopeLabel(filters))}
          </p>
        </div>
        <Button
          label={DRAWER_COPY.close}
          isIconOnly
          icon={<Icon name="close" />}
          variant="ghost"
          size="sm"
          className="shrink-0 max-[719px]:min-h-11 max-[719px]:min-w-11"
          onClick={onClose}
        />
      </header>

      {data && (
        <div className="shrink-0 px-5 pt-3">
          <SegmentedControl
            label={DRAWER_COPY.tabs.label}
            value={tab}
            onChange={(next) => {
              if (next === 'prs' || next === 'sessions') setChosen(next);
            }}
            className="max-w-full max-[719px]:flex-wrap"
          >
            <SegmentedControlItem
              value="prs"
              label={DRAWER_COPY.tab(DRAWER_COPY.tabs.prs, prCount)}
            />
            <SegmentedControlItem
              value="sessions"
              label={DRAWER_COPY.tab(DRAWER_COPY.tabs.sessions, sessionCount)}
            />
          </SegmentedControl>
        </div>
      )}

      <div
        aria-busy={records.isFetching || undefined}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-3"
      >
        {!data ? (
          records.isError ? (
            <p role="alert" className="flex flex-wrap items-center gap-x-2 text-copy text-danger">
              {DRAWER_COPY.loadFailed}
              <Button
                label={DRAWER_COPY.retry}
                size="sm"
                variant="ghost"
                className="max-[719px]:min-h-11"
                onClick={() => void records.refetch()}
              />
            </p>
          ) : (
            <Skeleton />
          )
        ) : (
          <>
            <p role="status" className="sr-only">
              {DRAWER_COPY.announce(prCount, sessionCount)}
            </p>
            {tab === 'prs' ? (
              <PrsView
                data={data}
                authoredByYou={filters.author === 'mine'}
                limit={limit}
                busy={records.isPlaceholderData}
                timeZone={zone}
                listRef={listRef}
                onMore={more}
                onNavigate={onNavigate}
              />
            ) : (
              <SessionsView
                data={data}
                limit={limit}
                busy={records.isPlaceholderData}
                timeZone={zone}
                listRef={listRef}
                onMore={more}
              />
            )}
          </>
        )}
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
        {/* Secondary on the left, primary on the right. The drill keeps every other filter and takes the bucket's dates. */}
        <NavButton
          href={bucketDrillUrl('usage', bucket, filters, ctx)}
          label={DRAWER_COPY.openInUsage}
          variant="secondary"
          onNavigate={onNavigate}
        />
        <NavButton
          href={bucketDrillUrl('delivery', bucket, filters, ctx)}
          label={DRAWER_COPY.openInDelivery}
          variant="primary"
          onNavigate={onNavigate}
        />
      </footer>
    </div>
  );
}

interface ViewProps {
  data: Records;
  limit: number;
  busy: boolean;
  timeZone: string;
  listRef: Ref<HTMLUListElement>;
  onMore: () => void;
}

function PrsView({
  data,
  authoredByYou,
  limit,
  busy,
  timeZone,
  listRef,
  onMore,
  onNavigate,
}: ViewProps & { authoredByYou: boolean; onNavigate: (href: string) => void }) {
  const delivery = data.coverage?.delivery;
  const prs = data.prs ?? [];
  if (delivery === 'future') return <Said>{PERIOD_NOT_HAPPENED}</Said>;
  if (delivery === 'none') return <NoRepos onNavigate={onNavigate} />;
  if (prs.length === 0) {
    return (
      <Said>
        {delivery === 'syncing' ? DRAWER_COPY.prs.syncingNone : DRAWER_COPY.prs.none(authoredByYou)}
      </Said>
    );
  }
  const total = data.prTotal ?? prs.length;
  return (
    <>
      {delivery === 'syncing' && <Note tone="info">{DRAWER_COPY.prs.syncing}</Note>}
      <PrList prs={prs} timeZone={timeZone} listRef={listRef} />
      <More
        shown={prs.length}
        total={total}
        limit={limit}
        busy={busy}
        capped={DRAWER_COPY.prs.capped(prs.length, total)}
        onMore={onMore}
      />
    </>
  );
}

function SessionsView({ data, limit, busy, timeZone, listRef, onMore }: ViewProps) {
  const coverage = data.coverage;
  const providers = PROVIDERS.filter((provider) => coverage?.[provider] !== undefined);
  // Every provider in scope is still to come: one sentence, not one per provider.
  if (providers.length > 0 && providers.every((provider) => coverage?.[provider] === 'future')) {
    return <Said>{PERIOD_NOT_HAPPENED}</Said>;
  }
  const notes = providers.flatMap((provider) => {
    const note = coverageNote(provider, coverage?.[provider]);
    return note ? [{ provider, ...note }] : [];
  });
  const sessions = data.sessions ?? [];
  const total = data.sessionTotal ?? sessions.length;
  return (
    <>
      {notes.map((note) => (
        <Note key={note.provider} tone={note.tone}>
          {note.text}
        </Note>
      ))}
      {sessions.length === 0 ? (
        // A zero is only claimed where some source was actually collecting; where none was, the notes above are the whole answer.
        providers.some((provider) => isMeasured(coverage?.[provider])) && (
          <Said>{DRAWER_COPY.sessions.none}</Said>
        )
      ) : (
        <>
          <SessionList sessions={sessions} timeZone={timeZone} listRef={listRef} />
          <More
            shown={sessions.length}
            total={total}
            limit={limit}
            busy={busy}
            capped={DRAWER_COPY.sessions.capped(sessions.length, total)}
            onMore={onMore}
          />
        </>
      )}
    </>
  );
}
