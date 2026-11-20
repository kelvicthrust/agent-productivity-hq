import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import * as zlib from 'node:zlib';
import type { FileEntry, FileStat, ReadOnlyFs } from './types.ts';

// Read access for experiments. Nothing here can write: the only fs functions imported are reads. A script must announce
// each source with willRead() first; a read outside every announced root throws, symlinks included.

export class ReadOutsideDeclaredRootError extends Error {
  constructor() {
    super('A read outside the folders this script announced was refused.');
    this.name = 'ReadOutsideDeclaredRootError';
  }
}

export class DecoderMissingError extends Error {
  constructor() {
    super('This file is zstd-compressed and no zstd decoder is available in this Node.');
    this.name = 'DecoderMissingError';
  }
}

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const CHUNK = 64 * 1024;
const MAX_LINE_BYTES = 4 * 1024 * 1024;

export interface ReadGuard extends ReadOnlyFs {
  /** Allows reads below `root`. Returns the absolute path. */
  declare(root: string): string;
  roots(): string[];
  trace(): { filesRead: number; bytesRead: number };
}

/** The real path of `path`; for a path that does not exist, the real path of its nearest existing parent plus the rest. */
function realpathLoose(path: string): string {
  let current = path;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      rest.push(basename(current));
      current = parent;
    }
  }
}

const inside = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

export function zstdAvailable(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return (
    env['EXPERIMENTS_FORCE_NO_ZSTD'] !== '1' &&
    typeof (zlib as { zstdDecompressSync?: unknown }).zstdDecompressSync === 'function'
  );
}

export function createReadGuard(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReadGuard {
  const roots: string[] = [];
  const files = new Set<string>();
  let bytesRead = 0;

  const allowed = (path: string): string => {
    const abs = resolve(path);
    const real = realpathLoose(abs);
    const ok = roots.some((root) => inside(root, abs) && inside(realpathLoose(root), real));
    if (!ok) throw new ReadOutsideDeclaredRootError();
    return abs;
  };

  const readBytes = (path: string, options: { maxBytes?: number } = {}): Uint8Array => {
    const abs = allowed(path);
    const size = statSync(abs).size;
    const max = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (size > max) throw new RangeError(`File is larger than ${max} bytes.`);
    const data = readFileSync(abs);
    files.add(abs);
    bytesRead += data.length;
    return data;
  };

  const readMaybeCompressed = (path: string, options: { maxBytes?: number } = {}): Uint8Array => {
    const raw = readBytes(path, options);
    if (!path.endsWith('.zst')) return raw;
    if (!zstdAvailable(env)) throw new DecoderMissingError();
    const max = options.maxBytes ?? DEFAULT_MAX_BYTES;
    return (
      zlib as unknown as {
        zstdDecompressSync(b: Uint8Array, o: { maxOutputLength: number }): Uint8Array;
      }
    ).zstdDecompressSync(raw, { maxOutputLength: max });
  };

  function* lines(path: string): Generator<string> {
    if (path.endsWith('.zst')) {
      const text = Buffer.from(readMaybeCompressed(path)).toString('utf8');
      for (const line of text.split('\n')) if (line !== '') yield line.slice(0, MAX_LINE_BYTES);
      return;
    }
    const abs = allowed(path);
    const fd = openSync(abs, 'r');
    files.add(abs);
    try {
      const buffer = Buffer.alloc(CHUNK);
      let carry = '';
      for (;;) {
        const n = readSync(fd, buffer, 0, CHUNK, null);
        if (n === 0) break;
        bytesRead += n;
        carry += buffer.toString('utf8', 0, n);
        let index = carry.indexOf('\n');
        while (index >= 0) {
          const line = carry.slice(0, index);
          carry = carry.slice(index + 1);
          if (line !== '') yield line.slice(0, MAX_LINE_BYTES);
          index = carry.indexOf('\n');
        }
        if (carry.length > MAX_LINE_BYTES) carry = carry.slice(0, MAX_LINE_BYTES);
      }
      if (carry !== '') yield carry;
    } finally {
      closeSync(fd);
    }
  }

  return {
    declare(root) {
      const abs = resolve(root);
      if (!roots.includes(abs)) roots.push(abs);
      return abs;
    },
    roots: () => [...roots],
    trace: () => ({ filesRead: files.size, bytesRead }),
    readBytes,
    readText: (path, options) => Buffer.from(readBytes(path, options)).toString('utf8'),
    readMaybeCompressed,
    readHead(path, bytes) {
      const abs = allowed(path);
      const fd = openSync(abs, 'r');
      files.add(abs);
      try {
        const buffer = Buffer.alloc(Math.min(bytes, DEFAULT_MAX_BYTES));
        const n = readSync(fd, buffer, 0, buffer.length, 0);
        bytesRead += n;
        return buffer.subarray(0, n);
      } finally {
        closeSync(fd);
      }
    },
    lines,
    list(dir): FileEntry[] {
      return readdirSync(allowed(dir), { withFileTypes: true })
        .map((e) => ({
          name: e.name,
          isFile: e.isFile(),
          isDirectory: e.isDirectory(),
          isSymlink: e.isSymbolicLink(),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    stat(path): FileStat {
      const s = statSync(allowed(path));
      return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory() };
    },
    exists: (path) => existsSync(allowed(path)),
    walk(dir, options = {}) {
      const match = options.match;
      const maxFiles = options.maxFiles ?? 20_000;
      const maxDepth = options.maxDepth ?? 12;
      const out: string[] = [];
      let truncated = false;
      const visit = (current: string, depth: number) => {
        if (truncated || depth > maxDepth) return;
        for (const entry of readdirSync(allowed(current), { withFileTypes: true }).sort((a, b) =>
          a.name.localeCompare(b.name),
        )) {
          const full = join(current, entry.name);
          if (entry.isDirectory()) visit(full, depth + 1);
          else if (entry.isFile() && (!match || match.test(entry.name))) {
            if (out.length >= maxFiles) {
              truncated = true;
              return;
            }
            out.push(full);
          }
        }
      };
      if (existsSync(allowed(dir))) visit(resolve(dir), 0);
      return { files: out, truncated };
    },
    zstdAvailable: () => zstdAvailable(env),
  };
}
