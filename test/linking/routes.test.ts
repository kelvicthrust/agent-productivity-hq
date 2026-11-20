import { describe, expect, it } from 'vitest';
import { ErrorEnvelope } from '../../src/shared/contracts/errors.ts';
import { EvidenceItem, PrDetailResponse } from '../../src/shared/contracts/prs.ts';
import { recomputeLinks } from '../../src/server/services/links.ts';
import {
  HOST,
  HOUR,
  MERGED,
  NOW,
  REPO,
  addPr,
  addRepo,
  addSession,
  decisions,
  getJson,
  linksApp,
  memoryDb,
  send,
  showRefs,
} from './world.ts';

// The routes of the link engine behind the product's guards (G8_4; the server half of G8_6): GET /api/prs/{prId}, and PUT and
// DELETE /api/prs/{prId}/links/{sessionId}. Bodies are parsed by the same contracts the client uses.

function world() {
  const db = memoryDb();
  addRepo(db, REPO);
  const pr = addPr(db, 7);
  const evidence = addSession(db, { lastEventAt: MERGED - 30 * HOUR, tokens: 120 });
  const near = addSession(db, { lastEventAt: MERGED - 2 * HOUR, tokens: 80, provider: 'codex' });
  const candidate = addSession(db, { lastEventAt: MERGED - 60 * HOUR, tokens: 40 });
  showRefs(db, evidence, { prs: ['kelvin/app#7'] });
  recomputeLinks(db, NOW);
  return { db, app: linksApp(db), pr, evidence, near, candidate };
}

const path = (pr: string, session: number | string) =>
  `/api/prs/${encodeURIComponent(pr)}/links/${session}`;

const errorOf = (body: unknown) => ErrorEnvelope.parse(body).error;

describe('GET /api/prs/{prId}', () => {
  it('answers the contract’s evidence, candidates and PR row, with no key the contract does not know', async () => {
    const { app, pr, evidence, near, candidate } = world();
    const { status, body } = await getJson(app, `/api/prs/${encodeURIComponent(pr)}`);
    expect(status).toBe(200);
    const parsed = PrDetailResponse.parse(body);
    expect(parsed).toEqual(body);
    expect(parsed.pr).toMatchObject({
      id: pr,
      repo: REPO,
      number: 7,
      linkClass: 'evidence',
      linkedSessionCount: 1,
      suggestedCount: 1,
      providers: ['codex', 'claude'],
    });
    expect(parsed.evidence?.map((i) => [i.effectiveClass, i.session.id])).toEqual([
      ['evidence', evidence],
      ['suggested', near],
    ]);
    expect(parsed.evidence?.[0]?.actions).toEqual(['reject']);
    expect(parsed.evidence?.[1]?.actions).toEqual(['dismiss', 'confirm']);
    expect(parsed.candidates?.map((s) => s.id)).toEqual([candidate]);
  });

  it('is 404 not_found in the error envelope for an unknown PR', async () => {
    const { app } = world();
    const { status, body } = await getJson(app, '/api/prs/PR_unknown');
    expect(status).toBe(404);
    expect(errorOf(body)).toMatchObject({ code: 'not_found', retryable: false });
  });

  it('takes a GitHub node id with characters that need encoding in a path', async () => {
    const db = memoryDb();
    addRepo(db, REPO);
    // node ids are opaque base64-ish strings: `+`, `/` and `=` all occur
    db.prepare(
      `INSERT INTO pull_request (node_id, repo_id, number, title, url, merged_at) VALUES ('PR_kwDOAb+c/d=', ?, 9, 't', 'https://github.com/kelvin/app/pull/9', ?)`,
    ).run(REPO, MERGED);
    const s = addSession(db, { lastEventAt: MERGED - HOUR });
    const app = linksApp(db);
    const detail = await getJson(app, `/api/prs/${encodeURIComponent('PR_kwDOAb+c/d=')}`);
    expect(detail.status).toBe(200);
    const put = await send(app, 'PUT', path('PR_kwDOAb+c/d=', s), { decision: 'confirmed' });
    expect(put.status).toBe(200);
    expect(decisions(db)).toMatchObject([{ pr_node_id: 'PR_kwDOAb+c/d=', session_id: s }]);
  });
});

