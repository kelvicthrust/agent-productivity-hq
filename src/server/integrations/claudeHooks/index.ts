import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  CLAUDE_HOOK_EVENTS,
  ClaudeHooksFileReason,
  type ClaudeBackgroundWorkStatus,
  type ClaudeHooksAction,
  type ClaudeHooksFile,
  type ClaudeHooksOwnFile,
  type ClaudeHooksPlan,
  type ClaudeHooksStatus,
  type ExactPrompts,
} from '../../../shared/contracts/hq.ts';
import { claudeConfigDirs } from '../../collectors/discovery.ts';
import { FILE_MODE } from '../../lib/fsModes.ts';
import type { Logger } from '../../lib/logger.ts';
import { settingsTarget } from '../claudeCapture/settings.ts';
import { parseRegistryBytes } from './assets/claude-hook.mjs';
import { isSupportedCommand, renderHookCommand } from './command.ts';
import { nodeIsUsable, registryAsScriptReadsIt, scriptFileIsUsable } from './deliver.ts';
import { ClaudeHooksError, type HooksFailure, type LeftBehind } from './errors.ts';
import { editSettingsText } from './edit.ts';
import { createOwnFiles, isHqScript, parseRegistry, type Artifact, type Made } from './ownFiles.ts';
import { BACKUP_SUFFIX, HOOK_SCRIPT, REGISTRY_FILE, hookPaths, type HookPaths } from './paths.ts';
import { inspect, parseSettings, type EntryState, type ScriptScope } from './settings.ts';
import {
  backupConflicts,
  backupIsUnusable,
  editSettingsFiles,
  fileKey,
  hasUnlistedName,
  readSettingsFile,
  type Step,
} from './write.ts';

export { ClaudeHooksError, type HooksFailure, type LeftBehind };

// The opt-in switch that installs HQ's Claude Code hooks (data-and-sources › Claude Code hooks). `status()` is the preview: which
// settings files each action would change, which events, the exact command, one fingerprint per action (turn on, repair, turn off),
// and whether HQ's entries are there. `set(enabled, { preview })` installs, repairs or removes, only if the fingerprint is still the
// current one FOR THAT ACTION. A change is all-or-nothing across every targeted settings file (write.ts) and, when turning on, across
// HQ's own script and registry too: whatever it made is taken back on a failure, but only while it is still exactly what it wrote
// (anything the owner saved over meanwhile is left and named in the error's `left`). Reading a status writes nothing, and every state
// it reports is computed from what is on disk now, never from what an action meant to do.
//
// What "on" means: every targeted settings file holds exactly HQ's complete, unfiltered entries; the script is there with the content
// this app ships; and, once the server listens, the registry is published and reads back with this process's pid, port and token.
// Anything less is `needs_repair`, with the first reason that applies. "Off" with HQ's own files still in its folder is reported as
// such (`reason: cleanup_incomplete`, `leftover`), so a removal that could not finish is never reported as complete.

const SETTINGS_FILE = 'settings.json';
/** How long a computed `state()` is reused, so the HQ poll does not read the settings files twice a second. */
const STATE_CACHE_MS = 5_000;
const MAX_VERDICTS = 64;
const V1_2_0_SCRIPT_SHA256 = '23486d5311471d225e30c6d204c4f3a7821118dced86b910d72fa569901fbe29';

export interface ClaudeHooksOptions {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  home: string;
  /** The Node the hook runs under, absolute (default: the Node running the app). */
  nodePath?: string;
  logger: Logger;
  now?: () => number;
  /** Where the script is copied from (tests only). */
  assetPath?: string;
  pause?: (ms: number) => Promise<void>;
  /** Called at each step of a settings change (tests only: they act as the owner saving at exactly that moment). */
  onStep?: (step: Step, path: string) => void;
  /** The user a settings file must belong to (tests only; default: the user running HQ). */
  uid?: number;
  /** Whether the Node the command names can be run (tests only: they name a Node that does not exist here; default: a regular, executable file). */
  nodeUsable?: (path: string) => boolean;
  /** Tells the host when the hook can report after startup or an owner-confirmed change. */
  onDeliveryChange?: (enabled: boolean) => void;
  /** The owner's preference in HQ's private, resettable settings. */
  backgroundWork?: { read(): boolean; write(enabled: boolean): void };
  /** Controls admission and clears in-memory observations on opt-out. */
  onBackgroundWorkChange?: (enabled: boolean) => void;
}

export interface SetOptions {
  /** The `preview` fingerprint of the plan, for the action being confirmed, the owner was shown. When given, the change is made only if it is still the current one. */
  preview?: string | undefined;
  /** Only remove commands that name this data directory’s hook script. */
  currentInstallationOnly?: boolean;
}

