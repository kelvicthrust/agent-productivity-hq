import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ErrorEnvelope } from '../../src/shared/contracts/errors.ts';
import { ClaudeHooksFileReason } from '../../src/shared/contracts/hq.ts';
import {
  ClaudeHooksError,
  type HooksFailure,
  type LeftBehind,
} from '../../src/server/integrations/claudeHooks/index.ts';
import { BACKUP_SUFFIX } from '../../src/server/integrations/claudeHooks/paths.ts';
import { rig, asText } from '../claudeHooks/helpers.ts';
import { HOST, WRITE, call, testApp } from './helpers.ts';

// The rule (local API › PUT /api/hq/claude-hooks): ONE builder makes every refusal of an action, so whatever code it carries, the same
// `details.left` and the same closing sentence name everything HQ made and left behind, and the page shows the message.

const FAILURES: HooksFailure[] = [
  ...ClaudeHooksFileReason.options,
  'conflict',
  'no_folder',
  'stale_preview',
  'registry_failed',
  'rollback_failed',
  'unsupported_path',
];
const LEFT: LeftBehind[][] = [
  [],
  ['backup'],
  ['script'],
  ['registry', 'temp'],
  ['script', 'registry', 'backup', 'temp'],
];
const WORDS: Record<LeftBehind, string> = {
  script: 'its hook script',
  registry: 'its registry file',
  backup: 'the copy of your settings it made',
  temp: 'a temporary file',
};

const put = async (error: ClaudeHooksError) => {
  const r = rig({ settings: '{}' });
  const throwing = {
    ...r.hooks,
    paths: r.hooks.paths,
    status: r.hooks.status,
    state: r.hooks.state,
    set: () => Promise.reject(error),
  };
  const { app } = testApp({ claudeHooks: throwing });
  const res = await call(app, '/api/hq/claude-hooks', {
    method: 'PUT',
    headers: WRITE,
    body: JSON.stringify({ enabled: true, preview: 'a'.repeat(64) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    text,
    error: ErrorEnvelope.parse(JSON.parse(text)).error,
    root: r.root,
  };
};

describe('every refusal of an action names what it left behind', () => {
  for (const failure of FAILURES) {
    for (const left of LEFT) {
      it(`${failure}, left ${left.length === 0 ? 'nothing' : left.join('+')}`, async () => {
        const files = failure === 'rollback_failed' ? ['~/.claude/settings.json'] : [];
        const sent = await put(new ClaudeHooksError(failure, files, left));
        const { error } = sent;
        if (left.length === 0) {
          expect(error.details?.['left']).toBeUndefined();
          expect(error.message).not.toMatch(/HQ left (its|the copy|a temporary)/);
        } else {
          expect(error.details?.['left']).toEqual(left);
          expect(error.message).toMatch(/HQ left (its|the copy|a temporary)/);
          for (const item of left) expect(error.message).toContain(WORDS[item]);
          expect(error.message).toContain('You can delete it.');
        }
        // a fixed answer: no path, and no text of any file
        expect(sent.text).not.toContain(sent.root);
        expect(sent.text).not.toContain('/Users');
        expect(error.code).toMatch(/^claude_/);
      });
    }
  }

  it('the code and status of each failure do not depend on what was left', async () => {
    for (const failure of FAILURES) {
      const plain = await put(new ClaudeHooksError(failure, [], []));
      const left = await put(new ClaudeHooksError(failure, [], ['backup', 'temp']));
      expect(left.status).toBe(plain.status);
      expect(left.error.code).toBe(plain.error.code);
      expect(left.error.message.startsWith(plain.error.message)).toBe(true);
    }
  });
});

describe('through the real switch', () => {
  it('a stale plan after the owner saved while HQ held a copy: 409 claude_hooks_stale, with the copy named', async () => {
    const r = rig({ settings: asText({ a: 1 }) });
    const backup = `${r.settings}${BACKUP_SUFFIX}`;
    const hooks = r.another({
      onStep: (step) => {
        if (step !== 'after_backup') return;
        writeFileSync(r.settings, asText({ a: 2 }));
        writeFileSync(backup, asText({ saved: 'copy' }));
      },
    });
    const { app } = testApp({ claudeHooks: hooks });
    const shown = (await (await call(app, '/api/hq/claude-hooks', { headers: HOST })).json()) as {
      preview: string;
    };
    const res = await call(app, '/api/hq/claude-hooks', {
      method: 'PUT',
      headers: WRITE,
      body: JSON.stringify({ enabled: true, preview: shown.preview }),
    });
    expect(res.status).toBe(409);
    const { error } = ErrorEnvelope.parse(await res.json());
    expect(error.code).toBe('claude_hooks_stale');
    expect(error.details).toMatchObject({ left: ['backup'] });
    expect(error.message).toContain('the copy of your settings it made');
  });
});
