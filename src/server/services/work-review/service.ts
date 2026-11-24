import type { Scope } from '../../../shared/contracts/common.ts';
import { ApiError } from '../../../shared/contracts/errors.ts';
import type {
  WorkReviewAccount,
  WorkReviewBullet,
  WorkReviewEvidence,
  WorkReviewState,
  WorkReviewVersion,
} from '../../../shared/contracts/work-review.ts';
import { todayIn, utcBounds } from '../../../shared/domain/periods.ts';
import type { RawFilters } from '../../../shared/domain/scope.ts';
import type { DiscoveryInput } from '../../collectors/discovery.ts';
import type { Db } from '../../db/open.ts';
import { getMeta } from '../../db/queries/meta.ts';
import { readSetupState } from '../../db/queries/setup.ts';
import {
  readVersion,
  readWorkNotes,
  reviewVersions,
  saveVersion,
  saveWorkNotes,
} from '../../db/queries/work-review.ts';
import { resolveUsageScope } from '../usage.ts';
import { collectWorkReviewEvidence, readWorkReviewTurns } from './evidence.ts';
import type { WorkReviewWorker } from './worker.ts';

const WORKER_ERRORS: Record<string, string> = {
  sign_in_required: 'Sign in to Work Review again to use your ChatGPT plan.',
  model_unavailable: 'GPT-6 Luna is unavailable to this ChatGPT account.',
  usage_limit: 'Your ChatGPT plan or this app has reached its usage limit. Check Manage usage.',
  not_eligible: 'This ChatGPT account or workspace does not allow plan use for Work Review.',
  unsupported: 'This account cannot complete tool-free requests with GPT-6 Luna.',
  timeout: 'The request to OpenAI timed out. You can retry this update.',
  unavailable: 'OpenAI could not complete the request. Check your connection and try again.',
};
type Evidence = ReturnType<typeof collectWorkReviewEvidence>;
interface Item {
  kind: WorkReviewBullet['kind'];
  text: string;
  group: string;
  evidence: WorkReviewEvidence[];
}
interface Options {
  db: Db;
  timezone: string;
  now: () => number;
  local?: DiscoveryInput | undefined;
  worker?: WorkReviewWorker | undefined;
  accountStatus?: (() => WorkReviewAccount['status']) | undefined;
}

function citations(items: Item[]): WorkReviewEvidence[] {
  const result = new Map<string, WorkReviewEvidence>();
  for (const item of items) {
    for (const ref of item.evidence) {
      const key = JSON.stringify([ref.kind, ref.id, ref.date]);
      const earlier = result.get(key);
      result.set(
        key,
        earlier?.notes && ref.notes
          ? { ...ref, notes: [...new Set([...earlier.notes, ...ref.notes])] }
          : ref,
      );
    }
  }
  return [...result.values()];
}

async function summarizeBatch(
  worker: WorkReviewWorker,
  scope: Scope,
  batch: Item[],
  signal: AbortSignal,
) {
  const entries = batch.map((item, index) => ({
    id: String(index),
    kind: item.kind,
    text: item.text,
    group: item.group,
  }));
  const summary = await worker.summarize(
    { startDate: scope.start, endDate: scope.end, items: entries },
    signal,
  );
  const resolve = (ids: string[], kind?: Item['kind']) => {
    if (!ids.length) throw new Error('Missing citation');
    return ids.map((id) => {
      const index = Number(id);
      const item = batch[index];
      if (!item || String(index) !== id || (kind && item.kind !== kind))
        throw new Error('Invalid citation');
      return item;
    });
  };
  const headlineEvidence = citations(resolve(summary.ids));
  const bullets = summary.bullets.map((bullet) => {
    const sources = resolve(bullet.ids, bullet.kind);
    return {
      kind: bullet.kind,
      text: bullet.text,
      group: sources[0]!.group,
      evidence: citations(sources),
    };
  });
  return { headline: summary.headline, headlineEvidence, bullets };
}