export interface ClaudeHooks {
  readonly paths: HookPaths;
  /** The preview and current status. Reads the settings files; writes nothing. */
  status(): Promise<ClaudeHooksStatus>;
  /** `status().state`, reused for a few seconds. */
  state(): Promise<ExactPrompts>;
  /** Installs, repairs or removes HQ's entries, and returns the new status. Throws `ClaudeHooksError` with a fixed code. */
  set(enabled: boolean, options?: SetOptions): Promise<ClaudeHooksStatus>;
  backgroundWorkStatus(): Promise<ClaudeBackgroundWorkStatus>;
  setBackgroundWork(enabled: boolean): Promise<ClaudeBackgroundWorkStatus>;
  /** The server is listening: tell the hook script where. Writes the registry while the switch is on. */
  listening(address: { port: number; token: string }): Promise<void>;
  /** Waits for a change in flight and removes (or neutralises) the registry this process published. Safe to call more than once; never throws. */
  close(): Promise<void>;
}

const ASSET = join(import.meta.dirname, 'assets', 'claude-hook.mjs');

/** A path shown to the owner: `~/…` under the home folder, else as it is. */
export function displayPath(path: string, home: string): string {
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/** What turning the settings of one file one way would do: nothing, a change, or why HQ cannot. */
type Verdict = 'none' | 'change' | ClaudeHooksFileReason;

interface Inspected {
  path: string;
  /** The resolved file, or the path when it could not be resolved. */
  target: string;
  exists: boolean;
  /** The file's text; null when missing or unreadable. */
  text: string | null;
  /** sha256 of the file's bytes, 'missing', or `blocked:<reason>`. */
  digest: string;
  /** HQ's entries in the file, null when the file could not be read. */
  entries: EntryState | null;
  blocked: HooksFailure | null;
  /** The file's device and inode (the same for each of its hard links); null when it does not exist or could not be read. */
  inode: string | null;
  /** How many names the file has. */
  links: number;
  /** The one-time copy beside it (`<path>.agent-productivity-backup`) is empty or is not a settings file: the file is not replaced until the owner has looked at it. */
  backupUnusable: boolean;
}

type ScriptState = 'current' | 'missing' | 'differs';
/** Where the registry stands: not asked yet (the server is not listening), accepted as this process's by the hook script's own rules, or not. */
type RegistryState = 'idle' | 'delivers' | 'undelivered';

/** Every condition of HQ's own files that decides what an action lists and does; all of it is in the fingerprint. */
interface OwnState {
  script: ScriptState;
  /** Whether the Node the command names can be run. */
  node: boolean;
  registry: RegistryState;
  /** HQ's own files in its hook folder that HQ could remove: a script that is HQ's, and a registry of HQ's shape whose app is gone. */
  leftover: ClaudeHooksOwnFile[];
  /** Each of those as it was observed (bytes, device, inode): a turn-off deletes a leftover only while it is still exactly this. */
  leftoverMade: Partial<Record<ClaudeHooksOwnFile, Made>>;
}

interface Disk extends OwnState {
  files: Inspected[];
}

/** The per-file reason a blocked file is shown with: one of the contract's own, else `unreadable`. */
const fileReason = (blocked: HooksFailure): ClaudeHooksFileReason => {
  const known = ClaudeHooksFileReason.safeParse(blocked);
  return known.success ? known.data : 'unreadable';
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** A registry that HQ wrote and whose app is this one or gone: HQ's to delete. */
const isRemovableRegistry = (bytes: Buffer): boolean => {
  const registry = parseRegistry(bytes);
  return registry !== null && (registry.pid === process.pid || !alive(registry.pid));
};

/** What an artifact undo has to do: what this operation wrote, and what was there before. */
interface Undo {
  name: Artifact;
  wrote: Made;
  previous: Buffer | null;
}

export function createClaudeHooks(options: ClaudeHooksOptions): ClaudeHooks {
  const { logger, env, home } = options;
  const now = options.now ?? Date.now;
  const paths = hookPaths(options.dataDir);
  const node = options.nodePath ?? process.execPath;
  const nodeUsable = options.nodeUsable ?? nodeIsUsable;
  // The command HQ writes, and recognises: one description (command.ts). A path it cannot quote and read back means no command at all,
  // and nothing is ever written for it (`unsupported_path`).
  const description = { node, script: paths.script };
  const command: string | null = isSupportedCommand(description)
    ? renderHookCommand(description)
    : null;
  const asset = options.assetPath ?? ASSET;
  const own = createOwnFiles(paths);
  const ownFolder = displayPath(paths.dir, home);

  let chain: Promise<unknown> = Promise.resolve();
  let address: { port: number; token: string } | null = null;
  let closed = false;
  let cached: { at: number; state: ExactPrompts } | null = null;
  /**
   * What this process published: the bytes it wrote and the file they are in (device and inode). Kept current by EVERY operation on
   * the registry: a write sets it, and so does a restoration (an atomic replacement gives the restored registry a new inode, and the
   * record follows it). At shutdown the registry is removed while it is still exactly that: this process's bytes (pid, port, token) in
   * the file the record names, never a stale record of a file that has since been replaced by HQ itself.
   */
  let published: { text: string; made: Made } | null = null;
  /** What `textFor` decided for a file's bytes, so a poll does not redo it for a file that has not changed. */
  const verdicts = new Map<string, Verdict>();

  /** One at a time: a second change waits for the first. */
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  };

  /**
   * The user-level settings files of every Claude Code folder that exists, resolved now. Never a project's file. A file named twice
   * through a symlink chain, or in a folder named twice (by a link, a `..` segment, a different case on a case-insensitive disk), is one
   * target: it is identified by the folder it really is in and its name (`fileKey`). Two entries that only share an inode (hard links)
   * are two targets, each written and each given its own copy and plan line, because a rename updates one entry only.
   */
  function targets(): string[] {
    const seen = new Set<string>();
    const files: string[] = [];
    for (const raw of claudeConfigDirs({ env, home })) {
      const dir = resolve(raw);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const file = join(dir, SETTINGS_FILE);
      let key = fileKey(file);
      if (key === null) {
        try {
          key = settingsTarget(file);
        } catch {
          key = file; // an unresolvable file is reported as blocked, below
        }
      }
      if (seen.has(key)) continue;
      seen.add(key);
      files.push(file);
    }
    return files;
  }

  /** HQ's own files and folder, resolved, which a settings link, and a backup, must never be or be inside. */
  const forbidden = (): string[] =>
    [paths.script, paths.registry, paths.dir].map((path) => {
      try {
        return settingsTarget(path);
      } catch {
        return path;
      }
    });

  function inspectFile(path: string, scope?: ScriptScope): Inspected {
    try {
      const read = readSettingsFile(path, forbidden(), options.uid ?? process.getuid?.());
      const entries = inspect(parseSettings(read.text), command ?? '', scope);
      return {
        path,
        target: read.target,
        exists: read.exists,
        text: read.text,
        digest: read.digest,
        entries,
        blocked: read.writable ? null : 'not_writable',
        inode: read.inode,
        links: read.links,
        backupUnusable: false,
      };
    } catch (error) {
      const blocked = error instanceof ClaudeHooksError ? error.failure : 'unreadable';
      return {
        path,
        target: path,
        exists: existsSync(path),
        text: null,
        digest: `blocked:${blocked}`,
        entries: null,
        blocked,
        inode: null,
        links: 0,
        backupUnusable: false,
      };
    }
  }

  /**
   * The targeted files as they are now. A file whose one-time copy could not be a file of its own (the copy is the settings file, a
   * link or hard link to it or to another target or to an HQ file, or lies in HQ's folder) cannot be changed: it is blocked
   * (`not_writable`), here, so that the page says so before anything is pressed.
   */
  function inspectAll(scope?: ScriptScope): Inspected[] {
    const files = targets().map((path) => inspectFile(path, scope));
    const resolved = forbidden();
    for (const file of files) {
      if (file.blocked !== null) continue;
      const others = files.filter((other) => other !== file).map((other) => other.target);
      const backup = `${file.path}${BACKUP_SUFFIX}`;
      if (backupConflicts(backup, file.target, resolved, others)) file.blocked = 'not_writable';
      // A file with a name HQ was not given (a hard link elsewhere, or outside the folders it targets) would keep its old content under
      // that name after the rename: it is refused rather than updated in part. Each hard link that IS targeted is a target of its own.
      else if (
        file.inode !== null &&
        hasUnlistedName(file.links, files.filter((other) => other.inode === file.inode).length)
      )
        file.blocked = 'not_writable';
      else if (file.exists) file.backupUnusable = backupIsUnusable(backup);
    }
    return files;
  }

  const assetBytes = (): Buffer => readFileSync(asset);

  function scriptState(): ScriptState {
    try {
      const stat = own.stat(HOOK_SCRIPT);
      if (stat === null) return 'missing';
      const found = own.read(HOOK_SCRIPT);
      if (found === null) return 'missing';
      // Exactly the shipped bytes, in a file the command can run and nobody else can change.
      return found.equals(assetBytes()) && scriptFileIsUsable(stat, paths.script)
        ? 'current'
        : 'differs';
    } catch {
      return 'differs';
    }
  }

  /** Upgrade the trusted script shipped with v1.2.0 without changing Claude Code's settings. */
  function upgradePreviousScript(): boolean {
    const previous = own.identify(HOOK_SCRIPT);
    if (
      previous === null ||
      createHash('sha256').update(previous.bytes).digest('hex') !== V1_2_0_SCRIPT_SHA256
    ) {
      return false;
    }
    const stat = own.stat(HOOK_SCRIPT);
    if (
      stat === null ||
      stat.dev !== previous.dev ||
      stat.ino !== previous.ino ||
      stat.nlink !== 1 ||
      (stat.mode & 0o7777) !== FILE_MODE ||
      !scriptFileIsUsable(stat, paths.script)
    ) {
      return false;
    }
    return (
      own.replaceIfMade(HOOK_SCRIPT, previous, assetBytes()) !== 'left' &&
      scriptState() === 'current'
    );
  }

  /** HQ's own files that are in its folder and HQ could remove (never a file that is not HQ's, nor a registry of an app still running). */
  function leftoverFiles(): {
    items: ClaudeHooksOwnFile[];
    made: Partial<Record<ClaudeHooksOwnFile, Made>>;
  } {
    const items: ClaudeHooksOwnFile[] = [];
    const made: Partial<Record<ClaudeHooksOwnFile, Made>> = {};
    // (not a regular file in a real folder: `identify` says nothing, so it is not HQ's to remove and not a leftover)
    const script = own.identify(HOOK_SCRIPT);
    if (script !== null && isHqScript(script.bytes)) {
      items.push('script');
      made.script = script;
    }
    const registry = own.identify(REGISTRY_FILE);
    if (registry !== null && isRemovableRegistry(registry.bytes)) {
      items.push('registry');
      made.registry = registry;
    }
    return { items, made };
  }

  const backgroundWorkEnabled = (): boolean => options.backgroundWork?.read() === true;

  const registryText = (backgroundWork: boolean): string => {
    if (address === null) return '';
    return `${JSON.stringify({
      v: 1,
      pid: process.pid,
      port: address.port,
      token: address.token,
      ...(backgroundWork ? { backgroundWork: true } : {}),
    })}\n`;
  };

  /**
   * Whether the registry on disk is this process's AND the installed script would accept it (its own trust and reading rules, deliver.ts).
   * Only asked once the server listens.
   */
  function registryState(backgroundWork?: boolean): RegistryState {
    if (address === null) return 'idle';
    try {
      if (own.identify(REGISTRY_FILE) === null) return 'undelivered';
      const read = registryAsScriptReadsIt(paths.dir);
      return read !== null &&
        read.pid === process.pid &&
        read.port === address.port &&
        read.token === address.token &&
        (backgroundWork === undefined || (read.backgroundWork === true) === backgroundWork)
        ? 'delivers'
        : 'undelivered';
    } catch {
      return 'undelivered';
    }
  }

  const ownState = (): OwnState => {
    const left = leftoverFiles();
    return {
      script: scriptState(),
      node: command === null || nodeUsable(node),
      registry: registryState(),
      leftover: left.items,
      leftoverMade: left.made,
    };
  };

  const readDisk = (scope?: ScriptScope): Disk => ({ files: inspectAll(scope), ...ownState() });

  /** The text for one settings file, or null for "nothing to change" (edit.ts). Turning on needs a command. */
  function textFor(text: string | null, enabled: boolean, scope?: ScriptScope): string | null {
    if (enabled && command === null) throw new ClaudeHooksError('unsupported_path');
    return editSettingsText(text, command ?? '', enabled, scope);
  }

  /** What `enabled` would do to this file: computed once per distinct content. */
  function verdictOf(file: Inspected, enabled: boolean, scope?: ScriptScope): Verdict {
    if (file.blocked !== null) return fileReason(file.blocked);
    const key = `${enabled}\0${file.target}\0${file.digest}\0${command ?? ''}\0${scope ? 'scoped' : ''}`;
    const known = verdicts.get(key);
    if (known !== undefined) return known;
    let verdict: Verdict;
    try {
      verdict = textFor(file.text, enabled, scope) === null ? 'none' : 'change';
    } catch (error) {
      verdict =
        error instanceof ClaudeHooksError ? fileReason(error.failure) : 'unsupported_layout';
    }
    if (verdicts.size >= MAX_VERDICTS) verdicts.clear();
    verdicts.set(key, verdict);
    return verdict;
  }

  /** The verdict of the action on the file, and, for a change the file's one-time copy would block, why (it is not replaced). */
  const verdictWithBackup = (file: Inspected, enabled: boolean, scope?: ScriptScope): Verdict => {
    const verdict = verdictOf(file, enabled, scope);
    return verdict === 'change' && file.backupUnusable ? 'backup_unusable' : verdict;
  };

  const rowOf = (file: Inspected) => ({
    target: file.target,
    digest: file.digest,
    state: file.blocked !== null ? 'blocked' : (file.entries ?? 'absent'),
    backupUnusable: file.backupUnusable,
  });

  /** Each leftover file as it was seen (name, device, inode, digest of its bytes): a plan that deletes it is for exactly that file. */
  const leftoverKey = (state: OwnState): (string | number | null)[][] =>
    state.leftover.map((name) => {
      const seen = state.leftoverMade[name];
      return [
        name,
        seen?.dev ?? null,
        seen?.ino ?? null,
        seen === undefined ? null : createHash('sha256').update(seen.bytes).digest('hex'),
      ];
    });

  /**
   * What `preview` is the hash of: the action, the command, every observed condition of HQ's own files that decides what the plan
   * lists (the script, the Node, the registry, what is left behind: `OwnState`), the settings bytes and whether a backup blocks an edit.
   * Another action has another fingerprint for the very same files.
   */
  function fingerprint(
    action: ClaudeHooksAction,
    rows: readonly ReturnType<typeof rowOf>[],
    state: OwnState,
  ): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          v: 5,
          action,
          command: command ?? '',
          events: CLAUDE_HOOK_EVENTS,
          script: state.script,
          node: state.node,
          registry: state.registry,
          // each leftover as it was seen (bytes, device, inode): the plan to delete it is for exactly that file
          leftover: leftoverKey(state),
          files: rows,
        }),
      )
      .digest('hex');
  }

  /** The action `set(enabled)` is: turn off; turn on when no file holds an entry of HQ's; else repair. */
  const actionOf = (enabled: boolean, files: readonly Inspected[]): ClaudeHooksAction =>
    !enabled
      ? 'off'
      : files.some((file) => file.entries === 'present' || file.entries === 'needs_repair')
        ? 'repair'
        : 'on';

  /** The file as it is shown: blocked, with a reason, when it cannot be read or `blockedFor` says its edit cannot be made. */
  function view(file: Inspected, edit: Verdict): ClaudeHooksFile {
    const reason =
      file.blocked !== null
        ? fileReason(file.blocked)
        : edit !== 'none' && edit !== 'change'
          ? edit
          : null;
    return {
      path: displayPath(file.path, home),
      exists: file.exists,
      state: reason !== null ? 'blocked' : (file.entries ?? 'absent'),
      reason,
    };
  }

  /**
   * The plan for one action over `disk`: the files it writes, HQ's own files it writes or deletes, and its fingerprint. The plan is
   * exact: a file is listed when the action writes, replaces or deletes it, and an action touches nothing it does not list (a script
   * that is current, a registry the hook script already accepts, a settings file that already holds exactly HQ's entries are left
   * alone, not even rewritten with the same bytes).
   */
  function planFor(action: ClaudeHooksAction, disk: Disk, scope?: ScriptScope): ClaudeHooksPlan {
    const enabled = action !== 'off';
    const files: ClaudeHooksFile[] = [];
    for (const file of disk.files) {
      const verdict = verdictWithBackup(file, enabled, scope);
      if (verdict !== 'none') files.push(view(file, verdict));
    }
    const ownFiles: ClaudeHooksOwnFile[] = [];
    if (action === 'off') ownFiles.push(...disk.leftover);
    else {
      if (disk.script !== 'current') ownFiles.push('script');
      if (
        disk.registry === 'undelivered' ||
        (address !== null &&
          registryState(action === 'repair' && backgroundWorkEnabled()) !== 'delivers')
      )
        ownFiles.push('registry');
    }
    return {
      preview: fingerprint(action, disk.files.map(rowOf), disk),
      files,
      ownFiles,
    };
  }

  /** The state of the switch, from what is on disk. `blockedOn` is why a file cannot be turned on, when none can be read as blocked. */
  function stateOf(disk: Disk): {
    state: ExactPrompts;
    reason: ClaudeHooksStatus['reason'];
    actions: ClaudeHooksAction[];
  } {
    const { files } = disk;
    if (files.length === 0)
      return { state: 'unavailable', reason: 'no_claude_folder', actions: [] };
    const hasEntries = files.some(
      (file) => file.entries === 'present' || file.entries === 'needs_repair',
    );
    if (command === null)
      return hasEntries
        ? { state: 'needs_repair', reason: 'unsupported_path', actions: ['off'] }
        : { state: 'unavailable', reason: 'unsupported_path', actions: [] };
    if (files.some((file) => file.blocked !== null))
      return { state: 'unavailable', reason: 'settings_blocked', actions: [] };
    if (files.every((file) => file.entries === 'absent')) {
      if (
        files.some(
          (file) =>
            verdictWithBackup(file, true) !== 'change' && verdictWithBackup(file, true) !== 'none',
        )
      )
        return { state: 'unavailable', reason: 'settings_blocked', actions: [] };
      return disk.leftover.length > 0
        ? { state: 'off', reason: 'cleanup_incomplete', actions: ['on', 'off'] }
        : { state: 'off', reason: null, actions: ['on'] };
    }
    if (!files.every((file) => file.entries === 'present'))
      return { state: 'needs_repair', reason: 'entries_changed', actions: ['repair', 'off'] };
    if (disk.script !== 'current')
      return { state: 'needs_repair', reason: 'script_missing', actions: ['repair', 'off'] };
    // Repair cannot make a Node exist: the entries already name the one this app runs under, so only a restart (or turning off) helps.
    if (!disk.node) return { state: 'needs_repair', reason: 'node_missing', actions: ['off'] };
    if (disk.registry === 'undelivered')
      return { state: 'needs_repair', reason: 'registry_unpublished', actions: ['repair', 'off'] };
    return { state: 'on', reason: null, actions: ['off'] };
  }

  function compute(withPlans: boolean): ClaudeHooksStatus {
    const disk = readDisk();
    const { state, reason, actions } = stateOf(disk);
    // A file that cannot be turned on is shown as blocked (with why) in the state that says so.
    const unavailable = state === 'unavailable' && reason === 'settings_blocked';
    const files = disk.files.map((file) =>
      view(file, unavailable && file.blocked === null ? verdictWithBackup(file, true) : 'none'),
    );
    const plans: ClaudeHooksStatus['plans'] = {};
    if (withPlans) for (const action of actions) plans[action] = planFor(action, disk);
    const first = actions[0];
    return {
      state,
      reason,
      files,
      events: [...CLAUDE_HOOK_EVENTS],
      command: command ?? '',
      preview: fingerprint(first ?? 'on', disk.files.map(rowOf), disk),
      plans,
      leftover:
        disk.leftover.length > 0 && state === 'off'
          ? { folder: ownFolder, items: disk.leftover }
          : null,
      ownFolder,
    };
  }

  /**
   * Whether an HQ entry is installed, including when the Node path changed but the hook still names this script.
   */
  function switchHasEntries(): boolean {
    const found = inspectAll();
    return (
      found.length > 0 &&
      found.every((file) => file.blocked === null) &&
      found.some((file) => file.entries !== 'absent')
    );
  }

  const warn = (message: string, code: string): void =>
    logger.warn(message, { source: 'hq_hooks', code });

  /**
   * Publishes where the server listens. Throws `registry_failed` when it cannot be written, is not what the installed script would
   * accept, or does not read back; what it wrote is then in `undo` (when given) so that the caller takes it back, and only while it is
   * still exactly what was written.
   */
  function publish(backgroundWork: boolean, undo?: Undo[]): void {
    if (address === null) throw new ClaudeHooksError('registry_failed');
    const text = registryText(backgroundWork);
    // A token or port the hook script would refuse is never published.
    if (parseRegistryBytes(Buffer.from(text, 'utf8')) === null)
      throw new ClaudeHooksError('registry_failed');
    let previous: Buffer | null = null;
    try {
      previous = own.read(REGISTRY_FILE);
    } catch {
      previous = null;
    }
    let made: Made;
    try {
      made = own.write(REGISTRY_FILE, text);
    } catch {
      throw new ClaudeHooksError('registry_failed');
    }
    undo?.push({ name: REGISTRY_FILE, wrote: made, previous });
    let back: Buffer | null = null;
    try {
      back = own.read(REGISTRY_FILE);
    } catch {
      back = null;
    }
    if (
      back === null ||
      back.toString('utf8') !== text ||
      registryState(backgroundWork) !== 'delivers'
    ) {
      if (undo === undefined) own.removeIfMade(REGISTRY_FILE, made);
      throw new ClaudeHooksError('registry_failed');
    }
    published = { text, made };
  }

  /** Takes back what a failed turn-on wrote, newest first, each only while it is still exactly what was written. Returns what was left. */
  function undoArtifacts(undo: Undo[], wasPublished: typeof published): LeftBehind[] {
    const left = new Set<LeftBehind>();
    // What this process had published before the change is what is on disk again (or nothing): the record goes back with it, and it
    // follows the file when the restoration gave the registry a new inode.
    published = wasPublished;
    for (const step of undo.reverse()) {
      let restored: boolean;
      try {
        if (step.previous === null) restored = own.removeIfMade(step.name, step.wrote) !== 'left';
        else {
          const back = own.replaceIfMade(step.name, step.wrote, step.previous);
          restored = back !== 'left';
          if (
            back !== 'left' &&
            step.name === REGISTRY_FILE &&
            wasPublished !== null &&
            step.previous.toString('utf8') === wasPublished.text
          )
            published = { text: wasPublished.text, made: back };
        }
      } catch {
        restored = false;
      }
      if (!restored) left.add(step.name === HOOK_SCRIPT ? 'script' : 'registry');
    }
    if (left.size > 0) warn('hq hooks cleanup incomplete', 'cleanup_incomplete');
    return [...left];
  }

  /**
   * Puts in place the script and the registry the plan lists, and ONLY those. Returns what undoes it.
   */
  function prepareArtifacts(
    write: readonly ClaudeHooksOwnFile[],
    backgroundWork: boolean,
  ): {
    undo: Undo[];
    wasPublished: typeof published;
  } {
    const undo: Undo[] = [];
    const wasPublished = published;
    try {
      if (write.includes('script')) {
        let previousScript: Buffer | null = null;
        try {
          previousScript = own.read(HOOK_SCRIPT);
        } catch {
          previousScript = null;
        }
        undo.push({
          name: HOOK_SCRIPT,
          wrote: own.write(HOOK_SCRIPT, assetBytes()),
          previous: previousScript,
        });
      }
      if (write.includes('registry')) publish(backgroundWork, undo);
    } catch (error) {
      const left = undoArtifacts(undo, wasPublished);
      const failure =
        error instanceof ClaudeHooksError ? error : new ClaudeHooksError('not_writable');
      throw failure.with(left);
    }
    return { undo, wasPublished };
  }

  /**
   * What a turn-off does with HQ's own files: it deletes the files THE CONFIRMED PLAN lists (`items`, each as the plan recorded it in
   * `recorded`: bytes, device, inode) and nothing else, each only while it is still exactly that file. A file the plan did not list
   * (one that appeared, or came back, since the plan was made) or that is not what the plan recorded (the owner saved over it) is left
   * where it is and reported. A recorded file that cannot be removed (the folder is read-only) stays, a registry that stays is
   * neutralised where it can be rewritten (and is still exactly what the plan recorded), and what remains is reported by the next
   * status (`leftover`), never as a success.
   */
  function cleanUp(
    items: readonly ClaudeHooksOwnFile[],
    recorded: Partial<Record<ClaudeHooksOwnFile, Made>>,
  ): void {
    const registry = recorded.registry;
    if (items.includes('registry') && registry !== undefined) {
      const result = own.removeIfMade(REGISTRY_FILE, registry);
      if (result === 'removed' || result === 'absent') published = null;
      else own.neutralise(REGISTRY_FILE, registry);
    }
    const script = recorded.script;
    if (items.includes('script') && script !== undefined) own.removeIfMade(HOOK_SCRIPT, script);
    // Whatever HQ's own files are still there afterwards (not removable, or not in the plan) is said, not hidden.
    if (leftoverFiles().items.length > 0) warn('hq hooks cleanup incomplete', 'cleanup_incomplete');
  }

  /** What the conditions of HQ's own files are, as one string: two reads that give the same string saw the same thing. */
  const ownKey = (state: OwnState): string =>
    JSON.stringify([state.script, state.node, state.registry, leftoverKey(state)]);

  async function change(enabled: boolean, setOptions: SetOptions): Promise<ClaudeHooksAction> {
    const { preview } = setOptions;
    const scoped = !enabled && setOptions.currentInstallationOnly;
    const scriptKey = scoped ? fileKey(paths.script) : null;
    const scope: ScriptScope | undefined = scoped
      ? (candidate) =>
          candidate === paths.script || (scriptKey !== null && scriptKey === fileKey(candidate))
      : undefined;
    if (enabled && command === null) throw new ClaudeHooksError('unsupported_path');
    const readForChange = (): Disk => {
      const disk = readDisk(scope);
      if (scope === undefined) return disk;
      const hasArtifacts = disk.script !== 'missing' || disk.leftover.length > 0;
      // An unrelated invalid settings file should not prevent reset when no owned hook can run.
      return {
        ...disk,
        files: disk.files.filter(
          (file) => file.entries !== 'absent' && (file.entries !== null || hasArtifacts),
        ),
      };
    };
    const disk = readForChange();
    if (enabled && disk.files.length === 0) throw new ClaudeHooksError('no_folder');
    const action = actionOf(enabled, disk.files);
    // The plan the owner confirmed must be the plan for THIS action that is in front of HQ now; checked again on the very bytes the
    // change is computed from.
    const current = (rows: ReturnType<typeof rowOf>[], state: OwnState): string =>
      fingerprint(action, rows, state);
    const confirmed = current(disk.files.map(rowOf), disk);
    if (preview !== undefined && confirmed !== preview) throw new ClaudeHooksError('stale_preview');
    // Everything is checked before anything is written, so a file that cannot be changed stops the whole change.
    for (const file of disk.files) {
      const needsChange = enabled || file.entries !== 'absent';
      if (!needsChange) continue;
      const verdict = verdictWithBackup(file, enabled, scope);
      if (verdict === 'backup_unusable')
        throw new ClaudeHooksError(verdict, [displayPath(`${file.path}${BACKUP_SUFFIX}`, home)]);
      if (verdict !== 'none' && verdict !== 'change') throw new ClaudeHooksError(verdict);
    }
    // The plan is derived again immediately before anything is written, and the action goes on only if it is the very plan confirmed
    // (a file of HQ's own, or a setting, that changed meanwhile makes it another plan).
    const again = readForChange();
    if (current(again.files.map(rowOf), again) !== confirmed)
      throw new ClaudeHooksError('stale_preview');
    const plan = planFor(action, again, scope);
    // A fresh wait-hook install is a separate decision from consenting to background reporting.
    const artifacts = enabled
      ? prepareArtifacts(plan.ownFiles, action === 'repair' && backgroundWorkEnabled())
      : null;
    // What HQ's own files are once this action has written its part of them: anything else seen later was changed by somebody else.
    const expected = ownKey(artifacts === null ? again : ownState());
    try {
      await editSettingsFiles(
        again.files.map((file) => ({ path: file.path, backup: `${file.path}${BACKUP_SUFFIX}` })),
        (seen) => {
          if (preview !== undefined) {
            const rows = seen.map((file) => ({
              target: file.target,
              digest: file.digest,
              state:
                file.text === null
                  ? 'absent'
                  : inspect(parseSettings(file.text), command ?? '', scope),
              backupUnusable:
                file.text !== null && backupIsUnusable(`${file.path}${BACKUP_SUFFIX}`),
            }));
            if (current(rows, again) !== preview) throw new ClaudeHooksError('stale_preview');
          }
          if (ownKey(ownState()) !== expected) throw new ClaudeHooksError('stale_preview');
          return seen.map((file) => textFor(file.text, enabled, scope));
        },
        {
          forbidden: forbidden(),
          label: (path) => displayPath(path, home),
          report: () => warn('hq hooks cleanup incomplete', 'cleanup_incomplete'),
          ...(options.pause === undefined ? {} : { pause: options.pause }),
          ...(options.onStep === undefined ? {} : { onStep: options.onStep }),
          ...(options.uid === undefined ? {} : { uid: options.uid }),
        },
      );
    } catch (error) {
      // Unless a file could not be put back (then some file may hold HQ's entries, and the script and the registry must stay for
      // them), a change that failed leaves nothing behind: the script and the registry are only there for the entries.
      if (
        artifacts !== null &&
        !(error instanceof ClaudeHooksError && error.failure === 'rollback_failed')
      ) {
        const left = undoArtifacts(artifacts.undo, artifacts.wasPublished);
        if (error instanceof ClaudeHooksError) throw error.with(left);
      }
      throw error;
    }
    if (!enabled) cleanUp(plan.ownFiles, again.leftoverMade);
    return action;
  }

  function backgroundWorkStatus(): ClaudeBackgroundWorkStatus {
    return {
      enabled: backgroundWorkEnabled(),
      available:
        options.backgroundWork !== undefined &&
        !closed &&
        address !== null &&
        compute(false).state === 'on',
    };
  }

  return {
    paths,
    status: async () => compute(true),
    async state() {
      if (cached !== null && now() - cached.at < STATE_CACHE_MS) return cached.state;
      // The roster asks this on every poll: whatever goes wrong reading the files is "unavailable", never an error in /api/hq.
      let state: ExactPrompts;
      try {
        state = compute(false).state;
      } catch {
        return 'unavailable';
      }
      cached = { at: now(), state };
      return state;
    },
    set(enabled, setOptions = {}) {
      return exclusive(async () => {
        if (closed) throw new ClaudeHooksError('no_folder');
        cached = null;
        let action: ClaudeHooksAction;
        try {
          action = await change(enabled, setOptions);
        } catch (error) {
          // Whatever went wrong, the caller gets a fixed code: an error's own text (a path) never leaves this module.
          const failure =
            error instanceof ClaudeHooksError ? error : new ClaudeHooksError('not_writable');
          warn('hq hooks failed', failure.failure);
          throw failure;
        }
        cached = null;
        options.onDeliveryChange?.(enabled && published !== null);
        options.onBackgroundWorkChange?.(
          action === 'repair' && published !== null && backgroundWorkEnabled(),
        );
        logger.info(enabled ? 'hq hooks enabled' : 'hq hooks disabled', { source: 'hq_hooks' });
        // What is reported is what is on disk now, not what the change meant to do.
        try {
          if (action !== 'repair' && backgroundWorkEnabled()) options.backgroundWork?.write(false);
          if (!enabled && setOptions.currentInstallationOnly && leftoverFiles().items.length > 0)
            throw new ClaudeHooksError('not_writable');
          return compute(true);
        } catch {
          throw new ClaudeHooksError('not_writable');
        }
      });
    },
    backgroundWorkStatus: async () => backgroundWorkStatus(),
    setBackgroundWork(enabled) {
      return exclusive(async () => {
        const current = backgroundWorkStatus();
        const preference = options.backgroundWork;
        if (closed || preference === undefined || (enabled && !current.available)) {
          throw new ClaudeHooksError('no_folder');
        }
        const undo: Undo[] = [];
        const before = published;
        if (!enabled) {
          if (current.enabled) preference.write(false);
          options.onBackgroundWorkChange?.(false);
          // The old registry still delivers wait events if replacement fails. Admission already drops its task data.
          if (registryState(true) === 'delivers') {
            try {
              publish(false, undo);
            } catch {
              undoArtifacts(undo, before);
              warn('hq hooks registry failed', 'registry_failed');
            }
          }
          return { ...current, enabled: false };
        }

        if (current.enabled) return current;
        try {
          publish(true, undo);
          preference.write(true);
        } catch (error) {
          const left = undoArtifacts(undo, before);
          const failure =
            error instanceof ClaudeHooksError ? error : new ClaudeHooksError('registry_failed');
          throw failure.with(left);
        }

        options.onBackgroundWorkChange?.(true);
        return { ...current, enabled: true };
      });
    },
    listening(next) {
      return exclusive(async () => {
        address = next;
        if (closed) return;
        try {
          if (switchHasEntries() && (scriptState() === 'current' || upgradePreviousScript())) {
            const backgroundWork = backgroundWorkEnabled();
            if (registryState(backgroundWork) !== 'delivers') publish(backgroundWork);
            else {
              const found = own.identify(REGISTRY_FILE);
              if (found !== null) published = { text: registryText(backgroundWork), made: found };
            }
            options.onDeliveryChange?.(published !== null);
            options.onBackgroundWorkChange?.(published !== null && backgroundWork);
            cached = null;
          } else if (leftoverFiles().items.length > 0)
            warn('hq hooks cleanup incomplete', 'cleanup_incomplete');
        } catch {
          warn('hq hooks registry failed', 'registry_failed');
        }
      });
    },
    async close() {
      closed = true;
      try {
        await chain;
      } catch {
        // a change that failed has already told its caller
      }
      address = null;
      cached = null;
      options.onBackgroundWorkChange?.(false);
      // Only the registry this process published, and only while it is still exactly what the record names (this process's bytes in
      // the file the record follows): removed, else (the folder cannot be written) made to hold no token, and the next start reports
      // what is left. Anything else there is another process's, or the owner's, and is left exactly as it is.
      const mine = published;
      published = null;
      if (mine === null) return;
      try {
        if (own.removeIfMade(REGISTRY_FILE, mine.made) === 'left') {
          own.neutralise(REGISTRY_FILE, mine.made);
          warn('hq hooks cleanup incomplete', 'cleanup_incomplete');
        }
      } catch {
        warn('hq hooks cleanup incomplete', 'cleanup_incomplete');
      }
    },
  };
}

/** A fresh random token for the hook endpoint: 32 bytes, URL-safe. */
export const newHookToken = (): string => randomBytes(32).toString('base64url');
