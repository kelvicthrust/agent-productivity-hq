import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { editSettingsText } from '../../src/server/integrations/claudeHooks/edit.ts';
import { ClaudeHooksError } from '../../src/server/integrations/claudeHooks/index.ts';
import { readableByHq } from '../../src/server/integrations/claudeHooks/ownFiles.ts';
import { HOOK_SCRIPT } from '../../src/server/integrations/claudeHooks/paths.ts';
import { MAX_SETTINGS_BYTES } from '../../src/server/integrations/claudeHooks/settings.ts';
import { ASSET, read, rig } from './helpers.ts';

// The rule (data-and-sources › Claude Code hooks › Install and remove): nothing is written that HQ's own reader would not read back.
// An edit is refused before anything is written unless its RESULT also satisfies every limit the read side has (the size in bytes,
// UTF-8, valid JSON, an object, the depth); the registry and the script are held to the same rule by the reader that reads each.

const refusal = async (run: () => Promise<unknown>): Promise<ClaudeHooksError> => {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ClaudeHooksError);
    return error as ClaudeHooksError;
  }
  throw new Error('expected a refusal');
};

/** A settings file `{"note":"<padding>"}` whose edit (turning HQ on) is exactly `extra` bytes longer than the file when `extra` is 0. */
async function atTheLimit(extra: number) {
  const probe = rig({ settings: '{"note":""}' });
  const command = (await probe.hooks.status()).command;
  const growth =
    Buffer.byteLength(editSettingsText('{"note":""}', command, true)!) - '{"note":""}'.length;
  const pad = MAX_SETTINGS_BYTES - '{"note":""}'.length - growth + extra;
  const settings = `{"note":"${'a'.repeat(pad)}"}`;
  const r = rig({ settings });
  return { r, settings, size: Buffer.byteLength(settings) + growth };
}

describe('the settings file HQ writes is one HQ can read', () => {
  it('a result of exactly 4 MiB is written, read back as on, and turned off again', async () => {
    const { r, size } = await atTheLimit(0);
    expect(size).toBe(MAX_SETTINGS_BYTES);
    const status = await r.hooks.status();
    await r.hooks.set(true, { preview: status.preview });
    expect(statSync(r.settings).size).toBe(MAX_SETTINGS_BYTES);
    expect(await r.hooks.status()).toMatchObject({ state: 'on', reason: null });
    expect((await r.hooks.set(false)).state).toBe('off');
  });

  it('a result one byte over is refused before anything is written, and the status still offers a way on', async () => {
    const { r, settings } = await atTheLimit(1);
    const before = await r.hooks.status();
    expect(before).toMatchObject({ state: 'unavailable', reason: 'settings_blocked' });
    expect(before.files[0]).toMatchObject({ state: 'blocked', reason: 'unsupported_layout' });
    const error = await refusal(() => r.hooks.set(true, { preview: before.preview }));
    expect(error.failure).toBe('unsupported_layout');
    expect(read(r.settings) === settings).toBe(true);
    expect(existsSync(r.hooks.paths.script)).toBe(false);
    expect(existsSync(`${r.settings}.agent-productivity-backup`)).toBe(false);
  });

  it('counts bytes, not characters (two-byte and four-byte characters)', async () => {
    for (const [character, width] of [
      ['é', 2],
      ['😀', 4],
    ] as const) {
      const probe = rig({ settings: '{"note":""}' });
      const command = (await probe.hooks.status()).command;
      const growth =
        Buffer.byteLength(editSettingsText('{"note":""}', command, true)!) - '{"note":""}'.length;
      const room = MAX_SETTINGS_BYTES - '{"note":""}'.length - growth;
      const fits = `{"note":"${character.repeat(Math.floor(room / width))}"}`;
      const over = `{"note":"${character.repeat(Math.floor(room / width) + 1)}"}`;
      const ok = rig({ settings: fits });
      await ok.hooks.set(true);
      expect(statSync(ok.settings).size).toBeLessThanOrEqual(MAX_SETTINGS_BYTES);
      expect((await ok.hooks.status()).state).toBe('on');
      const no = rig({ settings: over });
      expect((await refusal(() => no.hooks.set(true))).failure).toBe('unsupported_layout');
      expect(read(no.settings) === over).toBe(true);
    }
  });

  it('a file nested as deep as HQ reads (64 levels) is edited and read back; one deeper is refused', async () => {
    const nested = (levels: number) =>
      `{"deep":${'['.repeat(levels - 1)}${']'.repeat(levels - 1)}}`;
    const ok = rig({ settings: nested(64) });
    await ok.hooks.set(true);
    expect((await ok.hooks.status()).state).toBe('on');
    const deeper = rig({ settings: nested(65) });
    expect((await refusal(() => deeper.hooks.set(true))).failure).toBe('unsupported_layout');
    expect(read(deeper.settings)).toBe(nested(65));
  });

  it('what turning off writes is smaller, so a file at the limit can always be turned off', async () => {
    const { r } = await atTheLimit(0);
    await r.hooks.set(true);
    const off = await r.hooks.set(false);
    expect(off.state).toBe('off');
    expect(statSync(r.settings).size).toBeLessThan(MAX_SETTINGS_BYTES);
  });
});

