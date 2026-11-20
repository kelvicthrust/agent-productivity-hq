import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HEAD_BYTES,
  classifyFsError,
  deniedReport,
  failedReport,
  headHash,
  listFiles,
  notFoundReport,
  planRead,
  statFile,
} from '../../../src/server/collectors/ingest/index.ts';
import type { SourceFileRow } from '../../../src/server/db/queries/ingest.ts';
import { tempDir } from '../helpers.ts';

// Finding files, planning what to read of each, and how a failure is classified. The permission cases use a real chmod, the way a
// real EACCES arrives (they are skipped where chmod cannot deny the current user, such as root).

const canDeny = process.getuid?.() !== 0;

const jsonl = (path: string) => /\.jsonl$/.test(path);

describe('listFiles', () => {
  it('finds matching files below the root, sorted, with their sizes', async () => {
    const root = tempDir();
    mkdirSync(join(root, 'p1/sub'), { recursive: true });
    writeFileSync(join(root, 'p1/b.jsonl'), '12345');
    writeFileSync(join(root, 'p1/sub/a.jsonl'), '1');
    writeFileSync(join(root, 'p1/notes.txt'), 'x');
    const listing = await listFiles(root, jsonl);
    expect(listing.state).toBe('ok');
    expect(listing.files.map((f) => f.path.slice(root.length + 1))).toEqual([
      'p1/b.jsonl',
      'p1/sub/a.jsonl',
    ]);
    expect(listing.files[0]).toMatchObject({ size: 5 });
    expect(listing.inaccessible).toBe(0);
  });

  it('passes the path relative to the root with forward slashes to the filter', async () => {
    const root = tempDir();
    mkdirSync(join(root, 'p/s/subagents'), { recursive: true });
    writeFileSync(join(root, 'p/s/subagents/x.jsonl'), '{}');
    const seen: string[] = [];
    await listFiles(root, (rel) => (seen.push(rel), true));
    expect(seen).toEqual(['p/s/subagents/x.jsonl']);
  });

  it('says notfound for a root that is not there', async () => {
    const listing = await listFiles(join(tempDir(), 'missing'), jsonl);
    expect(listing).toMatchObject({ state: 'notfound', code: 'ENOENT', files: [] });
  });

  it.runIf(canDeny)(
    'says denied for a root it may not read, and partial for a folder below it',
    async () => {
      const root = tempDir();
      mkdirSync(join(root, 'open'));
      mkdirSync(join(root, 'shut'));
      writeFileSync(join(root, 'open/a.jsonl'), '{}');
      writeFileSync(join(root, 'shut/b.jsonl'), '{}');
      chmodSync(join(root, 'shut'), 0o000);
      try {
        const partial = await listFiles(root, jsonl);
        expect(partial.state).toBe('ok');
        expect(partial.files).toHaveLength(1);
        expect(partial.inaccessible).toBe(1);
      } finally {
        chmodSync(join(root, 'shut'), 0o755);
      }
      chmodSync(root, 0o000);
      try {
        const denied = await listFiles(root, jsonl);
        expect(denied).toMatchObject({ state: 'denied', code: 'EACCES', files: [] });
      } finally {
        chmodSync(root, 0o755);
      }
    },
  );

  it('follows a linked file and survives a link back up the tree', async () => {
    const root = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, 'real.jsonl'), '{}');
    symlinkSync(join(outside, 'real.jsonl'), join(root, 'link.jsonl'));
    symlinkSync(root, join(root, 'loop'));
    symlinkSync(join(root, 'nothing'), join(root, 'dangling.jsonl'));
    const listing = await listFiles(root, jsonl);
    expect(listing.state).toBe('ok');
    expect(listing.files.length).toBeGreaterThanOrEqual(1);
    expect(listing.files[0]?.path.endsWith('link.jsonl')).toBe(true);
  });
});

describe('statFile', () => {
  it('returns null for a file that is gone and rejects on a permission error', async () => {
    const dir = tempDir();
    expect(await statFile(join(dir, 'gone'))).toBeNull();
    writeFileSync(join(dir, 'a'), 'abc');
    expect(await statFile(join(dir, 'a'))).toMatchObject({ size: 3 });
  });
});

