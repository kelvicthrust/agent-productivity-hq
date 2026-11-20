import { describe, expect, it } from 'vitest';
import type { HqAgent } from '../../../src/shared/contracts/hq';
import { sceneCaption } from '../../../src/client/features/hq/copy';
import {
  MAX_HELPERS,
  layoutScene,
  poseOf,
  type Scene,
  type SceneOptions,
} from '../../../src/client/features/hq/scene';
import { buildSessions } from '../../../src/client/features/hq/sessions';
import { fit, fitSecondLine, signTextWidth, signWidth } from '../../../src/client/features/hq/Room';
import { captionsCollide, planStage } from '../../../src/client/features/hq/stage';
import { agent, officeAgents } from '../../fixtures/hq/scripted';

type Spec = Parameters<typeof agent>[1];

// The scene's layout model: who gets which room, who stands in it and what they are doing. Pure, so no browser.

const NOW = Date.parse('2026-11-04T17:42:00Z');
const wide: SceneOptions = { columns: 3, nowMs: NOW };

/** A solo root named `id`, working. */
const solo = (id: string, extra: Partial<Spec> = {}) =>
  agent(NOW, { id, provider: 'claude', repo: `kelvin/${id}`, ...extra });

/** `n` solo sessions s0, s1, … with s0 the newest (so they come out in that order). */
const sessionsOf = (n: number, extra: (i: number) => Partial<Spec> = () => ({})) =>
  buildSessions(
    Array.from({ length: n }, (_, i) => solo(`s${i}`, { startedMinutesAgo: 10 + i, ...extra(i) })),
  );

const lay = (prev: Scene | null, agents: HqAgent[], opts = wide) =>
  layoutScene(prev, buildSessions(agents), opts);
const slots = (scene: Scene) => Object.fromEntries(scene.rooms.map((r) => [r.id, r.slot]));
const at = (columns: 1 | 2 | 3): SceneOptions => ({ columns, nowMs: NOW });
/** Sessions `s<N>` for the given numbers; a lower number is a newer session, so a fresh layout puts them in that order. */
const some = (...numbers: number[]) =>
  numbers.map((n) => solo(`s${n}`, { startedMinutesAgo: 10 + n }));

describe('rooms and slots', () => {
  it('lays the office out as four rooms, with a character for every agent', () => {
    const scene = lay(null, officeAgents(NOW));
    expect(scene.rooms.map((r) => [r.name, r.place, r.detail])).toEqual([
      ['Sync shared instructions', 'agent-toolkit', 'captain + 1'],
      ['Fix the flaky checkout test', 'atlas-api', 'solo'],
      ['Build the HQ page', 'agent-productivity', 'captain + 3'],
      ['scratch', null, 'idle 12 min'],
    ]);
    expect(scene.rooms.flatMap((r) => r.characters)).toHaveLength(8);
  });

  it('keeps every room in its slot while its session is present, whatever the order becomes', () => {
    const agents = officeAgents(NOW);
    const first = lay(null, agents);
    // The waiting agent goes back to work: the sessions are listed in another order, and no room moves.
    const calm = agents.map((a) =>
      a.id === 'hq-sync' ? { ...a, state: 'working' as const, waitReason: null } : a,
    );
    const second = lay(first, calm);
    expect(slots(second)).toEqual(slots(first));
    expect(second.rooms.find((r) => r.id === 'hq-sync')?.mood).toBe('normal');
  });

  it('gives a new session the lowest free slot, and frees the slot of one that is gone', () => {
    const four = lay(
      null,
      sessionsOf(4).map((s) => s.root.agent),
    );
    expect(slots(four)).toEqual({ s0: 0, s1: 1, s2: 2, s3: 3 });
    const without = lay(
      four,
      ['s0', 's2', 's3'].map((id) => solo(id)),
    );
    expect(slots(without)).toEqual({ s0: 0, s2: 2, s3: 3 });
    const joined = lay(
      without,
      ['s0', 's2', 's3', 'new'].map((id) => solo(id)),
    );
    expect(joined.rooms.find((r) => r.id === 'new')?.slot).toBe(1);
    expect(joined.rooms.find((r) => r.id === 's3')?.slot).toBe(3);
  });
});

