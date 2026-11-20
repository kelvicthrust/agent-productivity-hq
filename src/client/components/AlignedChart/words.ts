import type { Provider } from '../../../shared/contracts/common';
import type { Bucket } from '../../../shared/contracts/series';
import { PROVIDER_NAMES } from '../../lib/copy';
import { compact, int } from '../../lib/format';
import { CHART_COPY } from './copy';
import { deliveryOf, isUpcoming, providerTokens, providerUsage, railOf } from './model';

// The same facts a bucket draws, in words: the readout under the chart and the table equivalent. Both come from one reading of
// the bucket (model.ts), so the picture, the readout and the table cannot disagree. Ported from app.js `readout`, `covText`
// and `cellTok`. A provider is always named by its own line: nothing here adds two providers together.

export interface ReadoutFact {
  label: string;
  value: string;
}

export interface Readout {
  /** The bucket's own name ("Mon, Nov 2, 2026"). */
  title: string;
  /** Not started yet: the readout says so and has no facts. */
  upcoming: boolean;
  facts: ReadoutFact[];
}

export function readoutOf(bucket: Bucket, providers: readonly Provider[]): Readout {
  if (isUpcoming(bucket)) return { title: bucket.label, upcoming: true, facts: [] };
  const words = CHART_COPY.readout;
  const delivery = deliveryOf(bucket);
  const facts: ReadoutFact[] = [];

  let prs: string;
  switch (delivery.kind) {
    case 'none':
      prs = words.noTrackedRepos;
      break;
    case 'syncing':
      prs = delivery.prs ? words.prsSoFar(int(delivery.prs)) : words.syncing;
      break;
    case 'ok':
      prs = int(delivery.prs);
      break;
    default:
      prs = words.notAvailable;
  }
  facts.push({ label: words.prs, value: prs });

  for (const provider of providers) {
    const coverage = providerUsage(bucket, provider);
    const tokens = providerTokens(bucket, provider);
    let value: string;
    if (coverage === 'unavailable') value = words.historyUnavailable;
    else if (coverage === 'none') value = words.noLocalRecords;
    else if (coverage === 'future') value = words.upcomingUsage;
    else if (tokens === null) value = words.notAvailable;
    else {
      value = tokens === 0 ? words.zero : words.tokens(compact(tokens));
      if (coverage === 'partial') value += ` · ${words.partial}`;
      if (coverage === 'stale') value += ` · ${words.stale}`;
    }
    facts.push({ label: PROVIDER_NAMES[provider], value });
  }
  return { title: bucket.label, upcoming: false, facts };
}

/** The readout as one sentence for a screen reader: "Mon, Nov 2, 2026. Merged PRs: 3. Codex: 1.2M tokens." */
export function readoutText(readout: Readout): string {
  if (readout.upcoming) return `${readout.title}. ${CHART_COPY.readout.upcoming}.`;
  return [readout.title, ...readout.facts.map((fact) => `${fact.label}: ${fact.value}`)]
    .join('. ')
    .concat('.');
}

export interface TableRowWords {
  prs: string;
  tokens: Record<Provider, string>;
  coverage: string;
}

/** One table row's cells. A number is written; "—", "n/a", "Unavailable" and "No records" are never a zero. */
export function tableRowOf(bucket: Bucket, providers: readonly Provider[]): TableRowWords {
  const words = CHART_COPY.table;
  const delivery = deliveryOf(bucket);
  let prs: string;
  switch (delivery.kind) {
    case 'future':
      prs = words.upcoming;
      break;
    case 'none':
      prs = words.noTrackedRepos;
      break;
    case 'syncing':
      prs = delivery.prs ? words.prsSyncing(int(delivery.prs)) : words.syncing;
      break;
    case 'ok':
      prs = int(delivery.prs);
      break;
    default:
      prs = words.notAvailable;
  }

  const tokens = { codex: '', claude: '' } satisfies Record<Provider, string>;
  for (const provider of providers) {
    const coverage = providerUsage(bucket, provider);
    const count = providerTokens(bucket, provider);
    if (coverage === 'future') tokens[provider] = words.upcoming;
    else if (coverage === 'unavailable') tokens[provider] = words.unavailable;
    else if (coverage === 'none') tokens[provider] = words.noRecords;
    else if (count === null) tokens[provider] = words.notAvailable;
    else
      tokens[provider] = int(count) + (coverage === 'partial' || coverage === 'stale' ? ' *' : '');
  }
  return { prs, tokens, coverage: words.coverageWords[railOf(bucket, providers)] };
}