describe('headHash and planRead', () => {
  const tracked = (over: Partial<SourceFileRow> = {}): SourceFileRow => ({
    id: 1,
    sourceId: 'claude',
    path: '',
    size: 0,
    mtimeMs: 0,
    headHash: '',
    readOffset: 0,
    state: 'ok',
    unreadableLines: 0,
    lastReadAt: 0,
    normalizationVersion: null,
    codexParentId: null,
    codexParentVersion: null,
    ...over,
  });

  async function trackedFor(path: string, over: Partial<SourceFileRow> = {}) {
    const file = (await statFile(path))!;
    return {
      file,
      row: tracked({
        path,
        size: file.size,
        mtimeMs: file.mtimeMs,
        headHash: await headHash(path, file.size),
        readOffset: file.size,
        ...over,
      }),
    };
  }

  it('reads a file nobody has seen from the start', async () => {
    const path = join(tempDir(), 'a.jsonl');
    writeFileSync(path, '{}\n');
    const file = (await statFile(path))!;
    expect(await planRead(null, file)).toEqual({ action: 'read', from: 0, why: 'new' });
  });

  it('skips a file whose size and mtime are as stored, without reading it', async () => {
    const path = join(tempDir(), 'a.jsonl');
    writeFileSync(path, '{}\n');
    const { file, row } = await trackedFor(path);
    expect(await planRead(row, file)).toEqual({ action: 'skip' });
  });

  it('reads only what was appended, even while the file is under 4 KiB', async () => {
    const path = join(tempDir(), 'a.jsonl');
    writeFileSync(path, '{"a":1}\n');
    const { row } = await trackedFor(path);
    appendFileSync(path, '{"b":2}\n');
    const later = new Date(Date.now() + 5000);
    utimesSync(path, later, later);
    const file = (await statFile(path))!;
    expect(await planRead(row, file)).toEqual({ action: 'read', from: 8, why: 'appended' });
  });

  it('reads a replaced file from the start: shorter, or different first bytes', async () => {
    const path = join(tempDir(), 'a.jsonl');
    writeFileSync(path, '{"a":1}\n{"b":2}\n');
    const { row } = await trackedFor(path);
    writeFileSync(path, '{"a":1}\n');
    const later = new Date(Date.now() + 5000);
    utimesSync(path, later, later);
    expect(await planRead(row, (await statFile(path))!)).toMatchObject({
      from: 0,
      why: 'replaced',
    });

    writeFileSync(path, '{"z":9}\n{"b":2}\n{"c":3}\n');
    utimesSync(path, later, later);
    expect(await planRead(row, (await statFile(path))!)).toMatchObject({
      from: 0,
      why: 'replaced',
    });
  });

  it('hashes at most the first 4 KiB', async () => {
    const path = join(tempDir(), 'big.jsonl');
    writeFileSync(path, 'a'.repeat(HEAD_BYTES) + 'b'.repeat(100));
    const first = await headHash(path, HEAD_BYTES + 100);
    writeFileSync(path, 'a'.repeat(HEAD_BYTES) + 'c'.repeat(500));
    expect(await headHash(path, HEAD_BYTES + 500)).toBe(first);
  });

  it('retries a file that was unreadable even though nothing about it changed', async () => {
    const path = join(tempDir(), 'a.jsonl');
    writeFileSync(path, '{}\n');
    const { file, row } = await trackedFor(path, { state: 'unreadable' });
    expect(await planRead(row, file)).toMatchObject({ action: 'read', from: 0, why: 'retry' });
  });

  it('skips an unsupported file until it changes', async () => {
    const path = join(tempDir(), 'a.jsonl.zst');
    writeFileSync(path, 'zzzz');
    const { file, row } = await trackedFor(path, { state: 'unsupported' });
    expect(await planRead(row, file)).toEqual({ action: 'skip' });
  });
});

describe('classifyFsError and the standard reports', () => {
  it('maps file system codes and keeps nothing else from an error', () => {
    expect(classifyFsError(Object.assign(new Error('x /secret/path'), { code: 'EACCES' }))).toEqual(
      { kind: 'denied', code: 'EACCES' },
    );
    expect(classifyFsError({ code: 'EPERM' })).toEqual({ kind: 'denied', code: 'EPERM' });
    expect(classifyFsError({ code: 'ENOENT' }).kind).toBe('notfound');
    expect(classifyFsError({ code: 'ENOTDIR' }).kind).toBe('notfound');
    expect(classifyFsError({ code: 'EMFILE' })).toEqual({ kind: 'failed', code: 'EMFILE' });
    expect(classifyFsError(new SyntaxError('Unexpected token')).code).toBe('unknown');
    expect(classifyFsError({ code: 'SENTINEL secret text' }).code).toBe('unknown');
    expect(classifyFsError(null)).toEqual({ kind: 'failed', code: 'unknown' });
  });

  it('builds the reports Sources shows, with no file content in them', () => {
    expect(notFoundReport('codex')).toMatchObject({ result: 'skipped' });
    expect(deniedReport('claude', '/h/.claude')).toMatchObject({
      result: 'failed',
      status: 'denied',
      location: '/h/.claude',
      errorCode: 'access_denied',
    });
    const failed = failedReport('codex', null, 'EMFILE');
    expect(failed).toMatchObject({ result: 'failed', status: 'failed', errorCode: 'emfile' });
    expect(
      JSON.stringify([notFoundReport('codex'), deniedReport('claude', null), failed]),
    ).not.toMatch(/SENTINEL|\/Users\//);
  });
});
