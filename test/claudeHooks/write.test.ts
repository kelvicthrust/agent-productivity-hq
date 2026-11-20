import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeHooksError } from '../../src/server/integrations/claudeHooks/errors.ts';
import { editSettings } from '../../src/server/integrations/claudeHooks/write.ts';
import { names, rig } from './helpers.ts';

// The race the write guards against: the file changes after it was read and before it is replaced. The `edit` callback runs between
// the read and the re-read, so a change made inside it is exactly a change made by someone else in that window.

const options = (settings: string) => ({
  backup: `${settings}.backup`,
  pause: async () => undefined,
});
const outcome = async (run: () => Promise<unknown>) => {
  try {
    return await run();
  } catch (error) {
    return error instanceof ClaudeHooksError ? error.failure : error;
  }
};

describe('a file that changes between the read and the write', () => {
  it('is not overwritten: the change is computed again from what is there now', async () => {
    const r = rig({ settings: '{"a":1}' });
    let calls = 0;
    const result = await editSettings(
      r.settings,
      (text) => {
        calls += 1;
        if (calls === 1) writeFileSync(r.settings, '{"a":1,"theirs":true}'); // someone else saves
        return `${text}|mine`;
      },
      options(r.settings),
    );
    expect(result).toBe('changed');
    expect(calls).toBe(2);
    // The second attempt was computed from their file, so nothing of theirs is lost.
    expect(readFileSync(r.settings, 'utf8')).toBe('{"a":1,"theirs":true}|mine');
    expect(names(r.config)).toEqual(['settings.json', 'settings.json.backup']);
    expect(readFileSync(`${r.settings}.backup`, 'utf8')).toBe('{"a":1,"theirs":true}');
  });

  it('gives up with a conflict after a few attempts, writes nothing of its own and leaves no temp file', async () => {
    const r = rig({ settings: '{"a":1}' });
    let calls = 0;
    const result = await outcome(() =>
      editSettings(
        r.settings,
        () => {
          calls += 1;
          writeFileSync(r.settings, `{"a":${calls + 1}}`);
          return '{"mine":true}';
        },
        options(r.settings),
      ),
    );
    expect(result).toBe('conflict');
    expect(calls).toBe(3);
    expect(readFileSync(r.settings, 'utf8')).toBe('{"a":4}');
    expect(names(r.config)).toEqual(['settings.json']); // no backup was taken for a change that never happened
  });

  it('notices a file that is replaced by a file of the same size', async () => {
    const r = rig({ settings: '{"a":1}' });
    let calls = 0;
    await editSettings(
      r.settings,
      (text) => {
        calls += 1;
        if (calls === 1) writeFileSync(r.settings, '{"a":2}');
        return `${text}!`;
      },
      options(r.settings),
    );
    expect(readFileSync(r.settings, 'utf8')).toBe('{"a":2}!');
  });

  it('does not replace a file that appears while a missing one was being prepared', async () => {
    const r = rig({ settings: null });
    let calls = 0;
    await editSettings(
      r.settings,
      (text) => {
        calls += 1;
        if (calls === 1) writeFileSync(r.settings, '{"theirs":1}');
        return `${text ?? 'new'}!`;
      },
      options(r.settings),
    );
    expect(readFileSync(r.settings, 'utf8')).toBe('{"theirs":1}!');
  });

  it('refuses when the file is replaced by something that is not a file', async () => {
    const r = rig({ settings: '{}' });
    const result = await outcome(() =>
      editSettings(
        r.settings,
        () => {
          rmSync(r.settings);
          mkdirSync(r.settings);
          return 'x';
        },
        options(r.settings),
      ),
    );
    expect(result).toBe('unreadable');
    expect(names(r.config)).toEqual(['settings.json']);
  });
});

describe('the temp file and the backup', () => {
  it('removes its temp file when the edit throws, and when nothing changes', async () => {
    const r = rig({ settings: '{}' });
    expect(
      await outcome(() =>
        editSettings(
          r.settings,
          () => {
            throw new ClaudeHooksError('not_json');
          },
          options(r.settings),
        ),
      ),
    ).toBe('not_json');
    expect(await editSettings(r.settings, () => null, options(r.settings))).toBe('unchanged');
    expect(names(r.config)).toEqual(['settings.json']);
  });

  it('stops without writing the file when the backup cannot be made', async () => {
    const r = rig({ settings: '{"a":1}' });
    const result = await outcome(() =>
      editSettings(r.settings, () => '{"b":2}', {
        backup: join(r.root, 'no such folder', 'backup'),
        pause: async () => undefined,
      }),
    );
    expect(result).toBe('not_writable');
    expect(readFileSync(r.settings, 'utf8')).toBe('{"a":1}');
    expect(names(r.config)).toEqual(['settings.json']);
  });

  it('keeps an existing backup as it is', async () => {
    const r = rig({ settings: '{"a":1}' });
    // (a copy of a settings file: an empty or unreadable one is not taken for a saved copy, see backup.test.ts)
    writeFileSync(`${r.settings}.backup`, '{"firstCopy":"the owner’s first copy"}');
    await editSettings(r.settings, () => '{"b":2}', options(r.settings));
    expect(readFileSync(`${r.settings}.backup`, 'utf8')).toBe(
      '{"firstCopy":"the owner’s first copy"}',
    );
  });
});