async function compose(worker: WorkReviewWorker, scope: Scope, items: Item[], signal: AbortSignal) {
  // Team PRs never enter a first-person writing prompt.
  let personal = items.filter((item) => item.kind !== 'team');
  const team = items.filter((item) => item.kind === 'team');
  // Long months and custom ranges still get one short update. A model batch produces at most eight
  // bullets. Resolve its citations back to the original rows at every level of the roll-up.
  while (personal.length > 80) {
    const next: Item[] = [];
    for (const kind of ['shipped', 'progress', 'open'] as const) {
      const section = personal.filter((item) => item.kind === kind);
      for (let offset = 0; offset < section.length; offset += 80) {
        signal.throwIfAborted();
        const batch = section.slice(offset, offset + 80);
        const result = await summarizeBatch(worker, scope, batch, signal);
        // A short batch can be expressed entirely in its headline. Its sources all share this kind.
        if (result.bullets.length) next.push(...result.bullets);
        else
          next.push({
            kind,
            text: result.headline,
            group: batch[0]!.group,
            evidence: result.headlineEvidence,
          });
      }
    }
    personal = next;
  }
  const result = personal.length
    ? await summarizeBatch(worker, scope, personal, signal)
    : {
        headline: team.length
          ? `The team merged ${team.length} pull request${team.length === 1 ? '' : 's'} in this period.`
          : 'No work update could be established from the available evidence.',
        headlineEvidence: citations(team),
        bullets: [],
      };
  const bullets: WorkReviewBullet[] = result.bullets.map(({ kind, text, evidence }) => ({
    kind,
    text,
    evidence,
  }));
  if (team.length <= 3) {
    bullets.push(...team.map(({ kind, text, evidence }) => ({ kind, text, evidence })));
  } else {
    bullets.push({
      kind: 'team',
      text: `Other contributors authored ${team.length} merged pull requests in the selected repositories.`,
      evidence: citations(team),
    });
  }
  return { headline: result.headline, headlineEvidence: result.headlineEvidence, bullets };
}