// A session that is present keeps its slot at a given column count; a vacated slot stays an empty room until a new session takes
// the lowest free one; only rows after the last occupied slot go.
describe.each([1, 2, 3] as const)('a building %i column(s) wide', (columns) => {
  const opts = at(columns);
  const rowsFor = (slot: number) => Math.floor(slot / columns) + 1;
  const cellsFor = (highest: number) => columns * rowsFor(highest);
  const six = lay(null, some(0, 1, 2, 3, 4, 5), opts);

  it('has the screen columns and a row for every `columns` sessions, however many there are', () => {
    expect(six).toMatchObject({ cols: columns, cells: cellsFor(5) });
    for (const n of [1, 2, 3, 4, 7, 12, 25]) {
      const scene = lay(null, some(...Array.from({ length: n }, (_, i) => i)), opts);
      expect(scene.rooms).toHaveLength(n);
      expect(scene.cols).toBe(columns);
      expect(scene.cells).toBe(columns * Math.ceil(n / columns));
    }
  });

  it('is empty when nobody is running', () => {
    expect(lay(null, [], opts)).toMatchObject({ rooms: [], cells: 0 });
  });

  it('leaves the first slot empty and moves no other room when the first session goes', () => {
    const next = lay(six, some(1, 2, 3, 4, 5), opts);
    expect(slots(next)).toEqual({ s1: 1, s2: 2, s3: 3, s4: 4, s5: 5 });
    expect(next.cells).toBe(six.cells);
  });

  it('leaves a middle slot empty and moves no other room when a middle session goes', () => {
    const next = lay(six, some(0, 1, 3, 4, 5), opts);
    expect(slots(next)).toEqual({ s0: 0, s1: 1, s3: 3, s4: 4, s5: 5 });
    expect(next.cells).toBe(six.cells);
  });

  it('drops a row that the last session leaves empty, and no other room moves', () => {
    // Slots 0 to 6 are in use: the seventh session is alone in its row exactly when `columns` divides 6.
    const seven = lay(six, some(0, 1, 2, 3, 4, 5, 6), opts);
    const next = lay(seven, some(0, 1, 2, 3, 4, 5), opts);
    expect(slots(next)).toEqual({ s0: 0, s1: 1, s2: 2, s3: 3, s4: 4, s5: 5 });
    expect(next.cells).toBe(cellsFor(5));
    expect(seven.cells).toBe(cellsFor(6));
  });

  it('keeps the rest of its row when the last session goes but others share the row', () => {
    const five = lay(null, some(0, 1, 2, 3, 4), opts);
    const next = lay(five, some(0, 1, 2, 3), opts);
    expect(slots(next)).toEqual({ s0: 0, s1: 1, s2: 2, s3: 3 });
    expect(next.cells).toBe(cellsFor(3));
  });

  it('drops every empty row after the last occupied slot, not only one', () => {
    const next = lay(six, some(0), opts);
    expect(slots(next)).toEqual({ s0: 0 });
    expect(next.cells).toBe(columns);
    // The slot a trailing session leaves is not reused by the next session that arrives: it takes the lowest free one.
    expect(slots(lay(next, some(0, 7), opts))).toEqual({ s0: 0, s7: 1 });
  });

  it('keeps empty rooms between sessions that remain, and does not trim a gap above an occupied slot', () => {
    const next = lay(six, some(5), opts);
    expect(slots(next)).toEqual({ s5: 5 });
    expect(next.cells).toBe(six.cells);
    expect(next.rooms).toHaveLength(1);
  });

  it('gives a new session the lowest free slot, then the next one', () => {
    const gaps = lay(six, some(0, 2, 4, 5), opts); // slots 1 and 3 are free
    expect(slots(gaps)).toEqual({ s0: 0, s2: 2, s4: 4, s5: 5 });
    const one = lay(gaps, [...some(0, 2, 4, 5), solo('n1')], opts);
    expect(slots(one)).toEqual({ s0: 0, s2: 2, s4: 4, s5: 5, n1: 1 });
    const two = lay(one, [...some(0, 2, 4, 5), solo('n1'), solo('n2')], opts);
    expect(slots(two)).toEqual({ s0: 0, s2: 2, s4: 4, s5: 5, n1: 1, n2: 3 });
    expect(two.cells).toBe(gaps.cells);
  });

  it('puts a new session after the last one, growing the building a row when that row is full', () => {
    const next = lay(six, [...some(0, 1, 2, 3, 4, 5), solo('n')], opts);
    expect(next.rooms.find((r) => r.id === 'n')?.slot).toBe(6);
    expect(next.cells).toBe(cellsFor(6));
    expect(slots(next)).toMatchObject({ s0: 0, s5: 5 });
  });

  it('does not move a room because the roster is listed in another order', () => {
    const next = lay(six, [...some(0, 1, 2, 3, 4, 5)].reverse(), opts);
    expect(slots(next)).toEqual(slots(six));
  });

  it('never lets two sessions share a slot or leaves one outside the building', () => {
    let scene = lay(null, some(0, 1, 2, 3, 4, 5, 6, 7, 8), opts);
    const rounds: number[][] = [[1, 4, 7], [0, 2, 3, 5, 6, 8, 9], [9, 10, 11, 12], [], [3, 5]];
    for (const round of rounds) {
      scene = lay(scene, some(...round), opts);
      const used = scene.rooms.map((r) => r.slot);
      expect(new Set(used).size).toBe(used.length);
      expect(Math.max(-1, ...used)).toBeLessThan(scene.cells);
      expect(scene.cells % columns).toBe(0);
    }
  });
});