describe('PUT /api/prs/{prId}/links/{sessionId}', () => {
  it('records the decision and answers with the updated item', async () => {
    const { app, db, pr, near } = world();
    const { status, body } = await send(app, 'PUT', path(pr, near), { decision: 'confirmed' });
    expect(status).toBe(200);
    const item = EvidenceItem.parse(body);
    expect(item).toEqual(body);
    expect(item).toMatchObject({
      effectiveClass: 'owner',
      sourceClass: 'suggested',
      basis: 'owner',
      actions: ['remove'],
    });
    expect(item.session.linkedPrs).toEqual([
      { prId: pr, repo: REPO, number: 7, mergedAt: '2026-11-03T18:00:00.000Z', class: 'owner' },
    ]);
    expect(decisions(db)).toMatchObject([
      { session_id: near, decision: 'confirmed', decided_at: NOW },
    ]);
  });

  it('is idempotent: the same decision again answers the same item and writes nothing new', async () => {
    const { app, db, pr, near } = world();
    const first = await send(app, 'PUT', path(pr, near), { decision: 'confirmed' });
    const written = decisions(db);
    const second = await send(app, 'PUT', path(pr, near), { decision: 'confirmed' });
    expect(second).toEqual(first);
    expect(decisions(db)).toEqual(written);
  });

  it('adds a candidate session as an owner link ("Link a session")', async () => {
    const { app, pr, candidate } = world();
    const { status, body } = await send(app, 'PUT', path(pr, candidate), { decision: 'confirmed' });
    expect(status).toBe(200);
    expect(EvidenceItem.parse(body)).toMatchObject({
      effectiveClass: 'owner',
      sourceClass: null,
      basisText: 'Confirmed by you',
    });
    const detail = PrDetailResponse.parse(
      (await getJson(app, `/api/prs/${encodeURIComponent(pr)}`)).body,
    );
    expect(detail.candidates).toEqual([]);
    expect(detail.pr?.linkedSessionCount).toBe(2);
  });

  it('is 400 invalid_input, with the field named and nothing written, for a change the table does not allow', async () => {
    const { app, db, pr, evidence } = world();
    const { status, body } = await send(app, 'PUT', path(pr, evidence), { decision: 'dismissed' });
    expect(status).toBe(400);
    const error = errorOf(body);
    expect(error).toMatchObject({ code: 'invalid_input', retryable: false });
    expect(error.details).toMatchObject({ fields: { decision: error.message } });
    expect(decisions(db)).toEqual([]);
  });

  it('is 404 not_found for an unknown PR or session', async () => {
    const { app, pr, near } = world();
    for (const target of [path('PR_unknown', near), path(pr, 999_999)]) {
      const { status, body } = await send(app, 'PUT', target, { decision: 'confirmed' });
      expect(status).toBe(404);
      expect(errorOf(body).code).toBe('not_found');
    }
  });

  it.each([
    ['not JSON', '{nope'],
    ['an empty body', ''],
    ['no decision', {}],
    ['an unknown decision', { decision: 'maybe' }],
    ['a decision that is not text', { decision: 1 }],
    ['an array', ['confirmed']],
    ['the null body', 'null'],
  ])('is 400 invalid_input for %s', async (_name, payload) => {
    const { app, db, pr, near } = world();
    const { status, body } = await send(app, 'PUT', path(pr, near), payload);
    expect(status).toBe(400);
    expect(errorOf(body).code).toBe('invalid_input');
    expect(decisions(db)).toEqual([]);
  });

  it.each(['abc', '1.5', '-1', '1e3', '0x10', '', '99999999999999999999'])(
    'is 400 invalid_input for the session id %j, not a 404',
    async (id) => {
      const { app, pr } = world();
      const { status, body } = await send(app, 'PUT', path(pr, id), {
        decision: 'confirmed',
      });
      // an empty id is a different route (no match), which the app answers as not found
      expect(status).toBe(id === '' ? 404 : 400);
      expect(errorOf(body).code).toBe(id === '' ? 'not_found' : 'invalid_input');
    },
  );

  it('is refused without the app header or a JSON content type, and writes nothing', async () => {
    const { app, db, pr, near } = world();
    const plain = await send(app, 'PUT', path(pr, near), { decision: 'confirmed' }, HOST);
    expect(plain.status).toBe(403);
    const text = await send(
      app,
      'PUT',
      path(pr, near),
      { decision: 'confirmed' },
      {
        ...HOST,
        'x-agent-productivity-request': '1',
        'content-type': 'text/plain',
      },
    );
    expect(text.status).toBe(403);
    expect(decisions(db)).toEqual([]);
  });
});

