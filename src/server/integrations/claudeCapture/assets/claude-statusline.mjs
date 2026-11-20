// Agent Productivity: the Claude Code status-line hook (data-and-sources › Status-line snapshot).
//
// Claude Code runs this on every status-line update and writes its session JSON to stdin. It is copied to
// <data>/claude-statusline.mjs when the owner turns Claude plan usage on, and it sits next to its own data files:
//   claude-statusline.config.json   { "previousCommand": "<the owner's own status line>" | null }
//   claude-capture/state.json      the verified capture phase
//   claude-capture/snapshot.<id>/claude-limits.json   the verified capture's snapshot
//
// What it does, in this order, and never anything else:
//   1. reads stdin and parses it (any failure skips step 2);
//   2. While capture is active, WRITES THE SNAPSHOT FIRST: Claude Code cancels a running script when a new update arrives, so the write must land
//      before anything slow. Only the two plan windows (`used_percentage`, `resets_at`) and Claude's version number are
//      kept. No session id, folder, model, cost, prompt or transcript text is ever read into the file;
//   3. runs the owner's previous status line with the SAME stdin and copies its stdout (and stderr) through byte for byte
//      (4 s limit: a command that is still running then is stopped and prints nothing). Its exit code is NOT copied;
//   4. with NO previous status line, prints the compact line (`5h 23% · 7d 41%`, owner choice P6) from the merged snapshot.
//
// It has no dependencies and makes no network call: Node built-ins only. It never fails Claude Code: the process ALWAYS exits 0,
// whatever the owner's own command exits with (even when that command fails or is killed); only the chained output (or nothing)
// is passed on. No code path carries an exit code out of `runHook`.

import { spawn } from 'node:child_process';
import { readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Taken before anything else: this run's place in time for the "an older run never replaces a newer snapshot" rule.
const STARTED_AT = Math.floor(Date.now() / 1000);

export const SNAPSHOT_FILE = 'claude-limits.json';
export const CONFIG_FILE = 'claude-statusline.config.json';
export const CHAIN_TIMEOUT_MS = 4000;
const STDIN_TIMEOUT_MS = 3000;
/** The latest second a plausible reset can name (the end of year 9999); anything beyond is not an epoch-seconds value. */
const MAX_EPOCH = 253402300799;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,30})?$/;

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A whole number of epoch seconds, or null. */
function epoch(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_EPOCH ? value : null;
}

function versionOf(value) {
  return typeof value === 'string' && VERSION.test(value) ? value : null;
}

/** A window as it is stored (percentage as received, reset time in whole seconds), or null when it is not usable. */
function windowOf(value) {
  if (!isRecord(value)) return null;
  const percent = value.used_percentage;
  const resetsAt = value.resets_at;
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0) return null;
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return null;
  const whole = Math.round(resetsAt);
  return whole >= 0 && whole <= MAX_EPOCH ? { used_percentage: percent, resets_at: whole } : null;
}

/** What the file already holds, cleaned to the schema, or null when there is no usable v1 snapshot (it is then rewritten). */
export function sanitizeSnapshot(value) {
  if (!isRecord(value) || value.v !== 1) return null;
  return {
    v: 1,
    captured_at: epoch(value.captured_at),
    invoked_at: epoch(value.invoked_at),
    claude_version: versionOf(value.claude_version),
    five_hour: windowOf(value.five_hour),
    seven_day: windowOf(value.seven_day),
  };
}

const emptySnapshot = () => ({
  v: 1,
  captured_at: null,
  invoked_at: null,
  claude_version: null,
  five_hour: null,
  seven_day: null,
});

/** A window that is still open at `now`; a reset window is dropped (Claude Code drops it too). */
const stillOpen = (window, now) => (window !== null && window.resets_at > now ? window : null);

/**
 * The snapshot after this update, window by window (data-and-sources › The script, step 2):
 *   - a window this update carries replaces the old one;
 *   - a window it does not carry keeps the old one only while its `resets_at` is still in the future;
 *   - `captured_at` moves only when a window arrived; `invoked_at` moves on every update (even with no `rate_limits`);
 *   - several Claude Code sessions report the same account, so an update that STARTED before the file's `captured_at`
 *     never replaces it.
 * `now` is epoch seconds: the time this run started. `input` is the parsed stdin (an object).
 */
export function mergeSnapshot(existing, input, now) {
  const old = existing ?? emptySnapshot();
  if (old.captured_at !== null && now < old.captured_at) return old;
  const limits = isRecord(input.rate_limits) ? input.rate_limits : {};
  const five = stillOpen(windowOf(limits.five_hour), now);
  const seven = stillOpen(windowOf(limits.seven_day), now);
  return {
    v: 1,
    captured_at: five !== null || seven !== null ? now : old.captured_at,
    invoked_at: Math.max(old.invoked_at ?? 0, now),
    claude_version: versionOf(input.version) ?? old.claude_version,
    five_hour: stillOpen(five ?? old.five_hour, now),
    seven_day: stillOpen(seven ?? old.seven_day, now),
  };
}

/**
 * The compact line (owner choice P6): `5h 23% · 7d 41%`. A window that is reset, unknown or invalid is left out, never
 * shown as 0%; with none left the line is empty.
 */
export function compactLine(snapshot, now) {
  const parts = [];
  for (const [label, window] of [
    ['5h', snapshot.five_hour],
    ['7d', snapshot.seven_day],
  ]) {
    if (window === null || window === undefined) continue;
    if (!Number.isFinite(window.used_percentage) || !(window.resets_at > now)) continue;
    parts.push(`${label} ${Math.min(100, Math.max(0, Math.round(window.used_percentage)))}%`);
  }
  return parts.join(' · ');
}

