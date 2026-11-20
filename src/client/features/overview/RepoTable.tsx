import { Link } from 'react-router';
import type { Provider, UsageCoverage } from '../../../shared/contracts/common';
import { PROVIDER_NAMES } from '../../../shared/domain/scope';
import { StatusTag } from '../../components/StatusTag';
import type { Overview } from '../../lib/analytics';
import { cx } from '../../lib/cx';
import { compact, int } from '../../lib/format';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { OVERVIEW_COPY } from './copy';

// By repository (ported from app.js `repoTable`): for each tracked repo its merged PRs, how many are linked, each provider's
// recorded tokens and its root sessions, then the usage-only groups (sessions whose repo is not tracked, or was never recorded).
//
// At 640px and wider this is a real table; below it, a list of cards drawn instead of it (TECH T5-2, the same decision as
// Delivery and the Usage tree): the prototype turned the table's own rows into cards by overriding `display`, which can drop
// table semantics for assistive technology. A card states each value once, under its label.
//
// D7 column policy, the same as Delivery and Usage: the repository column takes the spare width and every other cell never
// wraps, so a figure is never split. A window too narrow for the columns scrolls inside its own region, which a keyboard can
// reach. Providers are never added: each has its own column, and a figure that was not collected is said in words ("No
// records", "Unavailable"), never as a 0.

const COPY = OVERVIEW_COPY.repos;

/** Below this width the rows are cards. The same 640px as Delivery and Usage. */
const PHONE_QUERY = '(max-width: 639px)';

/** The edge cue (ported from app.css `.table-wrap`): a shadow on each side with more to scroll, drawn with background layers. */
const SCROLL_CUE = [
  'linear-gradient(to right, var(--color-surface), transparent) left center / 24px 100% no-repeat local',
  'linear-gradient(to left, var(--color-surface), transparent) right center / 24px 100% no-repeat local',
  'radial-gradient(farthest-side at 0 50%, var(--scroll-edge), transparent) left center / 10px 100% no-repeat scroll',
  'radial-gradient(farthest-side at 100% 50%, var(--scroll-edge), transparent) right center / 10px 100% no-repeat scroll',
].join(', ');

// Headers may wrap ("Claude Code tokens" over two lines) so the figures' columns stay as narrow as the figures; only data cells
// are held to one line.
const TH =
  'border-b border-border bg-surface px-2.5 py-2 text-caption font-semibold text-ink-muted';
const TD = 'border-b border-border px-2.5 py-2.5 align-top';
const NUM = 'whitespace-nowrap text-right tabular-nums';

// ---- what each row says ----------------------------------------------------------------------------------------------------

interface RowModel {
  key: string;
  /** The repo id, or the name of a usage-only group. */
  label: string;
  /** A usage-only group: no PR figures exist for it. */
  usageOnly: boolean;
  /** GitHub no longer grants this repo: its PR figures were not collected, its local usage is real. */
  inaccessible: boolean;
  merged: string;
  linked: string;
  tokens: Record<Provider, string>;
  roots: string;
}

/** A provider's cell where the API has no number: the coverage, in words. A null is never a 0. */
function missing(coverage: UsageCoverage | undefined): string {
  if (coverage === 'none') return COPY.noRecords;
  if (coverage === 'unavailable') return COPY.unavailable;
  return COPY.notCollected;
}

type ApiRow = Overview['repoRows'][number];
const isGroup = (row: ApiRow): boolean => row.group === 'untracked' || row.group === 'unknown';

/**
 * The order of the D7 prototype's table, which lists the repos it can read first and one GitHub no longer grants after them: here
 * the readable tracked repos with the most merged PRs first (a tie by name), then a repo GitHub no longer grants, then the
 * usage-only groups in the order the API sends them. The API's own order is by repo name, which put the lost repo on top.
 */
function inReviewOrder(rows: Overview['repoRows']): ApiRow[] {
  const lost = (row: ApiRow): boolean => row.accessState === 'inaccessible';
  const tracked = rows
    .filter((row) => !isGroup(row))
    .sort(
      (a, b) =>
        Number(lost(a)) - Number(lost(b)) ||
        (b.mergedPrs ?? 0) - (a.mergedPrs ?? 0) ||
        (a.repo ?? '').localeCompare(b.repo ?? ''),
    );
  return [...tracked, ...rows.filter(isGroup)];
}

function modelRows(
  rows: Overview['repoRows'],
  coverage: Partial<Record<Provider, UsageCoverage>>,
): RowModel[] {
  return inReviewOrder(rows).map((row, index) => {
    const usageOnly = row.group === 'untracked' || row.group === 'unknown';
    const tokenText = (provider: Provider): string => {
      const value = row.tokens?.[provider];
      return value == null ? missing(coverage[provider]) : compact(value);
    };
    return {
      key: row.repo ?? `${row.group ?? 'group'}-${index}`,
      label: usageOnly
        ? row.group === 'untracked'
          ? COPY.untracked
          : COPY.unknown
        : (row.repo ?? '—'),
      usageOnly,
      inaccessible: row.accessState === 'inaccessible',
      merged: usageOnly
        ? COPY.notApplicable
        : row.mergedPrs == null
          ? COPY.notCollected
          : int(row.mergedPrs),
      linked: usageOnly
        ? COPY.notApplicable
        : row.linkedPrs == null
          ? COPY.notCollected
          : int(row.linkedPrs),
      tokens: { codex: tokenText('codex'), claude: tokenText('claude') },
      roots: int(row.rootSessions ?? 0),
    };
  });
}

