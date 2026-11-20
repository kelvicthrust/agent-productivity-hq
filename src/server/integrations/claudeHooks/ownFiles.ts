import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { join } from 'node:path';
import { DIR_MODE, FILE_MODE } from '../../lib/fsModes.ts';
import { ClaudeHooksError } from './errors.ts';
import {
  O_NOFOLLOW,
  O_NONBLOCK,
  codeOf,
  isInstalled,
  makeDir,
  makeOwnerDirs,
  removeIfMade as removeMade,
  renameOver,
  sealForRename,
  setModePath,
  stageTemp,
  truncateOpen,
  unlinkName,
  writeAll,
  type Made as StagedFile,
} from './fsguard.ts';
import { sweepStaleTemps } from './stale.ts';
import { HOOKS_DIR, HOOK_SCRIPT, REGISTRY_FILE, type HookPaths } from './paths.ts';

// Every create, write, read and delete of HQ's OWN artifacts goes through here: the hook folder, the script and the registry. (The
// owner's settings files are not artifacts; they have their own guard in write.ts.) One rule decides whether anything may happen:
//
//   the hook folder must be a real folder (not a link), directly inside the app's data folder, owned by the current user, and an
//   artifact must be a regular file (not a link, not a folder) directly inside it. Otherwise nothing is created, written, read or
//   deleted, and what is there is left exactly as it is.
//
// A delete goes further: it also needs the caller to say the file is HQ's own, by content (a script that is HQ's, or a registry of
// the shape HQ writes, or the exact bytes this process published). A folder or file that fails the rule is never "cleaned up". An
// UNDO (taking back what an operation wrote) goes further still: it acts only while the file is still byte for byte, and the same
// inode, what that operation wrote (`Made`); if the owner saved over it since, it stays and is reported. Writes are a temp file made
// `wx` (owner-only) beside the target and renamed over it. Reading is bounded.

export type Artifact = typeof HOOK_SCRIPT | typeof REGISTRY_FILE;

const MAX_BYTES: Record<Artifact, number> = {
  [HOOK_SCRIPT]: 256 * 1024,
  [REGISTRY_FILE]: 4 * 1024,
};
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;

/** The first words of the hook script this app ships: a script that starts with them in HQ's folder is HQ's, whichever version. */
export const SCRIPT_HEADER = '// Agent Productivity: the Claude Code hook';

/** A script HQ ships (any version): small, and starting with the words every version starts with. */
export const isHqScript = (bytes: Buffer): boolean =>
  bytes.length <= MAX_BYTES[HOOK_SCRIPT] &&
  bytes.subarray(0, SCRIPT_HEADER.length).toString('utf8') === SCRIPT_HEADER;

/** What an artifact write leaves on disk: its bytes, device and inode. An undo acts only while the file is still exactly this. */
export interface Made {
  bytes: Buffer;
  ino: number;
  dev: number;
}

/** What a registry holds once it has been neutralised: no token, no port; the hook script reads it as "nobody is listening". */
export const NEUTRAL_REGISTRY = (pid: number): string =>
  `${JSON.stringify({ v: 1, pid, port: 0, token: '' })}\n`;

/**
 * Whether HQ's own reader would take `bytes` for the artifact: within the size it reads, a registry of the shape it parses, a script
 * that is HQ's. Nothing that fails this is ever written ("the output must be readable by HQ's own reader").
 */
export function readableByHq(name: Artifact, bytes: Buffer): boolean {
  if (bytes.length > MAX_BYTES[name]) return false;
  return name === REGISTRY_FILE ? parseRegistry(bytes) !== null : isHqScript(bytes);
}