describe('when the column count changes', () => {
  it('closes the slots up in the order they had, empty rooms included, and puts newcomers after them', () => {
    const three = lay(null, some(0, 1, 2, 3, 4, 5), at(3));
    const gaps = lay(three, some(1, 3, 5), at(3));
    expect(slots(gaps)).toEqual({ s1: 1, s3: 3, s5: 5 });
    const phone = lay(gaps, [...some(1, 3, 5), solo('n')], at(1));
    expect(slots(phone)).toEqual({ s1: 0, s3: 1, s5: 2, n: 3 });
    expect(phone.cells).toBe(4);
    const tablet = lay(phone, some(1, 3, 5), at(2));
    expect(slots(tablet)).toEqual({ s1: 0, s3: 1, s5: 2 });
    expect(tablet).toMatchObject({ cols: 2, cells: 4 });
  });

  it('keeps every room put once the new count has been laid out', () => {
    const three = lay(null, some(0, 1, 2, 3, 4), at(3));
    const phone = lay(three, some(0, 2, 4), at(1));
    expect(slots(lay(phone, some(0, 2, 4), at(1)))).toEqual(slots(phone));
  });
});

describe('every session has a room', () => {
  it('never folds, whatever the number of sessions, however long some have been idle', () => {
    const agents = Array.from({ length: 40 }, (_, i) =>
      solo(`s${i}`, {
        startedMinutesAgo: 10 + i,
        ...(i % 3 === 0 ? { state: 'idle', activity: 'none', sinceMinutesAgo: 30 + i } : {}),
      }),
    );
    for (const columns of [1, 2, 3] as const) {
      const scene = lay(null, agents, at(columns));
      expect(scene.rooms).toHaveLength(40);
      expect(scene.cells).toBe(columns * Math.ceil(40 / columns));
    }
  });

  it('draws a crowd of waiting sessions in full', () => {
    const agents = Array.from({ length: 8 }, (_, i) =>
      solo(`s${i}`, { state: 'waiting', activity: 'none', waitReason: 'question' }),
    );
    const scene = lay(null, agents);
    expect(scene.rooms).toHaveLength(8);
    expect(scene.rooms.every((room) => room.mood === 'needs')).toBe(true);
    expect(scene.cells).toBe(9);
  });
});

