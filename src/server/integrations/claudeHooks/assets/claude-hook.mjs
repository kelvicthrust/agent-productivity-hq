// Agent Productivity: the Claude Code hook that tells HQ when an agent needs you (data-and-sources › Claude Code hooks).
//
// Claude Code runs this for the five events the owner's switch installed (PermissionRequest, Notification, Stop, SessionStart,
// SessionEnd) and writes the event's JSON to stdin. It is copied to <data>/claude-hooks/agent-productivity-hook.mjs when the switch
// is turned on, and it finds the running app through the registry file beside itself:
//   registry.json   { "v": 1, "pid": <number>, "port": <number>, "token": "<random>" }   (owner-only; written while the app runs)
//
// What it does, in this order, and never anything else:
//   1. reads stdin, at most 16 MiB (anything larger is not sent), decodes it as strict UTF-8 (a byte that is not valid UTF-8 means
//      nothing is sent: it is never turned into a replacement character) and parses it;
//   2. builds the message FIELD BY FIELD from hook_event_name, session_id, notification_type, reason, cwd, each held
//      to the very shape the server accepts (a field that is not that shape is left out; the server refuses any other). The
//      rest of the event (`message`, `tool_name`, `tool_input`, `tool_response`, `prompt`, `transcript_path`, the assistant's text,
//      permission suggestions, ...) is never copied, held or sent;
//   3. checks the local registry and its process. With background reporting enabled, a Stop adds a bounded task snapshot.
//      It sends only IDs, known categories and states, and a timestamp. POSTs to http://127.0.0.1:<port> with the registry token.
//
// It has no dependencies, prints nothing (a hook's stdout can steer Claude Code; this one must not), and ALWAYS exits 0, quickly:
// the whole run is cut off after about 1.5 s, and a missing registry, a stale pid, a refused connection or a malformed event simply
// end it. Nothing is written to disk.
//
// It never blocks. The deadline is a timer, armed before anything else is done, that exits the process whatever is outstanding; so
// nothing after it is armed may keep the main thread from running it. Every file access is asynchronous (it runs on libuv's thread
// pool, and a call that hangs there cannot hold the timer), and stdin and the HTTP request are event-driven. The only synchronous calls
// after the timer is armed are `process.kill(pid, 0)` (a signal-0 probe, which never waits), and string and JSON work on bounded data.
// The registry is read like this: `lstat` it first and accept only a regular file of at most 4 KiB that belongs to the current user
// and has no group or other permission (a pipe, a folder, a link, a file somebody else owns or can write is not HQ's registry),
// then open it `O_NOFOLLOW | O_NONBLOCK`, check the opened file again, and read it with a size cap.

import { constants, promises as fsp } from 'node:fs';
import { request } from 'node:http';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEADLINE_MS = 1500;
export const MAX_STDIN_BYTES = 16 * 1024 * 1024;

/** Strict UTF-8: invalid bytes throw instead of becoming U+FFFD, and a byte-order mark is kept (so the JSON that follows it is refused). */
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const WORD = /^[A-Za-z0-9._:-]{1,64}$/;
const TOKEN = /^[A-Za-z0-9_-]{20,200}$/;
const EVENT_NAME = /^[A-Za-z]{1,40}$/;
const TASK_TYPES = new Set(['subagent', 'shell', 'monitor']);
const ACTIVE_TASK_STATES = new Set(['running', 'pending']);
const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'killed', 'stopped']);
// Keeps the largest message, including a multibyte working directory, under the 8 KiB ingest limit.
const MAX_TASKS = 24;
// The working directory's rule, the same as `isHookCwd` in src/shared/contracts/hq.ts (a test holds the two together): absolute (POSIX,
// or a Windows drive letter), 1 to 1024 long, and no control character, line or paragraph separator, or lone surrogate.
const CWD_MAX = 1024;
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/])/;
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ud800-\udfff]/u;

/** `value` when it is a string of the shape `pattern` allows, else undefined. */
const shaped = (value, pattern) =>
  typeof value === 'string' && pattern.test(value) ? value : undefined;