export interface OwnFiles {
  /** The bytes of the artifact; null when there is none (or no folder); throws `not_writable` for anything that is not a regular file. */
  read(name: Artifact): Buffer | null;
  /** The artifact's `lstat` when it is a regular file in a real HQ folder, null when there is none; throws `not_writable` for anything else. */
  stat(name: Artifact): Stats | null;
  /**
   * Creates the folder if it is missing, then writes the artifact atomically (owner-only). Throws `not_writable` when refused, and for
   * bytes HQ's own reader would not accept.
   */
  write(name: Artifact, bytes: Buffer | string): Made;
  /**
   * Deletes the artifact when it is a regular file in a real HQ folder AND `isOwn(bytes)` says it is HQ's. Returns what happened:
   * 'removed', 'absent' (nothing there), 'kept' (there, and not HQ's to delete), or 'failed' (it is HQ's and could not be deleted,
   * e.g. the folder is read-only). Never throws.
   */
  remove(
    name: Artifact,
    isOwn: (bytes: Buffer) => boolean,
  ): 'removed' | 'absent' | 'kept' | 'failed';
  /** Deletes the artifact only while it is still exactly `made` (same inode, same bytes). 'left' when it is anything else now or cannot be deleted. Never throws. */
  removeIfMade(name: Artifact, made: Made): 'removed' | 'absent' | 'left';
  /** Replaces the artifact with `bytes` only while it is still exactly `made`; returns what it wrote. 'left' when it is anything else now. Never throws. */
  replaceIfMade(name: Artifact, made: Made, bytes: Buffer): Made | 'left';
  /** The artifact's bytes and inode when it is a regular file in a real HQ folder; null otherwise. Never throws. */
  identify(name: Artifact): Made | null;
  /**
   * Rewrites a registry that could not be deleted so that it holds no token, in place (a read-only folder does not stop that), only
   * while it is still exactly `made` and has one name. True when it is neutral now. Never throws.
   */
  neutralise(name: Artifact, made: Made): boolean;
}

