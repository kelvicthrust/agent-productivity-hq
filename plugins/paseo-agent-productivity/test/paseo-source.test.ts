import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginHandlerContext } from '@getpaseo/plugin/server';
import { paseoSource } from '../server/paseo-source.ts';

test('passes the priority and attention filters and projects only the allowed work metadata', async () => {
  const options = {
    filter: { includeArchived: false, requiresAttention: true },
    sort: [
      { key: 'status_priority', direction: 'asc' },
      { key: 'updated_at', direction: 'desc' },
    ],
    page: { limit: 60 },
  };
  const pageInfo = { hasMore: false, nextCursor: null };
  const paseo = {
    agents: {
      list: async (received: unknown) => {
        assert.deepEqual(received, {
          ...options,
          filter: { ...options.filter, includeBackground: true },
        });
        return {
          entries: [
            {
              agent: {
                id: 'agent',
                lastUserMessageAt: null,
                persistence: { provider: 'codex', sessionId: 'private-saved-session' },
                activeTurn: { startedAt: null, turnId: 'private-turn' },
                backgroundWork: { count: 1, description: 'private-process' },
                requiresAttention: true,
              },
            },
            { agent: { id: 'empty', lastUserMessageAt: null, persistence: null } },
            { agent: { id: 'unknown' } },
          ],
          pageInfo,
        };
      },
    },
  } as unknown as PluginHandlerContext['paseo'];

  assert.deepEqual(await paseoSource(paseo)({ kind: 'agents', options }), {
    entries: [
      {
        agent: {
          id: 'agent',
          lastUserMessageAt: null,
          persistence: { provider: 'codex' },
          activeTurn: { startedAt: null },
          backgroundWork: { count: 1 },
          requiresAttention: true,
          labels: {},
        },
      },
      { agent: { id: 'empty', lastUserMessageAt: null, persistence: null, labels: {} } },
      { agent: { id: 'unknown', labels: {} } },
    ],
    pageInfo,
  });
});