/** The row's name, with what is special about it: "(usage only)" for a group, a status and a way to fix it for a lost repo. */
function RowLabel({ row }: { row: RowModel }) {
  return (
    <>
      <span className="[overflow-wrap:anywhere]">{row.label}</span>
      {row.usageOnly && (
        <>
          {' '}
          <span className="text-caption text-ink-muted">{COPY.usageOnly}</span>
        </>
      )}
      {row.inaccessible && (
        <>
          {' '}
          <StatusTag kind="inaccessible">{COPY.inaccessible}</StatusTag>{' '}
          <Link to="/sources" className="text-caption">
            {COPY.fix}
          </Link>
        </>
      )}
    </>
  );
}

// ---- table and cards ------------------------------------------------------------------------------------------------------

function Table({ rows, providers }: { rows: readonly RowModel[]; providers: readonly Provider[] }) {
  return (
    // The card has 16px of padding; the scroller bleeds into it so the table can use the full width and its edge cue sits on
    // the card's border. A scrollable area a keyboard cannot focus fails WCAG 2.1.1 (axe `scrollable-region-focusable`), so it
    // is a labelled region with tabIndex 0; the lint rule allows tabIndex on a non-interactive element only for tabpanel.
    <div
      role="region"
      aria-label={COPY.scrollerLabel}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      className="-mx-4 overflow-x-auto px-4"
      style={{ background: SCROLL_CUE }}
    >
      <table className="w-full border-collapse text-data">
        <caption className="sr-only">{COPY.caption}</caption>
        <thead>
          <tr>
            <th scope="col" className={cx(TH, 'w-full min-w-44 text-left')}>
              {COPY.columns.repo}
            </th>
            <th scope="col" className={cx(TH, 'text-right')}>
              {COPY.columns.merged}
            </th>
            <th scope="col" className={cx(TH, 'text-right')}>
              {COPY.columns.linked}
            </th>
            {providers.map((provider) => (
              <th key={provider} scope="col" className={cx(TH, 'text-right')}>
                {COPY.columns.tokens(PROVIDER_NAMES[provider])}
              </th>
            ))}
            <th scope="col" className={cx(TH, 'text-right')}>
              {COPY.columns.roots}
            </th>
          </tr>
        </thead>
        <tbody className="[&>tr:last-child>td]:border-b-0">
          {rows.map((row) => {
            const tone = row.usageOnly ? 'bg-canvas text-ink-muted' : undefined;
            return (
              <tr key={row.key}>
                <th scope="row" className={cx(TD, 'text-left font-normal', tone)}>
                  <RowLabel row={row} />
                </th>
                <td className={cx(TD, NUM, tone)}>{row.merged}</td>
                <td className={cx(TD, NUM, tone)}>{row.linked}</td>
                {providers.map((provider) => (
                  <td key={provider} className={cx(TD, NUM, tone)}>
                    {row.tokens[provider]}
                  </td>
                ))}
                <td className={cx(TD, NUM, tone)}>{row.roots}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Pair({ label, children }: { label: string; children: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-caption text-ink-muted">{label}</dt>
      <dd className="m-0 text-right tabular-nums">{children}</dd>
    </div>
  );
}

function Cards({ rows, providers }: { rows: readonly RowModel[]; providers: readonly Provider[] }) {
  return (
    <ul aria-label={COPY.listLabel} className="m-0 flex list-none flex-col p-0">
      {rows.map((row) => (
        <li
          key={row.key}

          className={cx(
            'border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0',
            row.usageOnly && 'text-ink-muted',
          )}
        >
          <div className="text-data font-semibold">
            <RowLabel row={row} />
          </div>
          <dl className="m-0 mt-2 flex flex-col gap-1 text-data">
            <Pair label={COPY.columns.merged}>{row.merged}</Pair>
            <Pair label={COPY.columns.linked}>{row.linked}</Pair>
            {providers.map((provider) => (
              <Pair key={provider} label={COPY.columns.tokens(PROVIDER_NAMES[provider])}>
                {row.tokens[provider]}
              </Pair>
            ))}
            <Pair label={COPY.columns.roots}>{row.roots}</Pair>
          </dl>
        </li>
      ))}
    </ul>
  );
}

export function RepoTable({
  rows,
  providers,
  coverage,
  noRepos,
}: {
  rows: Overview['repoRows'];
  /** The providers in scope, in column order. */
  providers: readonly Provider[];
  /** Each provider's coverage for the period (`kpis.localTokens`): what a missing figure is said to be. */
  coverage: Partial<Record<Provider, UsageCoverage>>;
  /** No repository is tracked, so merged PRs do not exist yet. */
  noRepos: boolean;
}) {
  const phone = useMediaQuery(PHONE_QUERY);
  const model = modelRows(rows, coverage);
  return (
    <>
      {noRepos && <p className="text-caption text-ink-muted">{COPY.noRepos}</p>}
      {model.length === 0 ? (
        <p className="text-copy text-ink-muted">{COPY.empty}</p>
      ) : phone ? (
        <Cards rows={model} providers={providers} />
      ) : (
        <Table rows={model} providers={providers} />
      )}
    </>
  );
}