export function createOwnFiles(paths: HookPaths): OwnFiles {
  const refuse = (): never => {
    throw new ClaudeHooksError('not_writable');
  };

  /**
   * Whether the hook folder is there and passes the rule: 'absent', or 'ok'. With `create` a missing folder is made (owner-only);
   * a folder that fails the rule throws `not_writable`, `create` or not.
   */
  function folder(create: boolean): 'absent' | 'ok' {
    if (create) makeOwnerDirs(paths.dataDir);
    let found: Stats | undefined;
    try {
      found = lstatSync(paths.dir) as Stats;
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error;
    }
    if (found === undefined) {
      if (!create) return 'absent';
      try {
        makeDir(paths.dir, DIR_MODE);
      } catch (error) {
        if (codeOf(error) !== 'EEXIST') throw error;
      }
    }
    // Opened without following a link, and every check is made on the opened folder itself.
    const fd = openSync(paths.dir, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      const owner = process.getuid?.();
      if (!stat.isDirectory() || (owner !== undefined && stat.uid !== owner)) return refuse();
      if (create && (stat.mode & 0o7777) !== DIR_MODE) setModePath(paths.dir, DIR_MODE);
    } finally {
      closeSync(fd);
    }
    // Directly inside the data folder: its real path is the data folder's real path plus the folder's name, so no link is on the way.
    if (realpathSync(paths.dir) !== join(realpathSync(paths.dataDir), HOOKS_DIR)) return refuse();
    return 'ok';
  }

  /** The artifact's lstat: null when absent, else it must be a regular file. */
  function regular(name: Artifact): Stats | null {
    let stat: Stats;
    try {
      stat = lstatSync(join(paths.dir, name)) as Stats;
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return null;
      throw error;
    }
    if (!stat.isFile() || stat.size > MAX_BYTES[name]) return refuse();
    return stat;
  }

  const bytesOf = (name: Artifact): Buffer =>
    readFileSync(join(paths.dir, name), { flag: constants.O_RDONLY | O_NOFOLLOW });

  const isMade = (stat: Stats, made: Made): boolean =>
    stat.ino === made.ino && stat.dev === made.dev;

  return {
    read(name) {
      try {
        if (folder(false) === 'absent') return null;
        return regular(name) === null ? null : bytesOf(name);
      } catch (error) {
        throw error instanceof ClaudeHooksError ? error : new ClaudeHooksError('not_writable');
      }
    },
    stat(name) {
      try {
        if (folder(false) === 'absent') return null;
        return regular(name);
      } catch (error) {
        throw error instanceof ClaudeHooksError ? error : new ClaudeHooksError('not_writable');
      }
    },
    write(name, bytes) {
      const target = join(paths.dir, name);
      const data = Buffer.from(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes);
      let temp: StagedFile | null = null;
      try {
        if (!readableByHq(name, data)) return refuse();
        folder(true);
        sweepStaleTemps(paths.dir, [HOOK_SCRIPT, REGISTRY_FILE]);
        temp = stageTemp(target, data);
        // Order: the staged file is sealed completely, THEN the destination is looked at, THEN the rename, with nothing between those
        // two (no await: this is all synchronous). A link or a file here is replaced by the rename (never written through); a folder
        // is not ours to replace.
        sealForRename(temp, FILE_MODE, undefined);
        try {
          if (lstatSync(target).isDirectory()) return refuse();
        } catch (error) {
          if (codeOf(error) !== 'ENOENT') throw error;
        }
        renameOver(temp.path, target);
        const staged = temp;
        temp = null;
        if (!isInstalled(target, staged, FILE_MODE)) return refuse();
        return { bytes: data, ino: staged.ino, dev: staged.dev };
      } catch (error) {
        if (temp !== null) removeMade(temp);
        throw error instanceof ClaudeHooksError ? error : new ClaudeHooksError('not_writable');
      }
    },
    remove(name, isOwn) {
      try {
        if (folder(false) === 'absent') return 'absent';
      } catch {
        return 'kept';
      }
      let stat: Stats | null;
      try {
        stat = regular(name);
      } catch {
        return 'kept';
      }
      if (stat === null) return 'absent';
      let bytes: Buffer;
      try {
        bytes = bytesOf(name);
      } catch {
        return 'kept';
      }
      if (!isOwn(bytes)) return 'kept';
      try {
        // The name is looked at again immediately before the unlink: it must still be the file whose bytes were judged.
        const again = lstatSync(join(paths.dir, name));
        if (!again.isFile() || again.ino !== stat.ino || again.dev !== stat.dev) return 'kept';
        unlinkName(join(paths.dir, name));
        return 'removed';
      } catch (error) {
        return codeOf(error) === 'ENOENT' ? 'absent' : 'failed';
      }
    },
    removeIfMade(name, made) {
      try {
        if (folder(false) === 'absent') return 'absent';
        const stat = regular(name);
        if (stat === null) return 'absent';
        if (!isMade(stat, made) || !bytesOf(name).equals(made.bytes)) return 'left';
        const again = lstatSync(join(paths.dir, name));
        if (!again.isFile() || !isMade(again, made)) return 'left';
        unlinkName(join(paths.dir, name));
        return 'removed';
      } catch (error) {
        return codeOf(error) === 'ENOENT' ? 'absent' : 'left';
      }
    },
    replaceIfMade(name, made, bytes) {
      try {
        if (folder(false) === 'absent') return 'left';
        const stat = regular(name);
        if (stat === null || !isMade(stat, made) || !bytesOf(name).equals(made.bytes))
          return 'left';
        return this.write(name, bytes);
      } catch {
        return 'left';
      }
    },
    identify(name) {
      try {
        if (folder(false) === 'absent') return null;
        const stat = regular(name);
        return stat === null ? null : { bytes: bytesOf(name), ino: stat.ino, dev: stat.dev };
      } catch {
        return null;
      }
    },
    neutralise(name, made) {
      let fd: number | null = null;
      try {
        if (folder(false) === 'absent' || regular(name) === null) return false;
        // Opened without waiting and without following a link; everything is checked on the opened file itself.
        const path = join(paths.dir, name);
        fd = openSync(path, constants.O_RDWR | O_NOFOLLOW | O_NONBLOCK);
        const stat = fstatSync(fd);
        if (!stat.isFile() || !isMade(stat, made) || stat.size !== made.bytes.length) return false;
        const found = Buffer.alloc(made.bytes.length);
        if (readSync(fd, found, 0, found.length, 0) !== found.length || !found.equals(made.bytes))
          return false;
        const blank = Buffer.from(NEUTRAL_REGISTRY(process.pid), 'utf8');
        if (fstatSync(fd).nlink !== 1) return false;
        truncateOpen(fd, path);
        writeAll(fd, path, blank, true);
        return true;
      } catch {
        return false;
      } finally {
        if (fd !== null) closeSync(fd);
      }
    },
  };
}

/** The shape of a registry HQ writes: `{ v: 1, pid, port, token }` and nothing else. */
export function parseRegistry(
  bytes: Buffer,
): { v: 1; pid: number; port: number; token: string } | null {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort().join(',');
    const { v, pid, port, token } = record;
    if (keys !== 'pid,port,token,v' || v !== 1) return null;
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(port) || typeof token !== 'string')
      return null;
    return { v: 1, pid: pid as number, port: port as number, token };
  } catch {
    return null;
  }
}