describe('DELETE /api/prs/{prId}/links/{sessionId}', () => {
  it('takes the decision back with 204 and no body, and the computed class shows again', async () => {
    const { app, db, pr, near } = world();
    await send(app, 'PUT', path(pr, near), { decision: 'dismissed' });
    expect(decisions(db)).toHaveLength(1);
    const res = await send(app, 'DELETE', path(pr, near));
    expect(res).toEqual({ status: 204, body: null });
    expect(decisions(db)).toEqual([]);
    const detail = PrDetailResponse.parse(
      (await getJson(app, `/api/prs/${encodeURIComponent(pr)}`)).body,
    );
    expect(detail.evidence?.map((i) => i.effectiveClass)).toEqual(['evidence', 'suggested']);
  });

  it('is idempotent: 204 even when no decision existed', async () => {
    const { app, pr, near, candidate } = world();
    expect((await send(app, 'DELETE', path(pr, near))).status).toBe(204);
    expect((await send(app, 'DELETE', path(pr, near))).status).toBe(204);
    expect((await send(app, 'DELETE', path(pr, candidate))).status).toBe(204);
  });

  it('is 404 for an unknown PR or session, and 400 for a session id that is not a number', async () => {
    const { app, pr } = world();
    expect((await send(app, 'DELETE', path('PR_unknown', 1))).status).toBe(404);
    expect((await send(app, 'DELETE', path(pr, 999_999))).status).toBe(404);
    expect((await send(app, 'DELETE', path(pr, 'abc'))).status).toBe(400);
  });

  it('is refused without the app header', async () => {
    const { app, pr, near } = world();
    expect((await send(app, 'DELETE', path(pr, near), undefined, HOST)).status).toBe(403);
  });
});

describe('a refresh between two requests', () => {
  it('leaves the owner’s decisions as the routes wrote them', async () => {
    const { app, db, pr, evidence, near, candidate } = world();
    await send(app, 'PUT', path(pr, evidence), { decision: 'rejected' });
    await send(app, 'PUT', path(pr, near), { decision: 'dismissed' });
    await send(app, 'PUT', path(pr, candidate), { decision: 'confirmed' });
    const written = decisions(db);

    recomputeLinks(db, NOW + HOUR);
    recomputeLinks(db, NOW + 2 * HOUR);

    expect(decisions(db)).toEqual(written);
    const detail = PrDetailResponse.parse(
      (await getJson(app, `/api/prs/${encodeURIComponent(pr)}`)).body,
    );
    expect(detail.evidence?.map((i) => [i.session.id, i.effectiveClass])).toEqual([
      [candidate, 'owner'],
      [evidence, 'rejected'],
    ]);
    expect(detail.pr?.linkClass).toBe('owner');
    // the dismissed suggestion is offered again as a candidate
    expect(detail.candidates?.map((s) => s.id)).toEqual([near]);
  });
});
