import { describe, expect, it } from 'vitest';
import {
  HOOK_MARKER,
  buildHookCommand,
  isHookCommand,
  parseHookCommand,
} from '../../src/server/integrations/claudeHooks/command.ts';

const SCRIPT =
  '/Users/me/Library/Application Support/agent/claude-hooks/agent-productivity-hook.mjs';

describe('the hook command', () => {
  it('has the documented shape and round-trips the Node and the script', () => {
    const command = buildHookCommand('/usr/local/bin/node', SCRIPT);
    expect(command).toBe(
      `${HOOK_MARKER} if [ -x "/usr/local/bin/node" ] && [ -f "${SCRIPT}" ]; then "/usr/local/bin/node" "${SCRIPT}"; fi`,
    );
    expect(parseHookCommand(command)).toEqual({ node: '/usr/local/bin/node', script: SCRIPT });
  });

  it('quotes a path with a quote or a dollar sign so the shell reads it as one word, and still recognises it', () => {
    const script = `/tmp/it's $HOME/claude-hooks/agent-productivity-hook.mjs`;
    const command = buildHookCommand(`/opt/no de/node`, script);
    expect(command).toContain(`'/tmp/it'\\''s $HOME/claude-hooks/agent-productivity-hook.mjs'`);
    expect(parseHookCommand(command)).toEqual({ node: '/opt/no de/node', script });
  });

  it('is recognised for any data folder and Node (an older install is still HQ’s)', () => {
    const old = buildHookCommand('/old/node', '/old/data/claude-hooks/agent-productivity-hook.mjs');
    expect(isHookCommand(old)).toBe(true);
  });

  it.each([
    ['a plain user command', 'say done'],
    ['the marker alone', HOOK_MARKER],
    ['a command that only mentions the script', `node ${SCRIPT}`],
    ['another script name', buildHookCommand('/n', '/x/claude-hooks/other.mjs')],
    [
      'a script name that merely ends the same',
      buildHookCommand('/n', '/x/not-agent-productivity-hook.mjs'),
    ],
    [
      'a hand-edited command (something appended)',
      `${buildHookCommand('/n', SCRIPT)} && curl example.com`,
    ],
    [
      'a command that runs a different script than it tests',
      `${HOOK_MARKER} if [ -x "/n" ] && [ -f "/a/agent-productivity-hook.mjs" ]; then "/n" "/b/agent-productivity-hook.mjs"; fi`,
    ],
    ['a number', 5],
    ['nothing', undefined],
    ['a very long string', `${HOOK_MARKER} ${'x'.repeat(5000)}`],
  ])('does not treat %s as HQ’s', (_name, command) => {
    expect(isHookCommand(command)).toBe(false);
  });
});
