import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '../db/open.ts';
import { getSourceState, recordDiscovery } from '../db/queries/sources.ts';
import type { Logger } from '../lib/logger.ts';
import { classifyTranscript, projectRoots } from './claude/files.ts';
import { createClaudeAdapter } from './claude/index.ts';
import { findRollouts } from './codex/files.ts';
import { createCodexAdapter } from './codex/index.ts';
import {
  SOURCE_LABELS,
  classifyFsError,
  deniedMessage,
  listFiles,
  notFoundMessage,
  type ListedFile,
  type LocalSourceId,
} from './ingest/index.ts';
import type { SourceAdapter } from './types.ts';

// Automatic discovery of Claude Code and Codex on this machine (TECH › Discovery: no picker, no import).
//
// Discovery only LOOKS. It lists the places each provider documents (the default folders and the override variables), says what is
// there, and records that on the source's row. It never reads a transcript, never writes a usage row and never asks for a path.
// The adapters are given the same folders by `createLocalAdapters`, so what discovery found is what an import reads.
//
// Everything here is a function of `{ env, home }`: boot passes `process.env` and the home folder, tests pass a temp folder.
// Nothing in this file reads the process environment or asks the operating system for the home folder.
//
// What a look can say (`DiscoveryStatus`):
//   ok        a transcript or rollout can be read, and nothing around it is blocked
//   partial   some can be read, and something else (a root, a folder, a file) is blocked
//   denied    the data is here and none of it can be read (EACCES or EPERM)
//   notfound  no folder, or folders with no transcript or rollout in them: the provider has not run here
// A discovery never says `failed`: that is the word for an attempt that ran. A root that fails for another reason (EIO, ELOOP) is
// counted with the blocked ones, and the attempt that follows records what really happened, with its own code.

export type DiscoveryStatus = 'ok' | 'notfound' | 'denied' | 'partial';

export interface DiscoveryResult {
  status: DiscoveryStatus;
  /** Every folder that was checked, in order, whether it was there or not. */
  roots: string[];
  /** Where the source was found, shown in mono: the first readable folder, or the first blocked one when none is readable. */
  location: string | null;
  /** Transcripts or rollouts that can be read. */
  files: number;
  /** One plain sentence for `notfound` and `denied`. Never a path, a file name or file content. */
  message?: string;
}

export type DiscoveryEnv = Readonly<Record<string, string | undefined>>;

export interface DiscoveryInput {
  env: DiscoveryEnv;
  /** The home folder `~` stands for. */
  home: string;
}

// ---- where to look --------------------------------------------------------------------------------------------------------

/** A comma-separated override: each entry trimmed, empty ones dropped, a leading `~` read as the home folder, repeats removed. */
function overrideList(value: string | undefined, home: string): string[] {
  const entries = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) =>
      entry === '~' ? home : entry.startsWith('~/') ? join(home, entry.slice(2)) : entry,
    );
  return [...new Set(entries)];
}

/** `$CODEX_HOME` (each comma-separated entry), else `~/.codex`. Each holds `sessions/` and `archived_sessions/`. */
export function codexHomes({ env, home }: DiscoveryInput): string[] {
  const given = overrideList(env['CODEX_HOME'], home);
  return given.length > 0 ? given : [join(home, '.codex')];
}

/** `$CLAUDE_CONFIG_DIR` (each comma-separated entry), else `~/.config/claude` and `~/.claude`. Each holds `projects/`. */
export function claudeConfigDirs({ env, home }: DiscoveryInput): string[] {
  const given = overrideList(env['CLAUDE_CONFIG_DIR'], home);
  return given.length > 0 ? given : [join(home, '.config', 'claude'), join(home, '.claude')];
}

/**
 * The two local adapters, looking where discovery looks. The folders are worked out again at the start of every attempt, so an
 * override changed in `env` is seen without a restart (pass the live `process.env`, not a copy, to get that).
 */
export function createLocalAdapters(input: DiscoveryInput): SourceAdapter[] {
  return [
    createCodexAdapter({ homes: () => codexHomes(input) }),
    createClaudeAdapter({ configDirs: () => claudeConfigDirs(input) }),
  ];
}

// ---- looking ----------------------------------------------------------------------------------------------------------------

/** What a look at one source's folders found, before it is put into words. */
interface Looked {
  roots: string[];
  location: string | null;
  files: ListedFile[];
  /** Roots that are there and could not be read, and folders below a readable root that could not be. */
  blocked: number;
  /** The first blocked root, for the location when nothing at all can be read. */
  blockedAt: string | null;
}

const FILES_PER_BATCH = 64;

/** How many of these files exist but cannot be opened by this user. A file that vanished meanwhile is not counted. */
async function unreadableAmong(files: readonly ListedFile[]): Promise<number> {
  let denied = 0;
  for (let at = 0; at < files.length; at += FILES_PER_BATCH) {
    const results = await Promise.all(
      files.slice(at, at + FILES_PER_BATCH).map(async ({ path }) => {
        try {
          await access(path, constants.R_OK);
          return false;
        } catch (error) {
          return classifyFsError(error).kind !== 'notfound';
        }
      }),
    );
    denied += results.filter(Boolean).length;
  }
  return denied;
}

