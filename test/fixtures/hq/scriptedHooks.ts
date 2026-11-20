import { createHash } from 'node:crypto';
import { CLAUDE_HOOK_EVENTS, type ClaudeHooksStatus } from '../../../src/shared/contracts/hq.ts';
import {
  ClaudeHooksError,
  type ClaudeHooks,
  type HooksFailure,
} from '../../../src/server/integrations/claudeHooks/index.ts';
import { hookPaths } from '../../../src/server/integrations/claudeHooks/paths.ts';

// A scripted Claude Code hooks switch: an `ClaudeHooks` whose state a spec sets and whose `set` only flips it in memory, so the page's
// preview, switch and refusals can be exercised in a browser without any settings file. Nothing on this computer is read or written.

export type ScriptedHooksScenario = 'off' | 'on' | 'needs_repair' | 'unavailable' | 'blocked';

export interface ScriptedHooks extends ClaudeHooks {
  /** The requests made to turn it on (`true`) or off (`false`), in order. */
  readonly changes: boolean[];
  /** The next `set` fails with this fixed code (once). */
  failNext(failure: HooksFailure): void;
}

const COMMAND =
  ': agent-productivity-hq-hook; if [ -x "/usr/local/bin/node" ] && [ -f "/Users/example/Library/Application Support/Agent Productivity/claude-hooks/agent-productivity-hook.mjs" ]; then "/usr/local/bin/node" "/Users/example/Library/Application Support/Agent Productivity/claude-hooks/agent-productivity-hook.mjs"; fi';

export function createScriptedHooks(initial: ScriptedHooksScenario = 'off'): ScriptedHooks {
  let scenario = initial;
  let failure: HooksFailure | null = null;
  const changes: boolean[] = [];
  /** What the real preview fingerprints, in miniature: it changes whenever the scenario does. */
  const preview = (): string => createHash('sha256').update(`scripted:${scenario}`).digest('hex');
  const status = (): ClaudeHooksStatus => {
    const base = {
      events: [...CLAUDE_HOOK_EVENTS],
      command: COMMAND,
      preview: preview(),
      leftover: null,
      ownFolder: '~/Library/Application Support/Agent Productivity/claude-hooks',
    };
    if (scenario === 'unavailable')
      return { ...base, state: 'unavailable', reason: 'no_claude_folder', files: [], plans: {} };
    if (scenario === 'blocked')
      return {
        ...base,
        state: 'unavailable',
        reason: 'settings_blocked',
        files: [
          { path: '~/.claude/settings.json', exists: true, state: 'blocked', reason: 'not_json' },
        ],
        plans: {},
      };
    const entries = scenario === 'on' ? 'present' : scenario === 'off' ? 'absent' : 'needs_repair';
    const files = [
      { path: '~/.claude/settings.json', exists: true, state: entries, reason: null },
    ] as const;
    // Each offered action has its own plan and fingerprint, as the real switch's do.
    const plan = (action: string) => ({
      preview: createHash('sha256').update(`scripted:${scenario}:${action}`).digest('hex'),
      files: [...files],
      ownFiles: [],
    });
    const plans: ClaudeHooksStatus['plans'] =
      scenario === 'off'
        ? { on: plan('on') }
        : scenario === 'on'
          ? { off: plan('off') }
          : { repair: plan('repair'), off: plan('off') };
    const first = scenario === 'off' ? plans.on : scenario === 'on' ? plans.off : plans.repair;
    return {
      ...base,
      state: scenario,
      reason: null,
      files: [...files],
      preview: first?.preview ?? base.preview,
      plans,
    };
  };
  return {
    paths: hookPaths('/scripted/data'),
    changes,
    failNext: (next) => {
      failure = next;
    },
    status: async () => status(),
    state: async () => status().state,
    set: async (enabled, options) => {
      // As the real switch: a change is made only for the plan of this action that was shown (turn off; else repair, or turn on).
      const plans = status().plans;
      const confirmed = enabled ? (scenario === 'off' ? plans.on : plans.repair) : plans.off;
      if (options?.preview !== undefined && options.preview !== confirmed?.preview)
        throw new ClaudeHooksError('stale_preview');
      changes.push(enabled);
      if (failure !== null) {
        const next = failure;
        failure = null;
        throw new ClaudeHooksError(next);
      }
      scenario = enabled ? 'on' : 'off';
      return status();
    },
    listening: async () => undefined,
    close: async () => undefined,
  };
}
