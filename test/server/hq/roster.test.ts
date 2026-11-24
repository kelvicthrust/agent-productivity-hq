import { describe, expect, it } from 'vitest';
import { HqAgent } from '../../../src/shared/contracts/hq.ts';
import {
  ROSTER_CAP,
  buildRoster,
  createKeyMemo,
  rosterId,
} from '../../../src/server/services/hq/roster.ts';
import { NOW, liveAgent } from '../../collectors/paseo/liveHelpers.ts';

const MIN = 60_000;
const build = (
  agents: Parameters<typeof liveAgent>[0][],
  extra: Partial<Parameters<typeof buildRoster>[0]> = {},
) => buildRoster({ agents: agents.map(liveAgent), now: NOW, ...extra });
const byTitle = (roster: ReturnType<typeof buildRoster>, title: string) => {
  const found = roster.agents.find((agent) => agent.title === title);
  if (!found) throw new Error(`no agent titled ${title}`);
  return found;
};

describe('rosterId', () => {
  it('is opaque, stable, short and different per agent', () => {
    const id = rosterId('a0000000-0000-4000-8000-000000000001');
    expect(id).toMatch(/^a[0-9a-f]{12}$/);
    expect(rosterId('a0000000-0000-4000-8000-000000000001')).toBe(id);
    expect(rosterId('a0000000-0000-4000-8000-000000000002')).not.toBe(id);
    expect(id).not.toContain('a0000000');
  });

  it('stays the same for an agent from poll to poll, whatever else changes', () => {
    const first = build([{ id: 'x', title: 'one', status: 'running' }]).agents[0]?.id;
    const later = build([{ id: 'x', title: 'renamed', status: 'idle' }, { id: 'y' }]).agents.find(
      (agent) => agent.title === 'renamed',
    )?.id;
    expect(later).toBe(first);
  });
});