export function createWorkReviewService({
  db,
  timezone,
  now,
  local,
  worker,
  accountStatus,
}: Options) {
  let active: { key: string; controller: AbortController; done: Promise<void> } | null = null;
  let failure: { key: string; message: string } | null = null;
  let closed = false;
  function selection(raw: RawFilters) {
    const scope = resolveUsageScope(db, raw, { nowMs: now(), timezone });
    if (scope.ignoredRepos?.length)
      throw new ApiError('invalid_input', 'Select a known repository for this review.');
    const key = JSON.stringify([
      scope.start,
      scope.end,
      timezone,
      [...scope.repos].sort(),
      scope.provider,
      scope.author,
      getMeta(db, 'github_login')?.toLowerCase() ?? null,
    ]);
    return { scope, key };
  }

  function state(scope: Scope, key: string, version?: number, inputs?: Evidence): WorkReviewState {
    const versions = reviewVersions(db, key);
    const chosen = version ?? versions[0];
    const saved = chosen === undefined ? null : readVersion(db, key, chosen);
    if (version !== undefined && !saved)
      throw new ApiError('not_found', 'This review version is unavailable.');
    const running = active?.key === key;
    const message = failure?.key === key ? failure.message : null;
    return {
      status: running ? 'running' : message ? 'failed' : 'idle',
      message,
      review: saved?.review ?? null,
      versions,
      changed:
        saved !== null &&
        saved.hash !== (inputs ?? collectWorkReviewEvidence(db, scope, now())).fingerprint,
      locked: scope.end < todayIn(now(), timezone),
    };
  }

  async function generateVersion(
    scope: Scope,
    key: string,
    inputs: Evidence,
    version: number,
    signal: AbortSignal,
  ) {
    if (!worker) throw new Error('unavailable');
    const items: Item[] = [];
    const prs = new Map<string, WorkReviewEvidence>();
    for (const pr of inputs.prs) {
      const ref: WorkReviewEvidence = {
        kind: 'pr',
        id: pr.id,
        label: `${pr.repo}#${pr.number} · ${pr.title}`,
        repo: pr.repo,
        date: pr.date,
      };
      prs.set(pr.id, ref);
      items.push({
        kind: pr.mine ? 'shipped' : 'team',
        text: pr.mine
          ? pr.title
          : `${pr.repo}#${pr.number} merged (${pr.author ?? 'author unknown'}): ${pr.title}`,
        group: `pr:${pr.id}`,
        evidence: [ref],
      });
    }
    let partialDays = 0;
    for (const unit of inputs.sessionDays) {
      signal.throwIfAborted();
      let saved = readWorkNotes(db, unit.cacheKey, unit.fingerprint, unit.sourceHash);
      if (!saved) {
        const result = local
          ? await readWorkReviewTurns(unit, local, signal)
          : { turns: [], partial: true };
        const notes =
          unit.title || result.turns.length
            ? await worker.extract(
                {
                  date: unit.date,
                  title: result.turns.length ? null : unit.title,
                  turns: result.turns,
                },
                signal,
              )
            : [];
        signal.throwIfAborted();
        saved = { notes, partial: result.partial || !result.turns.length };
        saveWorkNotes(
          db,
          unit.cacheKey,
          unit.fingerprint,
          unit.sourceHash,
          utcBounds(unit.date, timezone).start,
          notes,
          saved.partial,
        );
      }
      if (saved.partial) partialDays++;
      const session: WorkReviewEvidence = {
        kind: 'session',
        id: String(unit.sessionId),
        label: unit.title ?? `${unit.provider === 'codex' ? 'Codex' : 'Claude Code'} session`,
        date: unit.date,
        repo: unit.repo,
      };
      const linked = unit.linkedPrIds.flatMap((id) => prs.get(id) ?? []);
      for (const note of saved.notes)
        items.push({
          kind: note.kind,
          text: note.text,
          group: unit.group,
          evidence: [{ ...session, notes: [note.text] }, ...linked],
        });
    }
    const result = await compose(worker, scope, items, signal);
    signal.throwIfAborted();
    const coverage = [...inputs.coverage];
    if (partialDays)
      coverage.push(
        `Excerpts were missing or incomplete for ${partialDays} session-day${partialDays === 1 ? '' : 's'}. The update uses the available evidence.`,
      );
    const review: WorkReviewVersion = {
      ...result,
      version,
      createdAt: new Date(now()).toISOString(),
      coverage,
    };
    saveVersion(db, key, utcBounds(scope.start, timezone).start, inputs.fingerprint, review);
  }

  function read(raw: RawFilters, version?: number) {
    const { key, scope } = selection(raw);
    return state(scope, key, version);
  }

  function generate(raw: RawFilters, revision: boolean) {
    const { scope, key } = selection(raw);
    if (closed || !readSetupState(db).complete)
      throw new ApiError('invalid_input', 'Finish setup before generating a work review.');
    if (active?.key === key) return state(scope, key);
    const evidence = collectWorkReviewEvidence(db, scope, now());
    const current = state(scope, key, undefined, evidence);
    if (current.review && !current.changed) return current;
    if (current.review && current.locked && !revision)
      throw new ApiError('invalid_input', 'Create a revision to update this saved review.');
    if (active)
      throw new ApiError(
        'refresh_running',
        'Another work review is being generated. Try again when it finishes.',
      );
    if (!worker || (accountStatus && accountStatus() !== 'connected'))
      throw new ApiError(
        'upstream_unavailable',
        'Continue with ChatGPT in Work Review before generating an update.',
      );
    const controller = new AbortController();
    failure = null;
    const done = Promise.resolve()
      .then(() =>
        generateVersion(scope, key, evidence, (current.versions[0] ?? 0) + 1, controller.signal),
      )
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
        const message =
          typeof code === 'string' && Object.hasOwn(WORKER_ERRORS, code)
            ? WORKER_ERRORS[code]!
            : 'The review could not be completed. Try again to reuse the notes already prepared.';

        failure = { key, message };
      })
      .finally(() => {
        active = null;
      });
    active = { key, controller, done };
    return { ...current, status: 'running' as const, message: null };
  }
  async function cancel() {
    active?.controller.abort();
    await active?.done;
    failure = null;
  }
  return {
    read,
    generate,
    idle: async () => {
      await active?.done;
    },
    cancel,
    close: () => {
      closed = true;
      return cancel();
    },
  };
}
export type WorkReviewService = ReturnType<typeof createWorkReviewService>;
