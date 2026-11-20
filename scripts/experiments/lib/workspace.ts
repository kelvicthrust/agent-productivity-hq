import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  appendFileNoFollow,
  readFileNoFollow,
  UnsafeFileError,
  writeFileNoFollow,
} from './safefile.ts';
import type { TempWorkspace } from './types.ts';

// E8 has to write: it builds a throwaway CLAUDE_CONFIG_DIR and its hook records samples there. That is the only write an
// experiment may do besides its findings file, and it is confined to a folder this module created under the system temp
// folder (marked with a file), so the hook process can open that folder again but no other. A path stays inside the
// folder (checked on its parent, through symlinks) and the file itself must be a plain file: a symlink or hard link at
// the final name is refused (safefile.ts), so it cannot lead out of the folder either.

const MARKER = '.crew-experiment-workspace';

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

const insideDir = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

function bind(dir: string): TempWorkspace {
  const root = realpathSync(dir);
  const resolveInside = (relativePath: string): string => {
    if (isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..'))
      throw new WorkspaceError('Workspace paths must be relative and stay inside the folder.');
    const target = resolve(root, relativePath);
    if (!insideDir(root, target))
      throw new WorkspaceError('Workspace paths must stay inside the folder.');
    return target;
  };
  // Checked before anything is created: the nearest folder that already exists must really be inside the workspace,
  // so a symlink planted inside it cannot make mkdir or write land elsewhere.
  const assertSafeToCreate = (target: string) => {
    let existing = target;
    while (!existsSync(existing)) {
      const parent = dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    if (!insideDir(root, realpathSync(existing)))
      throw new WorkspaceError('Workspace paths must stay inside the folder.');
  };
  const ensureParent = (target: string) => {
    assertSafeToCreate(dirname(target));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  };
  /** A refusal of the file itself (a symlink or hard link at its name) becomes a workspace error. */
  const refused = (error: unknown): never => {
    if (error instanceof UnsafeFileError)
      throw new WorkspaceError(
        `Workspace files must be plain files inside the folder. ${error.message}`,
      );
    throw error;
  };
  return {
    dir: root,
    path: resolveInside,
    write(relativePath, data) {
      const target = resolveInside(relativePath);
      ensureParent(target);
      try {
        writeFileNoFollow(target, data, 0o600);
      } catch (error) {
        return refused(error);
      }
      return target;
    },
    append(relativePath, data) {
      const target = resolveInside(relativePath);
      ensureParent(target);
      try {
        appendFileNoFollow(target, data, 0o600);
      } catch (error) {
        return refused(error);
      }
      return target;
    },
    mkdir(relativePath) {
      const target = resolveInside(relativePath);
      assertSafeToCreate(target);
      mkdirSync(target, { recursive: true, mode: 0o700 });
      return target;
    },
    read: (relativePath) => {
      const target = resolveInside(relativePath);
      assertSafeToCreate(dirname(target));
      try {
        return readFileNoFollow(target);
      } catch (error) {
        return refused(error);
      }
    },
    list: (relativePath = '.') => {
      const target = resolveInside(relativePath);
      if (!existsSync(target)) return [];
      assertSafeToCreate(target);
      return readdirSync(target)
        .filter((n) => n !== MARKER)
        .sort();
    },
  };
}

/** A new empty folder `<tmp>/<prefix>-XXXXXX`, mode 0700. */
export function createTempWorkspace(prefix: string, base: string = tmpdir()): TempWorkspace {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(prefix))
    throw new WorkspaceError('The workspace prefix must be lowercase letters, digits and dashes.');
  const dir = mkdtempSync(join(base, `${prefix}-`));
  writeFileNoFollow(join(dir, MARKER), 'created by an experiment script\n', 0o600);
  return bind(dir);
}

/** Opens a folder an earlier run created (the hook process uses this). Anything else is refused. */
export function openTempWorkspace(dir: string, base: string = tmpdir()): TempWorkspace {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    throw new WorkspaceError('That workspace folder does not exist.');
  }
  if (!insideDir(realpathSync(base), real) || real === realpathSync(base))
    throw new WorkspaceError('A workspace must be a folder under the system temp folder.');
  if (!existsSync(join(real, MARKER)))
    throw new WorkspaceError('That folder was not created by an experiment script.');
  return bind(real);
}
