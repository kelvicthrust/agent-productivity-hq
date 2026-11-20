import { describe, expect, it } from 'vitest';
import { HqResponse, HqRoster } from '../../src/shared/contracts/hq.ts';
import { createScriptedHq, emptyRoster, officeRoster } from '../fixtures/hq/scripted.ts';
import { HOST, NOW, WRITE, call, testApp } from './helpers.ts';

describe('GET /api/hq', () => {
  it('with no live feeder answers 200 with every feed unavailable, nobody on the roster and nothing cut', async () => {
    const { app } = testApp();
    const res = await call(app, '/api/hq', { headers: HOST });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = HqResponse.parse(await res.json());
    expect(body).toEqual({
      generatedAt: new Date(NOW).toISOString(),
      feeds: [
        { id: 'paseo', status: 'unavailable' },
        { id: 'claude', status: 'unavailable' },
        { id: 'codex', status: 'unavailable' },
      ],
      agents: [],
      truncated: false,
      // No Claude Code integration in this process: the hooks switch is not available.
      exactPrompts: 'unavailable',
    });
  });

  it('answers from the roster service it is given, taking a fresh snapshot per request', async () => {
    const hq = createScriptedHq(officeRoster(NOW));
    const { app } = testApp({ hq });
    const first = HqResponse.parse(await (await call(app, '/api/hq', { headers: HOST })).json());
    expect(first.agents).toHaveLength(8);
    expect(first.feeds.every((feed) => feed.status === 'live')).toBe(true);
    expect(hq.snapshots).toBe(1);

    hq.set(emptyRoster(NOW));
    const second = HqResponse.parse(await (await call(app, '/api/hq', { headers: HOST })).json());
    expect(second.agents).toEqual([]);
    expect(hq.snapshots).toBe(2);
  });

  it('keeps the guards: a wrong Host is refused, and the route takes no write', async () => {
    const { app } = testApp({ hq: createScriptedHq(officeRoster(NOW)) });
    expect((await call(app, '/api/hq', { headers: { host: 'evil.example' } })).status).toBe(421);
    const post = await call(app, '/api/hq', { method: 'POST', headers: WRITE, body: '{}' });
    expect(post.status).toBe(404);
  });

  it('answers a failing roster service with the internal error envelope, never its message', async () => {
    const { app } = testApp({
      hq: {
        snapshot: async () => {
          throw new Error('secret prompt text');
        },
        close: async () => undefined,
      },
    });
    const res = await call(app, '/api/hq', { headers: HOST });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret prompt text');
  });
});

describe('the scripted office roster', () => {
  it('is four sessions and eight agents that satisfy the contract', () => {
    const roster = HqRoster.parse(officeRoster(NOW));
    expect(roster.agents).toHaveLength(8);
    expect(roster.agents.filter((agent) => agent.kind === 'root')).toHaveLength(4);
    const ids = new Set(roster.agents.map((agent) => agent.id));
    for (const agent of roster.agents)
      if (agent.parentId !== null) expect(ids.has(agent.parentId)).toBe(true);
  });
});