describe('inside a room', () => {
  const crew = (helpers: number) => [
    agent(NOW, { id: 'boss', provider: 'claude', repo: 'kelvin/crew' }),
    ...Array.from({ length: helpers }, (_, i) =>
      agent(NOW, {
        id: `h${i}`,
        provider: i % 2 ? 'claude' : 'codex',
        kind: 'child',
        parentId: 'boss',
        parentBasis: 'paseo',
        startedMinutesAgo: 20 - i,
      }),
    ),
  ];

  it('puts the captain first and keeps the helpers in the order they started', () => {
    const [room] = lay(null, crew(3)).rooms;
    expect(room?.characters.map((c) => [c.id, c.captain])).toEqual([
      ['boss', true],
      ['h0', false],
      ['h1', false],
      ['h2', false],
    ]);
  });

  it('draws up to five helpers and counts the rest on the bench', () => {
    const five = lay(null, crew(MAX_HELPERS)).rooms[0];
    expect(five?.characters).toHaveLength(6);
    expect(five?.bench).toBe(0);
    const eight = lay(null, crew(8)).rooms[0];
    expect(eight?.characters).toHaveLength(6);
    expect(eight?.bench).toBe(3);
    expect(eight?.detail).toBe('captain + 8');
  });

  it('is a room of one for a solo root, who is not a captain', () => {
    const [room] = lay(null, [solo('alone')]).rooms;
    expect(room?.characters).toHaveLength(1);
    expect(room?.characters[0]?.captain).toBe(false);
    expect(room?.detail).toBe('solo');
  });

  it('says on the sign when the parent is away, and for how long a solo agent has been idle', () => {
    const away = solo('orphan', { kind: 'child', parentAway: true });
    expect(lay(null, [away]).rooms[0]?.detail).toBe('parent away');
    const idle = solo('napper', { state: 'idle', activity: 'none', sinceMinutesAgo: 12 });
    expect(lay(null, [idle]).rooms[0]?.detail).toBe('idle 12 min');
    const orphanNapping = solo('orphan-napper', {
      kind: 'child',
      parentAway: true,
      state: 'idle',
      activity: 'none',
      sinceMinutesAgo: 12,
    });
    expect(lay(null, [orphanNapping]).rooms[0]?.detail).toBe('parent away · idle 12 min');
  });

  it('puts the session title on the sign, and where it runs (the repository, else the workspace) beside the state', () => {
    const sign = (a: Partial<HqAgent>) => {
      const room = lay(null, [solo('x', { repo: null, workspace: null, title: null, ...a })])
        .rooms[0];
      return [room?.name, room?.place];
    };
    expect(sign({ repo: 'kelvin/usage-metrics', title: 'Fix the login bug' })).toEqual([
      'Fix the login bug',
      'usage-metrics',
    ]);
    expect(sign({ workspace: 'scratch', title: 'Some title' })).toEqual(['Some title', 'scratch']);
    expect(sign({ repo: 'kelvin/usage-metrics', workspace: 'scratch', title: 'T' })).toEqual([
      'T',
      'usage-metrics',
    ]);
    expect(sign({ title: 'Some title' })).toEqual(['Some title', null]);
    // A title of only spaces is no title, and a title that is the place is not said twice.
    expect(sign({ repo: 'kelvin/usage-metrics', title: '   ' })).toEqual(['usage-metrics', null]);
    expect(sign({ repo: 'kelvin/usage-metrics', title: 'usage-metrics' })).toEqual([
      'usage-metrics',
      null,
    ]);
    expect(sign({ title: 'Two\n  lines' })).toEqual(['Two lines', null]);
  });

  it('names a room for the repository, then the workspace, when there is no title, and says nothing was recorded last', () => {
    const sign = (a: Partial<HqAgent>) => {
      const room = lay(null, [solo('x', { repo: null, workspace: null, title: null, ...a })])
        .rooms[0];
      return [room?.name, room?.place];
    };
    expect(sign({ repo: 'kelvin/usage-metrics' })).toEqual(['usage-metrics', null]);
    expect(sign({ workspace: 'scratch' })).toEqual(['scratch', null]);
    expect(sign({})).toEqual(['No name recorded', null]);
  });

  it('gives two chats in the same repository different signs', () => {
    const repo = 'kelvin/usage-metrics';
    const [a, b] = lay(null, [
      solo('chat-a', { repo, title: 'Fix the login bug', startedMinutesAgo: 20 }),
      solo('chat-b', { repo, title: 'Add the weekly digest', startedMinutesAgo: 10 }),
    ]).rooms;
    expect(a?.name).not.toBe(b?.name);
    expect([a?.place, b?.place]).toEqual([repo.split('/')[1], repo.split('/')[1]]);
  });
});