/** True when `value` is a working directory the server accepts. */
const isCwd = (value) =>
  typeof value === 'string' &&
  value.length >= 1 &&
  value.length <= CWD_MAX &&
  ABSOLUTE_PATH.test(value) &&
  !FORBIDDEN.test(value);

/**
 * The message for one hook event, or null when it is not one. Only allowlisted fields are read, each checked and bounded;
 * a field that is missing or not the right shape is left out. `hook_event_name` and `session_id` are required.
 */
export function messageFor(input, backgroundWork = false, observedAt = Date.now()) {
  if (!isRecord(input)) return null;
  const hook_event_name = shaped(input.hook_event_name, EVENT_NAME);
  const session_id = shaped(input.session_id, ID);
  if (hook_event_name === undefined || session_id === undefined) return null;
  const message = { hook_event_name, session_id };
  const notification_type = shaped(input.notification_type, WORD);
  if (notification_type !== undefined) message.notification_type = notification_type;
  const reason = shaped(input.reason, WORD);
  if (reason !== undefined) message.reason = reason;
  if (isCwd(input.cwd)) message.cwd = input.cwd;
  if (backgroundWork && hook_event_name === 'Stop') {
    message.background_work = {
      observed_at: observedAt,
      tasks: activeTasks(input.background_tasks),
    };
  }
  return message;
}

/** A missing or unreadable snapshot means unknown. An empty one confirms no supported jobs. */
function activeTasks(snapshot) {
  if (!Array.isArray(snapshot)) return null;
  const tasks = [];
  for (const task of snapshot) {
    if (!isRecord(task) || typeof task.type !== 'string') return null;
    if (!TASK_TYPES.has(task.type) || TERMINAL_TASK_STATES.has(task.status)) continue;
    const id = shaped(task.id, ID);
    if (id === undefined || !ACTIVE_TASK_STATES.has(task.status) || tasks.length >= MAX_TASKS) {
      return null;
    }
    tasks.push({ id, type: task.type, status: task.status });
  }
  return tasks;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

/** The most a registry file holds (it is a few hundred bytes); anything larger is not HQ's. */
export const MAX_REGISTRY_BYTES = 4096;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;

/**
 * True for a file the registry rule accepts: regular, small, the current user's, and closed to group and others. Exported because the
 * app asks the very same question (on the same kind of stat) when it decides whether the switch is "on": one rule, not two copies.
 */
export function isTrustedRegistry(stat) {
  if (!stat.isFile() || stat.size > MAX_REGISTRY_BYTES) return false;
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) return false;
  // Windows has no such mode bits; everywhere else a registry that others can read or write is not trusted.
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) return false;
  return true;
}

