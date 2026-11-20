import {
  joinPaseoSessions,
  readPaseoCounts,
  upsertPaseoAgents,
  type PaseoJoinResult,
} from '../../db/queries/paseo.ts';
import { recordDiscovery } from '../../db/queries/sources.ts';
import type { AdapterContext, AdapterReport, SourceAdapter } from '../types.ts';
import { listAgents, type Listing, type PaseoClientLike } from './agents.ts';
import {
  connectFailure,
  isConnectionTrouble,
  listFailure,
  type ConnectionFailure,
} from './errors.ts';
import { DEFAULT_PASEO_URL, openPaseoClient, type PaseoOpen } from './open.ts';

export { DEFAULT_PASEO_URL, type PaseoOpen };
export type {
  PaseoClientLike,
  PaseoListEntry,
  PaseoListOptions,
  PaseoListResult,
} from './agents.ts';

// The Paseo adapter (data-and-sources › Paseo enrichment, G8_5). Paseo adds NO usage events: it names sessions Codex and Claude
// Code already counted and says which agent started which, so nothing it says can change a token total or be counted twice.
//
// One attempt:
//   1. open the SDK client and connect, with no password (the dashboard supports none, P-41);
//   2. `agents.list` with background agents included, and archived ones too (`filter.includeArchived`, which the SDK offers);
//   3. store the snapshot (`upsertPaseoAgents`);
//   4. join the stored agents to the stored sessions (`joinPaseoSessions`): the provider's own session id, `runtimeInfo.sessionId`,
//      is the only key. Titles, workspaces and parentage come from Paseo and from nowhere else.
// Step 4 runs on EVERY attempt, whatever happened to the daemon, because the join reads only what is stored: a daemon that is off
// or asks for a password still leaves the last snapshot enriching the tree.
//
// What the daemon can be, and what the source says (TECH › Discovery):
//   reachable          ok          `succeeded`
//   nothing listening  notrunning  `skipped` (a skip records no attempt, so this adapter writes the status itself)
//   asks for a password needspassword `skipped`, likewise. The password is never asked for, read or stored.
//   anything else      failed      `failed` with an `errorCode`
//
// Privacy: no title, folder, agent id or session id is logged or put in a message. Counts and codes only. An SDK error's own
// message is never kept, because the SDK writes agent ids into some of them.

/** Bumped when what is stored from a listing changes. */
export const ADAPTER_VERSION = 'paseo-agents/1';

export interface PaseoAdapterOptions {
  /** Where the daemon listens. Defaults to `ws://127.0.0.1:6767/ws`. */
  url?: string;
  /** Makes the client for one attempt. Defaults to the real SDK; tests pass a fake over the fixtures and open no socket. */
  open?: PaseoOpen;
}

export function createPaseoAdapter(options: PaseoAdapterOptions = {}): SourceAdapter {
  const url = options.url ?? DEFAULT_PASEO_URL;
  const open = options.open ?? openPaseoClient;
  return { id: 'paseo', refresh: (context) => refreshPaseo(context, url, open) };
}

// ---- what happened to the daemon ------------------------------------------------------------------------------------------

type Outcome = { kind: 'listed'; listing: Listing } | ConnectionFailure;

/**
 * The agents, archived ones too. If the daemon refuses the archived view (an older daemon, say) the live listing is read instead,
 * so enrichment does not stop; a daemon that is merely unreachable or silent is not asked a second time.
 */
async function readListing(client: PaseoClientLike, now: number): Promise<Listing> {
  try {
    return await listAgents(client, true, now);
  } catch (error) {
    if (isConnectionTrouble(error)) throw error;
    return await listAgents(client, false, now);
  }
}

async function attempt(context: AdapterContext, url: string, open: PaseoOpen): Promise<Outcome> {
  let client: PaseoClientLike | undefined;
  try {
    try {
      client = await open(url);
      await client.connect();
    } catch (error) {
      return connectFailure(error);
    }
    let listing: Listing;
    try {
      listing = await readListing(client, context.now());
    } catch (error) {
      return listFailure(error);
    }
    try {
      upsertPaseoAgents(context.db, listing.agents, context.now());
    } catch {
      return { kind: 'failed', code: 'store_failed' };
    }
    return { kind: 'listed', listing };
  } finally {
    try {
      await client?.close();
    } catch {
      // Closing a socket that is already gone says nothing worth keeping.
    }
  }
}

// ---- the attempt and its report ---------------------------------------------------------------------------------------------

/** Joins what is stored. Null when the join itself failed (logged by code only). */
function join(context: AdapterContext): PaseoJoinResult | null {
  try {
    return joinPaseoSessions(context.db);
  } catch {
    context.logger.error('paseo join failed', { source: 'paseo', code: 'join_failed' });
    return null;
  }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The tail of a "can't reach Paseo" sentence: says the last snapshot still applies, but only when there is one. */
function snapshotNote(context: AdapterContext): string {
  return readPaseoCounts(context.db).agents > 0
    ? ' Names and parents come from its last snapshot.'
    : '';
}

function failedReport(url: string, code: string): AdapterReport {
  const detail = 'Paseo’s agent list couldn’t be read. Anything already read stays. Retry.';
  return {
    result: 'failed',
    status: 'failed',
    location: url,
    errorCode: code,
    errorDetail: detail,
    message: detail,
  };
}

/** A daemon that is not there or asks for a password: the status goes on the source's row (a skip records no attempt). */
function stateReport(
  context: AdapterContext,
  url: string,
  status: 'notrunning' | 'needspassword',
): AdapterReport {
  let note: string;
  try {
    note = snapshotNote(context);
    recordDiscovery(context.db, { sourceId: 'paseo', status, location: url });
  } catch {
    context.logger.error('paseo state not recorded', { source: 'paseo', code: 'store_failed' });
    return failedReport(url, 'store_failed');
  }
  context.logger.debug('paseo not usable', { source: 'paseo', status });
  return {
    result: 'skipped',
    message:
      status === 'notrunning'
        ? `Paseo isn’t running on this machine.${note}`
        : `Paseo is asking for a password, which this dashboard doesn’t support.${note}`,
  };
}

async function refreshPaseo(
  context: AdapterContext,
  url: string,
  open: PaseoOpen,
): Promise<AdapterReport> {
  const outcome = await attempt(context, url, open);
  // Always, before anything is reported: the last snapshot still enriches the tree when the daemon cannot be read.
  const joined = join(context);

  switch (outcome.kind) {
    case 'notrunning':
    case 'needspassword':
      return stateReport(context, url, outcome.kind);
    case 'failed':
      context.logger.warn('paseo attempt failed', { source: 'paseo', code: outcome.code });
      return failedReport(url, outcome.code);
    case 'listed': {
      if (joined === null) return failedReport(url, 'join_failed');
      const { agents, truncated } = outcome.listing;
      context.logger.info('paseo refreshed', {
        source: 'paseo',
        listed: agents.length,
        mapped: joined.mapped,
        named: joined.named,
        parented: joined.parented,
        parentUnmapped: joined.parentUnmapped,
        truncated,
      });
      const read = `Read ${plural(agents.length, 'Paseo agent', 'Paseo agents')}; ${plural(joined.mapped, 'session', 'sessions')} matched.`;
      return {
        result: truncated ? 'partial' : 'succeeded',
        status: truncated ? 'partial' : 'ok',
        location: url,
        adapterVersion: ADAPTER_VERSION,
        message: truncated ? `${read} Paseo lists more agents than one refresh reads.` : read,
      };
    }
  }
}
