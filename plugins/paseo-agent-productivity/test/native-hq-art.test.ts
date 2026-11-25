import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSessions, layoutScene } from '../client/native-hq-art.generated.mjs';
import { inkFrames } from '../client/native-hq-boil.generated.ts';
import { fitRoomLettering, playpenWidth } from '../client/native-hq-letter-metrics.ts';
import type { RosterAgent } from '../client/native-types.ts';

function agent(id: string, changes: Partial<RosterAgent> = {}): RosterAgent {
  return {
    id,
    provider: 'claude',
    kind: 'root',
    parentId: null,
    parentAway: false,
    title: 'Build HQ',
    repo: 'owner/hq',
    workspace: null,
    state: 'working',
    activity: 'editing',
    since: '2026-11-21T12:00:00.000Z',
    startedAt: null,
    waitReason: null,
    confidence: 'reported',
    seenBy: { paseo: true },
    ...changes,
  };
}

test('the native scene retains room slots when the sessions reorder and a helper stays with its parent', () => {
  const lead = agent('a');
  const helper = agent('helper', { provider: 'codex', kind: 'child', parentId: lead.id });
  const solo = agent('b');
  const options = { columns: 3 as const, nowMs: Date.parse(lead.since) };
  const first = layoutScene(null, buildSessions([lead, helper, solo]), options);
  assert.deepEqual(
    first.rooms.map((room) => [room.id, room.slot, room.characters.length]),
    [
      ['a', 0, 2],
      ['b', 1, 1],
    ],
  );
  const waiting = { ...solo, state: 'waiting' as const, waitReason: 'permission' as const };
  const nextSessions = buildSessions([waiting, lead, helper]);
  const next = layoutScene(first, nextSessions, options);
  assert.deepEqual(
    next.rooms.map((room) => [room.id, room.slot]),
    [
      ['a', 0],
      ['b', 1],
    ],
  );
  assert.equal(next.cells, 3);
});

test('outlined lettering fits wide names and keeps the session state on the sign', () => {
  const measure = (text: string) => playpenWidth(text, 13);
  const room = 120;
  const place = 'WWWWWWWWWWWWWW';
  const detail = 'captain + 3';
  const title = fitRoomLettering(place, room, measure);
  const secondLine = fitRoomLettering(`${place} · ${detail}`, room, measure, detail);
  assert.ok(title.endsWith('…'));
  assert.ok(measure(title) <= room);
  assert.ok(secondLine.endsWith(detail));
  assert.ok(measure(secondLine) <= room);
});

test('a narrow scene labels workspace rooms and subagents whose parent is absent', () => {
  const workspace = agent('paseo', { title: 'Assess PDLC workflow' });
  const child = agent('a123456789abc', { kind: 'child', parentAway: true, title: null });
  const scene = layoutScene(null, buildSessions([workspace, child]), {
    columns: 1,
    nowMs: Date.parse(workspace.since),
  });
  assert.equal(scene.rooms.find((room) => room.id === workspace.id)?.name, 'Assess PDLC workflow');
  assert.equal(scene.rooms.find((room) => room.id === child.id)?.name, 'Subagent · 789abc');
});

test('the embedded roof and ground loops each have three distinct transparent frames', () => {
  for (const [kind, frames] of Object.entries(inkFrames)) {
    assert.equal(new Set(frames).size, 3);
    for (const uri of frames) {
      const png = Buffer.from(uri.split(',')[1], 'base64');
      assert.equal(png.subarray(1, 4).toString(), 'PNG');
      assert.equal(png.readUInt32BE(16), 1000);
      assert.equal(png.readUInt32BE(20), kind === 'roof' ? 48 : 14);
      assert.equal(png.readUInt8(25), 6);
    }
  }
});
