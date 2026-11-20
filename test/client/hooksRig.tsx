// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import type { ClaudeHooksStatus, ExactPrompts } from '../../src/shared/contracts/hq';
import { createQueryClient } from '../../src/client/lib/queryClient';
import { emptyRoster } from '../fixtures/hq/scripted';

// A stubbed API for the screens that hold Claude Code's hooks switch (the Sources card and HQ's first-time dialog): GET /api/hq says whether
// the switch is on, GET and PUT /api/hq/claude-hooks are the server's preview and change. `mountRig(ui)` renders `ui` over it.

export const NOW = Date.parse('2026-11-04T17:42:00Z');

export const COMMAND =
  ': agent-productivity-hq-hook; if [ -x "/usr/local/bin/node" ] && [ -f "/data/claude-hooks/agent-productivity-hook.mjs" ]; then "/usr/local/bin/node" "/data/claude-hooks/agent-productivity-hook.mjs"; fi';
/** The fingerprint the server returns with every preview (64 hex characters); the page sends it back with the change. */
export const PREVIEW = 'ab'.repeat(32);
/** The actions each state offers, as the server does (turn on from off; turn off from on; repair and turn off from needs_repair). */
export const OFFERED: Record<ExactPrompts, ('on' | 'off' | 'repair')[]> = {
  off: ['on'],
  on: ['off'],
  needs_repair: ['repair', 'off'],
  unavailable: [],
};
/**
 * A status as the server sends it. Each offered action has its own plan: turning off lists only the files that hold HQ's entries; the
 * others list the files they write. `plans` and `preview` can be given to say otherwise.
 */
export const status = (over: Partial<ClaudeHooksStatus> = {}): ClaudeHooksStatus => {
  const base: ClaudeHooksStatus = {
    state: 'off',
    reason: null,
    files: [{ path: '~/.claude/settings.json', exists: true, state: 'absent', reason: null }],
    events: ['PermissionRequest', 'Notification', 'Stop', 'SessionStart', 'SessionEnd'],
    command: COMMAND,
    preview: PREVIEW,
    plans: {},
    leftover: null,
    ownFolder: '~/data/claude-hooks',
    ...over,
  };
  const plans: ClaudeHooksStatus['plans'] = {};
  for (const action of OFFERED[base.state])
    plans[action] = {
      preview: base.preview,
      files:
        action === 'off'
          ? base.files.filter((file) => file.state === 'present' || file.state === 'needs_repair')
          : base.files,
      ownFiles: [],
    };
  return { ...base, plans: over.plans ?? plans };
};
export const json = (body: unknown, code = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status: code,
      headers: { 'content-type': 'application/json' },
    }),
  );

export interface Rig {
  state: ExactPrompts;
  preview: () => Promise<Response>;
  put: (enabled: boolean) => Promise<Response>;
  roster: () => unknown;
  calls: { method: string; path: string; body: unknown; headers: Record<string, string> }[];
}

export function mountRig(ui: ReactElement, over: Partial<Rig> = {}) {
  const rig: Rig = {
    state: 'off',
    preview: () => json(status({ state: rig.state })),
    put: (enabled) => json(status({ state: enabled ? 'on' : 'off' })),
    roster: () => emptyRoster(NOW),
    calls: [],
    ...over,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      rig.calls.push({
        method,
        path: url,
        body,
        headers: (init.headers ?? {}) as Record<string, string>,
      });
      if (url === '/api/hq') return json({ ...(rig.roster() as object), exactPrompts: rig.state });
      if (url === '/api/hq/claude-hooks' && method === 'GET') return rig.preview();
      if (url === '/api/hq/claude-hooks' && method === 'PUT') {
        const enabled = (body as { enabled: boolean }).enabled;
        const answer = rig.put(enabled);
        return answer.then((response) => {
          if (response.ok) rig.state = enabled ? 'on' : 'off';
          return response;
        });
      }
      return json({}, 404);
    }),
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
  return rig;
}
