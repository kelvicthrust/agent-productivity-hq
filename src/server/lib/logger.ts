import { appendFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FILE_MODE, ensureDir, ensureFile } from './fsModes.ts';

// Structured JSON logs, one object per line, written to <data>/logs/agent-productivity.log and rotated at 5 files of 5 MB.
// Redaction is applied to every entry before it is written: field names that can carry secrets or source text are
// replaced, and values that look like tokens are masked, so a log never holds line text, prompts or tokens (P-31).

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const LOG_FILE = 'agent-productivity.log';
export const MAX_LOG_BYTES = 5 * 1024 * 1024;
export const MAX_LOG_FILES = 5;

export const REDACTED = '[redacted]';
const SECRET_KEY =
  /token|secret|password|passwd|authorization|cookie|credential|api[-_]?key|private[-_]?key|prompt|transcript|content|body|text|line|message_text|snippet/i;
// Keys that look secret-like but are plain metadata the log schema defines.
const SAFE_KEYS = new Set([
  'unreadable_lines',
  'unreadableLines',
  'lineCount',
  'lines',
  'tokens_total',
  'tokenCount',
]);
const SECRET_VALUE = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];
const MAX_STRING = 300;
const MAX_DEPTH = 5;

export function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE) out = out.replace(pattern, REDACTED);
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…` : out;
}

/** Returns a copy of `value` that is safe to write: secret-named fields replaced, token-like strings masked, depth and size bounded. */
export function redact(value: unknown, depth = 0, key = ''): unknown {
  if (key && SECRET_KEY.test(key) && !SAFE_KEYS.has(key)) return REDACTED;
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object')
    return typeof value === 'function' ? undefined : value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    return {
      name: value.name,
      message: redactString(value.message),
      ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
    };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = redact(v, depth + 1, k);
  return out;
}

export interface LogFields {
  source?: string;
  runId?: number;
  correlationId?: string;
  code?: string;
  [field: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export type LogSink = (line: string, entry: Record<string, unknown>) => void;

/** A logger over any sink; tests pass an array-backed sink. Entries are redacted before the sink sees them. */
export function createLogger(options: {
  sink: LogSink;
  level?: LogLevel;
  now?: () => number;
}): Logger {
  const min = ORDER[options.level ?? 'info'];
  const now = options.now ?? Date.now;
  const write = (level: LogLevel, msg: string, fields?: LogFields) => {
    if (ORDER[level] < min) return;
    const safe = redact(fields ?? {}) as Record<string, unknown>;
    const entry = { ts: new Date(now()).toISOString(), level, msg: redactString(msg), ...safe };
    options.sink(JSON.stringify(entry), entry);
  };
  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}

/** Appends to `<dir>/agent-productivity.log` (mode 0600) and rotates by size, dropping the oldest file. */
export function fileSink(
  dir: string,
  options: { maxBytes?: number; maxFiles?: number } = {},
): LogSink & { path: string } {
  const maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
  const maxFiles = options.maxFiles ?? MAX_LOG_FILES;
  const path = join(dir, LOG_FILE);
  ensureDir(dir);
  ensureFile(path);

  const rotate = () => {
    rmSync(`${path}.${maxFiles - 1}`, { force: true });
    for (let i = maxFiles - 2; i >= 1; i--) {
      if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
    }
    if (maxFiles > 1) renameSync(path, `${path}.1`);
    else rmSync(path, { force: true });
    ensureFile(path);
  };

  const sink: LogSink = (line) => {
    const bytes = Buffer.byteLength(line) + 1;
    if (statSync(path).size > 0 && statSync(path).size + bytes > maxBytes) rotate();
    appendFileSync(path, `${line}\n`, { mode: FILE_MODE });
  };
  return Object.assign(sink, { path });
}