describe('buildRoster', () => {
  it('turns a live agent into the contract shape, field by field', () => {
    const roster = build(
      [
        {
          id: 'a-1',
          provider: 'claude',
          title: 'Fix the thing',
          cwd: '/Users/someone/code/widgets',
          workspaceName: 'widgets main',
          status: 'running',
          turnStartedAt: NOW - 3 * MIN,
          updatedAt: NOW - 10_000,
          createdAt: NOW - 20 * MIN,
        },
      ],
      { repoOf: (cwd) => (cwd === '/Users/someone/code/widgets' ? 'acme/widgets' : null) },
    );
    expect(roster.agents).toEqual([
      {
        id: rosterId('a-1'),
        provider: 'claude',
        kind: 'root',
        parentId: null,
        parentBasis: null,
        parentAway: false,
        title: 'Fix the thing',
        repo: 'acme/widgets',
        workspace: 'widgets main',
        state: 'working',
        activity: 'none',
        waitReason: null,
        confidence: 'reported',
        since: new Date(NOW - 3 * MIN).toISOString(),
        lastActivityAt: new Date(NOW - 10_000).toISOString(),
        startedAt: new Date(NOW - 20 * MIN).toISOString(),
        seenBy: { paseo: true, transcript: false },
      },
    ]);
    expect(HqAgent.parse(roster.agents[0])).toEqual(roster.agents[0]);
    expect(roster.truncated).toBe(false);
  });

  it('names the workspace from Paseo, else the last folder of the working directory, else nothing', () => {
    const roster = build([
      { id: 'a', title: 'with name', workspaceName: 'Named', cwd: '/x/y/z' },
      { id: 'b', title: 'from folder', cwd: '/x/y/project/' },
      { id: 'c', title: 'windows', cwd: 'C:\\code\\thing' },
      { id: 'd', title: 'neither', cwd: null },
    ]);
    expect(byTitle(roster, 'with name').workspace).toBe('Named');
    expect(byTitle(roster, 'from folder').workspace).toBe('project');
    expect(byTitle(roster, 'windows').workspace).toBe('thing');
    expect(byTitle(roster, 'neither').workspace).toBeNull();
  });

  it('maps unknown providers to other, and leaves repo null without a resolver', () => {
    const roster = build([
      { id: 'a', provider: 'gemini' },
      { id: 'b', provider: 'codex/gpt-x', title: 'codex' },
    ]);
    expect(roster.agents.map((agent) => agent.provider).sort()).toEqual(['codex', 'other']);
    expect(roster.agents.every((agent) => agent.repo === null)).toBe(true);
  });

  it('leaves agents that are not shown off the roster', () => {
    const roster = build([
      { id: 'a', title: 'shown' },
      { id: 'b', updatedAt: NOW - 31 * MIN },
      { id: 'c', archived: true },
    ]);
    expect(roster.agents.map((agent) => agent.title)).toEqual(['shown']);
  });

  it('omits a confirmed-empty crew, then shows the thread with the same id on its first turn', () => {
    const memo = createKeyMemo();
    const blank = { id: 'blank', title: 'blank', reportsEmptyThread: true };
    expect(
      build([blank, { ...blank, id: 'child', parentAgentId: 'blank' }], { memo }).agents,
    ).toEqual([]);
    const running = build(
      [{ ...blank, status: 'running', sessionId: 'provider-session', reportsEmptyThread: false }],
      { memo },
    );
    expect(byTitle(running, 'blank')).toMatchObject({ id: rosterId('blank'), state: 'working' });
  });

  it('keeps the parent of an active child and excludes unrelated empty threads before applying the cap', () => {
    const filler = Array.from({ length: ROSTER_CAP + 4 }, (_, i) => ({
      id: `blank-${i}`,
      reportsEmptyThread: true,
    }));
    const roster = build([
      ...filler,
      { id: 'parent', title: 'parent', reportsEmptyThread: true },
      { id: 'child', title: 'child', parentAgentId: 'parent', status: 'running' },
    ]);
    expect(roster.truncated).toBe(false);
    expect(roster.agents).toHaveLength(2);
    expect(byTitle(roster, 'child').parentId).toBe(byTitle(roster, 'parent').id);
  });

  it('keeps an expired parent linked while its crew has work, then drops it without reviving other idle rows', () => {
    const memo = createKeyMemo();
    const parent = { id: 'parent', title: 'parent', updatedAt: NOW - 29 * MIN };
    const orphan = { id: 'unrelated', updatedAt: NOW - 33 * MIN };
    const child = { id: 'child', title: 'child', status: 'running', parentAgentId: 'parent' };
    const first = build([parent, orphan, child], { memo });
    const later = build([parent, orphan, child], { memo, now: NOW + 2 * MIN });
    expect(later.agents).toHaveLength(2);
    expect(byTitle(later, 'parent').id).toBe(byTitle(first, 'parent').id);
    expect(byTitle(later, 'child').parentId).toBe(byTitle(first, 'parent').id);

    const ended = build([parent, orphan, { ...child, status: 'idle' }], {
      memo,
      now: NOW + 2 * MIN,
    });
    expect(ended.agents).toHaveLength(1);
    expect(byTitle(ended, 'child')).toMatchObject({ parentId: null, parentAway: true });
  });

  it('prioritizes work and unread results over newer recent agents, keeping available parents', () => {
    const filler = Array.from({ length: ROSTER_CAP }, (_, i) => ({
      id: `idle-${i}`,
      updatedAt: NOW,
    }));
    const roster = build([
      ...filler,
      { id: 'parent', title: 'parent', reportsEmptyThread: true },
      { id: 'child', title: 'child', parentAgentId: 'parent', status: 'running' },
      {
        id: 'review',
        title: 'review',
        requiresAttention: true,
        attentionReason: 'finished',
        updatedAt: NOW - 45 * MIN,
      },
      {
        id: 'error',
        title: 'error',
        requiresAttention: true,
        attentionReason: 'error',
        updatedAt: NOW - 45 * MIN,
      },
      {
        id: 'background',
        title: 'background',
        backgroundWorkActive: true,
        updatedAt: NOW - 45 * MIN,
      },
    ]);
    expect(roster.truncated).toBe(true);
    expect(byTitle(roster, 'child').parentId).toBe(byTitle(roster, 'parent').id);
    expect(byTitle(roster, 'review')).toMatchObject({ state: 'finished', reviewPending: true });
    expect(byTitle(roster, 'error')).toMatchObject({ state: 'error', reviewPending: true });
    expect(byTitle(roster, 'background')).toMatchObject({
      state: 'idle',
      backgroundWorkActive: true,
    });
  });

  it('reports an acknowledged error distinctly from legacy errors and later unread completions', () => {
    const completion = { id: 'done', title: 'done', attentionReason: 'finished' };
    expect(byTitle(build([{ ...completion, requiresAttention: true }]), 'done').reviewPending).toBe(
      true,
    );
    expect(
      byTitle(build([{ ...completion, requiresAttention: false, attentionReason: null }]), 'done')
        .reviewPending,
    ).toBeUndefined();
    expect(byTitle(build([{ ...completion, requiresAttention: true }]), 'done').reviewPending).toBe(
      true,
    );
    const acknowledged = { id: 'error', title: 'error', status: 'error' };
    expect(
      byTitle(build([{ ...acknowledged, requiresAttention: false }]), 'error').reviewPending,
    ).toBe(false);
    expect(byTitle(build([acknowledged]), 'error').reviewPending).toBeUndefined();
  });

  describe('parents', () => {
    it('links a child to its parent when the parent is on the roster', () => {
      const roster = build([
        { id: 'p', title: 'parent', status: 'running' },
        { id: 'c', title: 'child', parentAgentId: 'p', status: 'running' },
      ]);
      const parent = byTitle(roster, 'parent');
      expect(parent).toMatchObject({ kind: 'root', parentId: null, parentAway: false });
      expect(byTitle(roster, 'child')).toMatchObject({
        kind: 'child',
        parentId: parent.id,
        parentBasis: 'paseo',
        parentAway: false,
      });
    });

    it('a child whose parent is not on the roster is a child with its parent away, and no edge is invented', () => {
      const roster = build([
        { id: 'c', title: 'orphan', parentAgentId: 'gone' },
        // Not on the roster because it is archived: still away.
        { id: 'x', title: 'also', parentAgentId: 'arch' },
        { id: 'arch', archived: true },
      ]);
      expect(byTitle(roster, 'orphan')).toMatchObject({
        kind: 'child',
        parentId: null,
        parentBasis: 'paseo',
        parentAway: true,
      });
      expect(byTitle(roster, 'also').parentAway).toBe(true);
    });

    it('a parent cut by the cap leaves its child with the parent away', () => {
      const filler = Array.from({ length: ROSTER_CAP }, (_, index) => ({
        id: `w-${index}`,
        status: 'running',
      }));
      const roster = build([
        ...filler,
        { id: 'p', title: 'idle parent', status: 'idle' },
        { id: 'c', title: 'working child', parentAgentId: 'p', status: 'running' },
      ]);
      expect(roster.agents.find((agent) => agent.title === 'idle parent')).toBeUndefined();
      // The child is working and was ranked in; the idle parent was cut.
      expect(byTitle(roster, 'working child')).toMatchObject({
        kind: 'child',
        parentId: null,
        parentAway: true,
      });
    });

    it('refuses labels that lead into a cycle and still lists the agents', () => {
      const roster = build([
        { id: 'a', title: 'a', parentAgentId: 'b' },
        { id: 'b', title: 'b', parentAgentId: 'a' },
        { id: 'c', title: 'tail', parentAgentId: 'a' },
        { id: 'self', title: 'self', parentAgentId: 'self' },
      ]);
      expect(roster.agents).toHaveLength(4);
      for (const title of ['a', 'b', 'tail', 'self']) {
        expect(byTitle(roster, title)).toMatchObject({
          kind: 'root',
          parentId: null,
          parentBasis: null,
          parentAway: false,
        });
      }
    });

    it('a three-agent chain is linked parent by parent', () => {
      const roster = build([
        { id: 'g', title: 'grand' },
        { id: 'p', title: 'mid', parentAgentId: 'g' },
        { id: 'c', title: 'leaf', parentAgentId: 'p' },
      ]);
      expect(byTitle(roster, 'leaf').parentId).toBe(byTitle(roster, 'mid').id);
      expect(byTitle(roster, 'mid').parentId).toBe(byTitle(roster, 'grand').id);
    });
  });

  describe('order and cap', () => {
    it('lists waiting, then error, then working or starting, then the rest', () => {
      const roster = build([
        { id: 'idle', title: 'idle', status: 'idle' },
        { id: 'work-old', title: 'work-old', status: 'running', updatedAt: NOW - 5 * MIN },
        { id: 'work-new', title: 'work-new', status: 'running', updatedAt: NOW - 1 * MIN },
        { id: 'err', title: 'err', status: 'error' },
        { id: 'wait', title: 'wait', pendingPermissionKind: 'tool' },
        { id: 'start', title: 'start', status: 'initializing' },
      ]);
      expect(roster.agents.map((agent) => agent.title)).toEqual([
        'wait',
        'err',
        'start',
        'work-new',
        'work-old',
        'idle',
      ]);
    });

    it('is the same order every time for the same agents, whatever order they arrive in', () => {
      const agents = Array.from({ length: 8 }, (_, index) => ({
        id: `a-${index}`,
        title: `t${index}`,
        status: 'running',
      }));
      const forward = build(agents).agents.map((agent) => agent.id);
      const backward = build([...agents].reverse()).agents.map((agent) => agent.id);
      expect(backward).toEqual(forward);
    });

    it('cuts to 60 keeping the most urgent, and says it was cut', () => {
      const agents = [
        ...Array.from({ length: 70 }, (_, index) => ({ id: `i-${index}`, status: 'idle' })),
        { id: 'urgent', title: 'urgent', pendingPermissionKind: 'tool' },
      ];
      const roster = build(agents);
      expect(roster.agents).toHaveLength(ROSTER_CAP);
      expect(roster.agents[0]?.title).toBe('urgent');
      expect(roster.truncated).toBe(true);
    });

    it('exactly 60 is not truncated, and a daemon with more than one page is', () => {
      const sixty = Array.from({ length: ROSTER_CAP }, (_, index) => ({ id: `i-${index}` }));
      expect(build(sixty).truncated).toBe(false);
      expect(build(sixty, { pageTruncated: true }).truncated).toBe(true);
    });
  });

  it('keeps the wait reason and the attention time for a waiting agent', () => {
    const roster = build([
      {
        id: 'a',
        title: 'asks',
        status: 'running',
        pendingPermissionKind: 'plan',
        attentionAt: NOW - 2 * MIN,
      },
    ]);
    expect(roster.agents[0]).toMatchObject({
      state: 'waiting',
      waitReason: 'plan_approval',
      since: new Date(NOW - 2 * MIN).toISOString(),
    });
  });
});