function readExisting(path) {
  try {
    return sanitizeSnapshot(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null; // missing, unreadable or corrupt: the next write replaces it
  }
}

/** Temp file in the same folder, then rename: a reader never sees half a file. Owner-only. */
function writeSnapshot(path, snapshot) {
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // nothing to remove
    }
    throw error;
  }
}

/**
 * What the config says about the owner's own status line. A missing file means there is none; a file that exists but cannot
 * be read means we cannot tell, so nothing is printed rather than a compact line that might replace the owner's.
 */
function readPrevious(dir) {
  let text;
  try {
    text = readFileSync(join(dir, CONFIG_FILE), 'utf8');
  } catch (error) {
    return error?.code === 'ENOENT' ? { kind: 'none' } : { kind: 'unknown' };
  }
  try {
    const config = JSON.parse(text);
    if (isRecord(config)) {
      const command = config.previousCommand;
      if (typeof command === 'string' && command.trim() !== '') return { kind: 'command', command };
      if (command === null || command === undefined || command === '') return { kind: 'none' };
    }
  } catch {
    // fall through: not valid JSON
  }
  return { kind: 'unknown' };
}

/** A pending, paused or unreadable capture keeps rendering but does not record samples. */
function activeSnapshotPath(dir) {
  try {
    const root = join(dir, 'claude-capture');
    const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
    if (
      state?.v === 2 &&
      state.phase === 'active' &&
      typeof state.snapshotId === 'string' &&
      /^[a-f0-9]{24}$/.test(state.snapshotId)
    ) {
      return join(root, `snapshot.${state.snapshotId}`, SNAPSHOT_FILE);
    }
  } catch {
    // Missing or invalid capture record.
  }
  return null;
}

const NOTHING = { out: Buffer.alloc(0), err: Buffer.alloc(0) };

/**
 * Runs the owner's status line in a shell with the same stdin. Its stdout is returned untouched and its stderr is handed back to
 * be forwarded; its exit code is deliberately not read (the hook exits 0 whatever it was). All three streams are pipes of its
 * own, never this process's: a command that is stopped at the time limit can leave a child behind, and a child holding OUR
 * stderr open would keep Claude Code waiting on it.
 */
function chain(command, stdin, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      resolve(NOTHING);
      return;
    }
    const out = [];
    const err = [];
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
      } catch {
        // already gone
      }
      finish(NOTHING);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.stdin.on('error', () => undefined); // the command may exit without reading
    child.on('error', () => finish(NOTHING));
    child.on('close', () => finish({ out: Buffer.concat(out), err: Buffer.concat(err) }));
    child.stdin.end(stdin);
  });
}

/**
 * One hook run, without touching the real stdin and stdout: `dir` is where the config and snapshot live, `stdin` the bytes
 * Claude Code sent, `now` this run's start in epoch seconds. Returns what to print (`out`) and what the owner's command wrote to
 * stderr (`err`, forwarded as it was). There is no exit code in the result: the script always exits 0 (see `main`).
 */
export async function runHook({
  dir,
  stdin,
  now,
  chainTimeoutMs = CHAIN_TIMEOUT_MS,
  snapshotPath = activeSnapshotPath(dir),
}) {
  let merged = null;
  try {
    const input = snapshotPath === null ? null : JSON.parse(stdin.toString('utf8'));
    if (snapshotPath !== null && isRecord(input)) {
      const existing = readExisting(snapshotPath);
      merged = mergeSnapshot(existing, input, now);
      if (merged !== existing && snapshotPath === activeSnapshotPath(dir)) {
        writeSnapshot(snapshotPath, merged);
      }
    }
  } catch {
    // Malformed input or a write that failed: carry on to the chain. The hook never fails Claude Code.
  }

  let previous;
  try {
    previous = readPrevious(dir);
  } catch {
    previous = { kind: 'unknown' };
  }
  if (previous.kind === 'command') return chain(previous.command, stdin, chainTimeoutMs);
  if (previous.kind === 'none' && merged !== null) {
    const line = compactLine(merged, now);
    if (line !== '') return { out: Buffer.from(`${line}\n`), err: NOTHING.err };
  }
  return NOTHING;
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let stdin;
    try {
      stdin = process.stdin;
    } catch {
      resolve(Buffer.alloc(0));
      return;
    }
    if (stdin.isTTY) {
      resolve(Buffer.alloc(0));
      return;
    }
    const done = () => {
      clearTimeout(timer);
      stdin.destroy();
      resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(done, STDIN_TIMEOUT_MS);
    stdin.on('data', (chunk) => chunks.push(chunk));
    stdin.on('end', done);
    stdin.on('error', done);
  });
}

async function main() {
  const dir = import.meta.dirname;
  // Bind this update before stdin can block. Removal retires its directory before another capture can start.
  const snapshotPath = activeSnapshotPath(dir);
  const stdin = await readStdin();
  const { out, err } = await runHook({ dir, stdin, now: STARTED_AT, snapshotPath });
  process.stdout.on('error', () => undefined); // Claude Code may have stopped listening
  process.stderr.on('error', () => undefined);
  if (out.length > 0) process.stdout.write(out);
  if (err.length > 0) process.stderr.write(err);
  process.exitCode = 0; // always: the owner's own command exiting with an error must never read as the hook failing
}

/** True only when Node was started on this very file (not when a test imports it). The path is resolved: temp folders are often links. */
function isMain() {
  try {
    return (
      process.argv[1] !== undefined &&
      import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch(() => {
    process.exitCode = 0;
  });
}