/** The registry's bytes, or null (missing, not a trusted file, too large, or anything going wrong). Never blocks the main thread. */
async function readRegistry(path) {
  let handle;
  try {
    if (!isTrustedRegistry(await fsp.lstat(path))) return null;
    // Opened without waiting (a pipe swapped in after the check does not block the open) and without following a link.
    handle = await fsp.open(path, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    if (!isTrustedRegistry(await handle.stat())) return null;
    const buffer = Buffer.alloc(MAX_REGISTRY_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    return size > MAX_REGISTRY_BYTES ? null : buffer.subarray(0, size);
  } catch {
    return null;
  } finally {
    try {
      await handle?.close();
    } catch {
      // nothing to do
    }
  }
}

/**
 * What a registry's bytes say, or null: strict UTF-8, JSON, version 1, a live process (`pid`), a port and a token of the shape the app
 * makes. Exported with `isTrustedRegistry` for the app's own "is it deliverable" question, so that the two cannot disagree.
 */
export function parseRegistryBytes(bytes) {
  try {
    const registry = JSON.parse(strictUtf8.decode(bytes));
    if (!isRecord(registry) || registry.v !== 1) return null;
    const { pid, port, token } = registry;
    if (!Number.isSafeInteger(pid) || pid <= 0 || !alive(pid)) return null;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null;
    if (typeof token !== 'string' || !TOKEN.test(token)) return null;
    return { pid, port, token, ...(registry.backgroundWork === true && { backgroundWork: true }) };
  } catch {
    return null;
  }
}

/** Where the running app is, from the registry in `dir`: `{ port, token }`, or null (no file, not ours, stale pid, bad values). */
export async function findApp(dir) {
  try {
    const bytes = await readRegistry(join(dir, 'registry.json'));
    if (bytes === null) return null;
    const registry = parseRegistryBytes(bytes);
    if (registry === null) return null;
    const { port, token, backgroundWork } = registry;
    return { port, token, ...(backgroundWork === true && { backgroundWork: true }) };
  } catch {
    return null;
  }
}

/** One POST to the loopback app. Resolves when the response ends, or at `timeoutMs` whatever it is waiting for; never rejects. */
export function post({ port, token }, message, timeoutMs = DEADLINE_MS) {
  return new Promise((resolve) => {
    let req;
    // The whole request ends at the deadline, not only an idle socket: this timer destroys the request whatever stage it is in.
    const timer = setTimeout(() => finish(), timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      try {
        req?.destroy();
      } catch {
        // nothing to do
      }
      resolve();
    };
    try {
      const body = JSON.stringify(message);
      req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/hq/hooks/claude',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'X-Agent-Productivity-Request': '1',
            Authorization: `Bearer ${token}`,
          },
          timeout: timeoutMs,
        },
        (res) => {
          res.on('error', finish);
          res.on('end', finish);
          res.resume();
        },
      );
      req.on('timeout', finish);
      req.on('error', finish);
      req.end(body);
    } catch {
      finish();
    }
  });
}

function readStdin(limit = MAX_STDIN_BYTES) {
  return new Promise((resolve) => {
    let stdin;
    try {
      stdin = process.stdin;
    } catch {
      resolve(null);
      return;
    }
    if (stdin.isTTY) {
      resolve(null);
      return;
    }
    const chunks = [];
    let size = 0;
    let over = false;
    const done = () => resolve(over ? null : Buffer.concat(chunks));
    stdin.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) over = true;
      else chunks.push(chunk);
    });
    stdin.on('end', done);
    stdin.on('close', done);
    stdin.on('error', () => resolve(null));
  });
}

/** One run, without the real stdin and process: `dir` holds the registry, `stdin` is the event's bytes. */
export async function runHook({ dir, stdin, timeoutMs = DEADLINE_MS }) {
  const observedAt = Date.now();
  try {
    if (stdin === null) return;
    const input = JSON.parse(strictUtf8.decode(stdin));
    const app = await findApp(dir);
    if (app === null) return;
    const message = messageFor(input, app.backgroundWork === true, observedAt);
    if (message === null) return;
    await post(app, message, timeoutMs);
  } catch {
    // Anything at all: the hook never affects Claude Code.
  }
}

async function main(cut) {
  try {
    await runHook({ dir: import.meta.dirname, stdin: await readStdin() });
  } catch {
    // never fail
  }
  clearTimeout(cut);
  process.exit(0);
}

/**
 * True only when Node was started on this very file (not when a test imports it). The path is resolved (temp folders are often
 * links), asynchronously: the deadline timer is already armed when this runs.
 */
async function isMain() {
  try {
    return (
      process.argv[1] !== undefined &&
      import.meta.url === pathToFileURL(await fsp.realpath(process.argv[1])).href
    );
  } catch {
    return false;
  }
}

// When Node was started on a file with this one's name, the deadline is armed FIRST, before anything else is done: it exits the process
// (code 0, no output) whatever is outstanding, a file call that hangs or a stdin that never ends included. An import (a test) is not
// this file's own name on the command line, so it arms nothing; the check that it is this very file follows, asynchronously.
if (process.argv[1] !== undefined && basename(process.argv[1]) === basename(import.meta.filename)) {
  const cut = setTimeout(() => process.exit(0), DEADLINE_MS);
  // Nothing that goes wrong anywhere, even outside a promise, may print or change the exit code.
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
  isMain().then(
    (own) => {
      if (own) return main(cut);
      clearTimeout(cut);
      return undefined;
    },
    () => process.exit(0),
  );
}
