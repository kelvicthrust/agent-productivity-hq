import { randomUUID } from 'node:crypto';
import { linkSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tryDirectoryLock } from '../db/open.ts';
import { baseUrl } from './config.ts';
import { FILE_MODE } from './fsModes.ts';

export interface LockInfo {
  pid: number;
  port: number;
  startedAt: string;
  version?: 2;
  managed?: true;
}

export interface InstanceLease {
  ok: true;
  release: () => void;
}

export type LockResult = InstanceLease | { ok: false; holder: LockInfo | null };

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

function readLock(path: string): LockInfo | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      const item = parsed as Partial<LockInfo>;
      const { pid, port, startedAt, version, managed } = item;
      if (
        typeof pid === 'number' &&
        Number.isSafeInteger(pid) &&
        pid > 0 &&
        typeof port === 'number' &&
        Number.isSafeInteger(port) &&
        port >= 1 &&
        port <= 65_535 &&
        typeof startedAt === 'string'
      ) {
        return {
          pid,
          port,
          startedAt,
          ...(version === 2 ? { version, ...(managed === true ? { managed } : {}) } : {}),
        };
      }
    }
  } catch {
    // Diagnostics may be unavailable while an owner is starting.
  }
  return null;
}

function diagnosticInode(path: string): string | null {
  try {
    const file = lstatSync(path, { bigint: true });
    return `${file.dev}:${file.ino}:${file.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function publish(
  path: string,
  record: LockInfo,
): { published: true } | { published: false; holder: LockInfo | null } {
  const temporary = path + '.' + randomUUID();
  try {
    writeFileSync(temporary, JSON.stringify(record), { mode: FILE_MODE, flag: 'wx' });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        // A pre-upgrade process can still claim this name with O_EXCL. Never overwrite its claim.
        linkSync(temporary, path);
        return { published: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const inode = diagnosticInode(path);
      if (inode === null) continue;
      const holder = readLock(path);
      if (holder === null) return { published: false, holder: null };
      // We already hold the SQLite lease, so a v2 record here is stale even if its PID was reused.
      if (holder.version !== 2 && isAlive(holder.pid)) return { published: false, holder };
      if (diagnosticInode(path) === inode) rmSync(path, { force: true });
    }
    return { published: false, holder: null };
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function acquireInstanceLock(
  path: string,
  info: { port: number; now?: () => number; managed?: boolean },
): LockResult {
  const lease = tryDirectoryLock(join(dirname(path), 'agent-productivity-lock.sqlite'));
  if (lease === null) {
    const holder = readLock(path);
    return { ok: false, holder: holder?.version === 2 && isAlive(holder.pid) ? holder : null };
  }

  try {
    const result = publish(path, {
      pid: process.pid,
      port: info.port,
      startedAt: new Date((info.now ?? Date.now)()).toISOString(),
      version: 2,
      ...(info.managed ? { managed: true } : {}),
    });
    if (!result.published) {
      lease.close();
      return { ok: false, holder: result.holder };
    }
  } catch (error) {
    lease.close();
    throw error;
  }

  return {
    ok: true,
    release: () => {
      if (!lease.isOpen) return;
      try {
        rmSync(path, { force: true });
      } finally {
        lease.close();
      }
    },
  };
}

export function alreadyRunningMessage(
  holder: Pick<LockInfo, 'port'> | null,
  lockPath: string,
): string {
  if (holder === null)
    return 'Another Agent Productivity HQ process is starting or using this data folder.';
  return [
    `Agent Productivity HQ is already running at ${baseUrl(holder.port)}`,
    `Instance details: ${lockPath}`,
  ].join('\n');
}
