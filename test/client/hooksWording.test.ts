import { describe, expect, it } from 'vitest';
import { HOOKS_COPY } from '../../src/client/lib/hooksCopy.ts';
import { hooksApiError } from '../../src/server/http/routes/hqHooks.ts';
import { ClaudeHooksError } from '../../src/server/integrations/claudeHooks/errors.ts';
import { ClaudeHooksFileReason, ClaudeHooksStatus } from '../../src/shared/contracts/hq.ts';

// Every fixed code and every reason the server can give has words on the page, and words in the refusal.

describe('every reason the server reports has page wording', () => {
  const reasons = ClaudeHooksStatus.shape.reason.unwrap().options;
  it.each(reasons)('status reason %s', (reason) => {
    const note = HOOKS_COPY.reasonNote(reason, '~/data/claude-hooks');
    expect(note, reason).toBeTruthy();
    expect(note).not.toMatch(/undefined|_/);
  });

  it.each(ClaudeHooksFileReason.options)('file reason %s', (reason) => {
    expect(HOOKS_COPY.blocked[reason]).toBeTruthy();
    expect(hooksApiError(new ClaudeHooksError(reason)).message).toBeTruthy();
  });

  it.each([
    'conflict',
    'no_folder',
    'stale_preview',
    'registry_failed',
    'rollback_failed',
    'unsupported_path',
  ] as const)('refusal %s', (failure) => {
    const error = hooksApiError(new ClaudeHooksError(failure, ['~/.claude/settings.json']));
    expect(error.message.length).toBeGreaterThan(20);
    expect(error.message).not.toMatch(/undefined/);
  });
});