describe('pose, caption and mood', () => {
  const pose = (state: HqAgent['state'], activity: HqAgent['activity'] = 'none') =>
    poseOf({ state, activity });

  it('derives the pose from the state and the activity', () => {
    expect(pose('working', 'editing')).toBe('editing');
    expect(pose('working', 'reading')).toBe('reading');
    expect(pose('working', 'command')).toBe('command');
    expect(pose('working', 'thinking')).toBe('thinking');
    expect(pose('working', 'planning')).toBe('thinking');
    for (const activity of ['responding', 'delegating', 'tool', 'none'] as const) {
      expect(pose('working', activity)).toBe('working');
    }
    expect(pose('waiting')).toBe('waiting');
    expect(pose('idle')).toBe('idle');
    expect(pose('error')).toBe('error');
    expect(pose('finished')).toBe('finished');
    expect(pose('starting')).toBe('starting');
  });

  it('carries the provider as a shape and a short caption', () => {
    const [room] = lay(null, [
      solo('o', { provider: 'other', state: 'waiting', confidence: 'inferred' }),
    ]).rooms;
    expect(room?.characters[0]).toMatchObject({
      provider: 'other',
      pose: 'waiting',
      caption: 'needs you?',
    });
    expect(sceneCaption({ state: 'working', activity: 'command', confidence: 'reported' })).toBe(
      'running',
    );
    expect(sceneCaption({ state: 'idle', activity: 'none', confidence: 'reported' })).toBe('idle');
  });

  it('marks a room that needs the owner, then a room that is idle, then the rest', () => {
    const mood = (...states: HqAgent['state'][]) =>
      lay(null, [
        solo('boss'),
        ...states.map((state, i) =>
          solo(`h${i}`, { kind: 'child', parentId: 'boss', parentBasis: 'paseo', state }),
        ),
      ]).rooms[0]?.mood;
    expect(mood('waiting', 'idle')).toBe('needs');
    expect(mood('working')).toBe('normal');
    const sleepers = lay(null, [
      solo('a', { state: 'idle' }),
      solo('b', { kind: 'child', parentId: 'a', parentBasis: 'paseo', state: 'idle' }),
    ]);
    expect(sleepers.rooms[0]?.mood).toBe('idle');
    // Idle needs everyone idle: a finished agent beside an idle one is not an idle room.
    const mixed = lay(null, [
      solo('a', { state: 'idle' }),
      solo('b', { kind: 'child', parentId: 'a', parentBasis: 'paseo', state: 'finished' }),
    ]);
    expect(mixed.rooms[0]?.mood).toBe('normal');
  });
});

