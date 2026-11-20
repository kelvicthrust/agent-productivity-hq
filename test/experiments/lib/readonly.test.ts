import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createReadGuard,
  DecoderMissingError,
  ReadOutsideDeclaredRootError,
} from '../../../scripts/experiments/lib/readonly.ts';
import { cleanupTmp, makeTmp } from '../harness.ts';

afterAll(cleanupTmp);

function world() {
  const base = makeTmp();
  const root = join(base, 'allowed');
  mkdirSync(join(root, 'sub'), { recursive: true });
  mkdirSync(join(base, 'allowed-sibling'));
  mkdirSync(join(base, 'outside'));
  writeFileSync(join(root, 'a.jsonl'), '{"a":1}\n\n{"b":2}\nlast-without-newline');
  writeFileSync(join(root, 'sub', 'b.jsonl'), '{"c":3}\n');
  writeFileSync(join(root, 'sub', 'c.txt'), 'text');
  writeFileSync(join(base, 'allowed-sibling', 'x.txt'), 'sibling');
  writeFileSync(join(base, 'outside', 'secret.txt'), 'outside');
  symlinkSync(join(base, 'outside'), join(root, 'link-to-outside'));
  symlinkSync(join(base, 'outside', 'secret.txt'), join(root, 'link-to-file'));
  return { base, root };
}

describe('declared roots', () => {
  it('refuses every read until a root is declared', () => {
    const { root } = world();
    const guard = createReadGuard({});
    expect(() => guard.readText(join(root, 'a.jsonl'))).toThrow(ReadOutsideDeclaredRootError);
    expect(() => guard.list(root)).toThrow(ReadOutsideDeclaredRootError);
  });

  it('allows reads below a declared root and refuses a sibling folder with the same prefix, ../ and absolute escapes', () => {
    const { base, root } = world();
    const guard = createReadGuard({});
    guard.declare(root);
    expect(guard.readText(join(root, 'sub', 'c.txt'))).toBe('text');
    expect(() => guard.readText(join(base, 'allowed-sibling', 'x.txt'))).toThrow(
      ReadOutsideDeclaredRootError,
    );
    expect(() => guard.readText(join(root, '..', 'outside', 'secret.txt'))).toThrow(
      ReadOutsideDeclaredRootError,
    );
    expect(() => guard.readText('/etc/hosts')).toThrow(ReadOutsideDeclaredRootError);
    expect(() => guard.exists(join(base, 'outside'))).toThrow(ReadOutsideDeclaredRootError);
  });

  it('does not follow a symlink out of the root, for files or folders', () => {
    const { root } = world();
    const guard = createReadGuard({});
    guard.declare(root);
    expect(() => guard.readText(join(root, 'link-to-file'))).toThrow(ReadOutsideDeclaredRootError);
    expect(() => guard.list(join(root, 'link-to-outside'))).toThrow(ReadOutsideDeclaredRootError);
    expect(guard.walk(root).files.map((f) => f.slice(root.length + 1))).toEqual([
      'a.jsonl',
      'sub/b.jsonl',
      'sub/c.txt',
    ]);
  });

  it('offers no way to write: only read methods exist', () => {
    const guard = createReadGuard({});
    expect(
      Object.keys(guard).filter((k) =>
        /write|append|mkdir|rm|unlink|rename|copy|chmod|create/i.test(k),
      ),
    ).toEqual([]);
  });
});

describe('reading', () => {
  it('streams lines, skipping blank ones and keeping a last line without a newline', () => {
    const { root } = world();
    const guard = createReadGuard({});
    guard.declare(root);
    expect([...guard.lines(join(root, 'a.jsonl'))]).toEqual([
      '{"a":1}',
      '{"b":2}',
      'last-without-newline',
    ]);
  });

  it('streams a file much larger than one chunk without losing or splitting a line', () => {
    const { root } = world();
    const guard = createReadGuard({});
    guard.declare(root);
    const rows = Array.from({ length: 20_000 }, (_, i) => `{"n":${i},"pad":"${'x'.repeat(20)}"}`);
    writeFileSync(join(root, 'big.jsonl'), `${rows.join('\n')}\n`);
    const seen = [...guard.lines(join(root, 'big.jsonl'))];
    expect(seen).toHaveLength(20_000);
    expect(seen[19_999]).toBe(rows[19_999]);
    expect(seen.every((line) => line.startsWith('{"n":'))).toBe(true);
  });

  it('counts the files and bytes it read', () => {
    const { root } = world();
    const guard = createReadGuard({});
    guard.declare(root);
    guard.readText(join(root, 'sub', 'c.txt'));
    expect([...guard.lines(join(root, 'a.jsonl'))]).toHaveLength(3);
    guard.readHead(join(root, 'sub', 'b.jsonl'), 3);
    expect(guard.trace().filesRead).toBe(3);
    expect(guard.trace().bytesRead).toBeGreaterThan(10);
  });

  it('refuses a file over the size limit, and lists and stats', () => {
    const { root } = world();
    const guard = createReadGuard({});
    guard.declare(root);
    expect(() => guard.readBytes(join(root, 'a.jsonl'), { maxBytes: 5 })).toThrow(RangeError);
    expect(guard.list(root).map((e) => [e.name, e.isDirectory, e.isSymlink])).toEqual([
      ['a.jsonl', false, false],
      ['link-to-file', false, true],
      ['link-to-outside', false, true],
      ['sub', true, false],
    ]);
    expect(guard.stat(join(root, 'sub', 'c.txt')).size).toBe(4);
  });

  it('walks with a match, a file limit and a depth limit', () => {
    const { root } = world();
    const guard = createReadGuard({});
    guard.declare(root);
    expect(guard.walk(root, { match: /\.jsonl$/ }).files).toHaveLength(2);
    expect(guard.walk(root, { match: /\.jsonl$/, maxFiles: 1 })).toMatchObject({ truncated: true });
    expect(guard.walk(root, { maxDepth: 0 }).files.map((f) => f.slice(root.length + 1))).toEqual([
      'a.jsonl',
    ]);
    expect(guard.walk(join(root, 'missing')).files).toEqual([]);
  });
});

describe('zstd', () => {
  it('decodes a .zst file, and says plainly when there is no decoder', () => {
    const { root } = world();
    const compress = (zlib as unknown as { zstdCompressSync(b: Buffer): Buffer }).zstdCompressSync;
    writeFileSync(join(root, 'rollout.jsonl.zst'), compress(Buffer.from('{"z":1}\n{"z":2}\n')));
    const guard = createReadGuard({});
    guard.declare(root);
    expect(guard.zstdAvailable()).toBe(true);
    expect([...guard.lines(join(root, 'rollout.jsonl.zst'))]).toEqual(['{"z":1}', '{"z":2}']);
    expect(
      Buffer.from(guard.readMaybeCompressed(join(root, 'rollout.jsonl.zst'))).toString(),
    ).toContain('"z":2');

    const without = createReadGuard({ EXPERIMENTS_FORCE_NO_ZSTD: '1' });
    without.declare(root);
    expect(without.zstdAvailable()).toBe(false);
    expect(() => without.readMaybeCompressed(join(root, 'rollout.jsonl.zst'))).toThrow(
      DecoderMissingError,
    );
    expect(() => [...without.lines(join(root, 'rollout.jsonl.zst'))]).toThrow(DecoderMissingError);
    expect(Buffer.from(without.readMaybeCompressed(join(root, 'a.jsonl'))).toString()).toContain(
      '"a":1',
    );
  });
});