describe('the registry and the script are ones HQ can read', () => {
  const TOKEN = 'T'.repeat(43);
  it('a token at the longest the script reads (200) is published; one longer, or one it would not read, is not', async () => {
    for (const [token, ok] of [
      ['a'.repeat(200), true],
      ['a'.repeat(201), false],
      ['a'.repeat(19), false],
      [`${'a'.repeat(30)}+/`, false],
    ] as const) {
      const r = rig({ settings: '{}' });
      await r.hooks.listening({ port: 4317, token });
      if (ok) {
        await r.hooks.set(true);
        expect((await r.hooks.status()).state).toBe('on');
      } else {
        const error = await refusal(() => r.hooks.set(true));
        expect(error.failure).toBe('registry_failed');
        expect(read(r.settings)).toBe('{}');
        expect(existsSync(r.hooks.paths.registry)).toBe(false);
        expect(existsSync(r.hooks.paths.script)).toBe(false);
      }
    }
  });

  it('a port the script would not use is not published', async () => {
    for (const port of [0, 65_536, -1]) {
      const r = rig({ settings: '{}' });
      await r.hooks.listening({ port, token: TOKEN });
      expect((await refusal(() => r.hooks.set(true))).failure).toBe('registry_failed');
      expect(existsSync(r.hooks.paths.registry)).toBe(false);
    }
  });

  const script = (r: ReturnType<typeof rig>, bytes: Buffer): string => {
    const path = join(r.root, 'asset.mjs');
    writeFileSync(path, bytes);
    return path;
  };
  const header = '// Agent Productivity: the Claude Code hook\n';

  it('a script of exactly 256 KiB that starts as HQ’s does is installed; one byte more, or one that is not HQ’s, is not', async () => {
    const exact = Buffer.concat([
      Buffer.from(header),
      Buffer.alloc(256 * 1024 - header.length, 0x20),
    ]);
    const fits = rig({ settings: '{}' });
    const on = fits.another({ assetPath: script(fits, exact) });
    await on.set(true);
    expect(statSync(on.paths.script).size).toBe(256 * 1024);
    expect((await on.status()).state).toBe('on');

    for (const bytes of [
      Buffer.concat([exact, Buffer.from(' ')]),
      Buffer.from('console.log(1)\n'),
    ]) {
      const r = rig({ settings: '{}' });
      const off = r.another({ assetPath: script(r, bytes) });
      expect((await refusal(() => off.set(true))).failure).toBe('not_writable');
      expect(existsSync(r.hooks.paths.script)).toBe(false);
      expect(read(r.settings)).toBe('{}');
    }
  });

  it('the script this app ships is one its own reader accepts', () => {
    expect(readableByHq(HOOK_SCRIPT, readFileSync(ASSET))).toBe(true);
  });
});