describe('the stage', () => {
  const characters = (n: number) =>
    lay(null, [
      solo('boss'),
      ...Array.from({ length: n - 1 }, (_, i) =>
        solo(`h${i}`, { kind: 'child', parentId: 'boss', parentBasis: 'paseo' }),
      ),
    ]).rooms[0]!.characters;

  it('draws a few characters at full size, with desks, and shrinks a crowd without desks', () => {
    const few = planStage(characters(3), 0, 760);
    expect(few.scale).toBe(1);
    expect(few.stations.some((s) => s.desk)).toBe(true);
    const crowd = planStage(characters(6), 0, 360);
    expect(crowd.scale).toBeLessThan(1);
    expect(crowd.stations.some((s) => s.desk)).toBe(false);
    // They stay inside the room, in order.
    const xs = crowd.stations.map((s) => s.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(xs[0]).toBeGreaterThan(0);
    expect(crowd.end).toBeLessThanOrEqual(360);
  });

  it('puts every other caption a line lower only when neighbours would collide', () => {
    expect(captionsCollide(characters(2), planStage(characters(2), 0, 420).stations, 13)).toBe(
      false,
    );
    expect(captionsCollide(characters(6), planStage(characters(6), 0, 290).stations, 13)).toBe(
      true,
    );
  });

  it('cuts a long name to the sign with an ellipsis', () => {
    expect(fit('usage-metrics', 126, 15)).toBe('usage-metrics');
    const cut = fit('a-very-long-repository-name-indeed', 126, 15);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.length).toBeLessThan(18);
  });
});

// The sign's two lines at each column count (a room is 290, 420 or 360 units wide at 1, 2 or 3 columns): the title on the first line,
// "place · state" on the second, and a room that needs the owner keeps both lines clear of its star.
describe.each([
  [1, 290],
  [2, 420],
  [3, 360],
] as const)('a sign %i column(s) wide', (_columns, roomWidth) => {
  const sign = signWidth(roomWidth);
  const TITLE = 15;
  const SMALL = 13;
  /** The width the estimate (0.54 em a character) gives a line, the same one `fit` cuts to. */
  const drawn = (text: string, size: number) => text.length * size * 0.54;
  const longTitle = 'Investigate why the nightly import job keeps timing out on large repositories';
  const longPlace = 'a-very-long-repository-name-indeed';

  it.each([false, true])('cuts a very long title with an ellipsis, star %s', (needs) => {
    const room = signTextWidth(sign, needs);
    const first = fit(longTitle, room, TITLE);
    expect(first.endsWith('…')).toBe(true);
    expect(longTitle.startsWith(first.slice(0, -1))).toBe(true);
    expect(drawn(first, TITLE)).toBeLessThanOrEqual(room);
    // A short title is left whole.
    expect(fit('Fix the bug', room, TITLE)).toBe('Fix the bug');
  });

  it.each([false, true])(
    'keeps the state when the place is long, and cuts the place first, star %s',
    (needs) => {
      const room = signTextWidth(sign, needs);
      for (const state of ['captain + 3', 'solo', 'idle 12 min', 'parent away']) {
        const line = fitSecondLine(longPlace, state, room, SMALL);
        expect(line.endsWith(state)).toBe(true);
        expect(drawn(line, SMALL)).toBeLessThanOrEqual(room);
        // Whatever is left of the place is a cut of it, ending in an ellipsis; or the place was left off for lack of room.
        if (line !== state) {
          const place = line.slice(0, line.length - state.length - 3);
          expect(place.endsWith('…')).toBe(true);
          expect(longPlace.startsWith(place.slice(0, -1))).toBe(true);
        }
      }
    },
  );

  it('keeps the place whole when the line has room for it, and leaves it off when it has none', () => {
    const room = signTextWidth(sign, false);
    expect(fitSecondLine('atlas-api', 'solo', room, SMALL)).toBe('atlas-api · solo');
    expect(fitSecondLine(null, 'idle 12 min', room, SMALL)).toBe('idle 12 min');
    // Not even "abc…" fits beside a state that takes all but a few characters of the line, so the line is the state alone.
    const chars = Math.floor(room / (SMALL * 0.54));
    const wide = 'x'.repeat(chars - 3);
    expect(fitSecondLine('usage-metrics', wide, room, SMALL)).toBe(wide);
  });

  it('gives a room with a star less width than one without', () => {
    expect(signTextWidth(sign, true)).toBeLessThan(signTextWidth(sign, false));
    // The star's left edge is 34 units in from the sign's right edge: the text ends before it.
    expect(12 + signTextWidth(sign, true)).toBeLessThanOrEqual(sign - 34);
  });
});