async function lookAtCodex(homes: readonly string[]): Promise<Looked> {
  const roots = [...new Set(homes)].flatMap((home) => [
    join(home, 'sessions'),
    join(home, 'archived_sessions'),
  ]);
  const found = await findRollouts(homes);
  if (found.outcome === 'files') {
    return {
      roots,
      location: found.location,
      files: found.files,
      blocked: found.inaccessible,
      blockedAt: null,
    };
  }
  if (found.outcome === 'notfound')
    return { roots, location: null, files: [], blocked: 0, blockedAt: null };
  return { roots, location: found.location, files: [], blocked: 1, blockedAt: found.location };
}

async function lookAtClaude(configDirs: readonly string[]): Promise<Looked> {
  const roots = await projectRoots(configDirs);
  const files: ListedFile[] = [];
  const seen = new Set<string>();
  let location: string | null = null;
  let blocked = 0;
  let blockedAt: string | null = null;
  for (const root of roots) {
    const listing = await listFiles(root, (rel) => classifyTranscript(rel) !== null);
    if (listing.state === 'ok') {
      location ??= root;
      blocked += listing.inaccessible;
      for (const file of listing.files) {
        if (seen.has(file.path)) continue;
        seen.add(file.path);
        files.push(file);
      }
    } else if (listing.state !== 'notfound') {
      blocked += 1;
      blockedAt ??= root;
    }
  }
  return { roots, location: location ?? blockedAt, files, blocked, blockedAt };
}

/** Puts a look into one of the four words. A readable file decides found; anything blocked beside it makes it partial. */
async function decide(source: LocalSourceId, looked: Looked): Promise<DiscoveryResult> {
  const unreadable = await unreadableAmong(looked.files);
  const readable = looked.files.length - unreadable;
  const blocked = looked.blocked + unreadable;
  const base = { roots: looked.roots, files: readable };
  if (readable > 0)
    return { ...base, status: blocked > 0 ? 'partial' : 'ok', location: looked.location };
  if (blocked > 0) {
    return {
      ...base,
      status: 'denied',
      location: looked.blockedAt ?? looked.location,
      message: deniedMessage(source),
    };
  }
  return { ...base, status: 'notfound', location: null, message: notFoundMessage(source) };
}

export type DiscoveryReport = Record<LocalSourceId, DiscoveryResult>;

/** Looks for both local sources. Imports nothing, writes nothing, never prompts. */
export async function discoverLocalSources(input: DiscoveryInput): Promise<DiscoveryReport> {
  const [codex, claude] = await Promise.all([
    lookAtCodex(codexHomes(input)).then((looked) => decide('codex', looked)),
    lookAtClaude(claudeConfigDirs(input)).then((looked) => decide('claude', looked)),
  ]);
  return { codex, claude };
}

// ---- recording --------------------------------------------------------------------------------------------------------------

/**
 * What a source's row says after a look (TECH › Discovery), without recording an attempt:
 *   notfound, denied  always: what the machine says now is what Sources shows, history or not
 *   ok, partial       only for a source nothing has attempted yet. After an attempt the row's `ok`, `partial` or `failed` is the
 *                     attempt's own word (it counted unreadable lines, it saw the error code), and a look must never overwrite it.
 * `last_attempt_*`, `last_success_at` and `consecutive_failures` are never touched here: a look is not an attempt.
 */
export function recordDiscoveries(db: Db, report: DiscoveryReport): void {
  for (const source of Object.keys(SOURCE_LABELS) as LocalSourceId[]) {
    const result = report[source];
    const attempted = (getSourceState(db, source)?.lastAttemptAt ?? null) !== null;
    if (result.status !== 'notfound' && result.status !== 'denied' && attempted) continue;
    recordDiscovery(db, { sourceId: source, status: result.status, location: result.location });
  }
}

/** Look, then record. What setup's "Check again" and the refresh's first step both do. */
export async function checkLocalSources(
  db: Db,
  input: DiscoveryInput,
  logger?: Logger,
): Promise<DiscoveryReport> {
  const report = await discoverLocalSources(input);
  recordDiscoveries(db, report);
  // Counts and a status only: a path or a file name could carry a project name.
  for (const source of Object.keys(report) as LocalSourceId[]) {
    logger?.debug('discovery', {
      source,
      status: report[source].status,
      files: report[source].files,
    });
  }
  return report;
}

/**
 * The step the runner takes before it attempts any source (`RunnerDeps.beforeSources`): a fresh look at both local sources, so
 * a folder that appeared, disappeared or changed permissions since the last run is on the row before the attempt reads it.
 */
export function createDiscoveryStep(options: {
  db: Db;
  env: DiscoveryEnv;
  home: string;
  logger?: Logger;
}): { name: string; run: () => Promise<void> } {
  return {
    name: 'discovery',
    run: async () => {
      await checkLocalSources(options.db, { env: options.env, home: options.home }, options.logger);
    },
  };
}
