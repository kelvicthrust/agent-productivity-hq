import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { EvidenceItem, PrDetailResponse } from '../../shared/contracts/prs';
import { apiGet, apiSend } from './api';
import { queryKeys } from './queryClient';

// Server state for PR-to-session links (TECH › Owner link decision transitions, journey J3). Delivery's evidence panel reads one
// PR's evidence and candidates and changes decisions; the Usage tree only reads (its badges come with each session). The
// hooks live here because more than one screen needs them and features may not import one another.
//
// The server holds ONE decision per (PR, session): a decision (confirmed, rejected, dismissed) or none, in which case the
// computed class shows. Every owner action is therefore "put the pair in a state", and so is every Undo:
//
//   Confirm, Link a session   PUT { decision: 'confirmed' }       Undo: back to what the pair was
//   Dismiss                   PUT { decision: 'dismissed' }       Undo: back to what the pair was
//   Mark incorrect            PUT { decision: 'rejected' }        Undo: back to what the pair was
//   Restore, Remove link      DELETE (no decision)                Undo: back to what the pair was
//
// "What the pair was" is the owner's decision before the change: none (DELETE), confirmed (an owner link), rejected (a struck
// evidence link) or dismissed. `priorStateOf` reads it from the item the owner acted on, so the screen never has to remember it.
//
// Nothing is written optimistically: a change that fails leaves the cache and the screen as they were (G8_7: no optimistic
// persistence). A change that succeeds invalidates every `analytics` query, because one decision moves the PR's class, the
// Delivery counts, the Overview Linked PRs figure, the records and the Usage tree's badges together.

export type PrDetail = z.infer<typeof PrDetailResponse>;
export type { EvidenceItem };

/** What the owner can do to one link. `add` is "Link a session" from the candidates. */
export type LinkAction = 'confirm' | 'dismiss' | 'reject' | 'restore' | 'remove' | 'add';

/** The owner's say on one link: a decision, or null for none (the computed class shows). */
export type LinkState = 'confirmed' | 'rejected' | 'dismissed' | null;

/** The state each action puts the link in. */
export const STATE_AFTER: Readonly<Record<LinkAction, LinkState>> = {
  confirm: 'confirmed',
  add: 'confirmed',
  dismiss: 'dismissed',
  reject: 'rejected',
  restore: null,
  remove: null,
};

/** The toast text when a change did not save. The screen shows it and puts the item back as it was. */
export const LINK_SAVE_FAILED = 'Couldn’t save your change';

/**
 * The owner's decision on the link an item shows: an owner link is a confirmation and a struck-through link is a rejection;
 * evidence and a suggestion carry no decision. No item (a session offered from the candidates) means none. Undo goes back to this.
 */
export function priorStateOf(item: Pick<EvidenceItem, 'effectiveClass'> | undefined): LinkState {
  if (item === undefined) return null;
  if (item.effectiveClass === 'owner') return 'confirmed';
  if (item.effectiveClass === 'rejected') return 'rejected';
  return null;
}

/** `/api/prs/{prId}/links/{sessionId}`. A GitHub node id is opaque, so it is encoded. */
export const linkPath = (prId: string, sessionId: number): string =>
  `/api/prs/${encodeURIComponent(prId)}/links/${sessionId}`;

export interface LinkRequest {
  method: 'PUT' | 'DELETE';
  path: string;
  body: { decision: 'confirmed' | 'rejected' | 'dismissed' } | undefined;
}

/** The one request that puts a pair in `state`. */
export function requestFor(prId: string, sessionId: number, state: LinkState): LinkRequest {
  const path = linkPath(prId, sessionId);
  return state === null
    ? { method: 'DELETE', path, body: undefined }
    : { method: 'PUT', path, body: { decision: state } };
}

/** Puts the pair in `state`. A decision answers with the updated item; taking a decision back answers with nothing. */
export async function saveLinkState(
  prId: string,
  sessionId: number,
  state: LinkState,
): Promise<EvidenceItem | null> {
  const request = requestFor(prId, sessionId, state);
  if (request.method === 'DELETE') {
    await apiSend('DELETE', request.path, null);
    return null;
  }
  return apiSend('PUT', request.path, EvidenceItem, request.body);
}

/** The evidence and the candidate sessions of one PR. Nothing is asked until a PR is named (a closed row asks nothing). */
export function useEvidence(prId: string | null) {
  return useQuery({
    queryKey: queryKeys.analytics('pr-detail', { prId }),
    queryFn: ({ signal }) =>
      apiGet(`/api/prs/${encodeURIComponent(prId ?? '')}`, PrDetailResponse, { signal }),
    enabled: prId !== null,
  });
}

export interface LinkChange {
  prId: string;
  sessionId: number;
  /** The state to put the pair in: `STATE_AFTER[action]` for a change, `priorStateOf(item)` for an Undo. */
  state: LinkState;
}

/**
 * One change to one link. On success every number that reads links is stale (`analytics`) and refetches; on failure nothing in
 * the cache moves, and `error` carries the reason for the screen to word (`LINK_SAVE_FAILED`).
 */
export function useLinkChange() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ prId, sessionId, state }: LinkChange) => saveLinkState(prId, sessionId, state),
    onSuccess: () => client.invalidateQueries({ queryKey: ['analytics'] }),
  });
}
