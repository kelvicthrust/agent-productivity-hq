import { findSecrets } from './secrets.ts';

// Metadata only. A string may appear in a result only if it looks like an identifier (a version, a model name, an enum
// value, a short id): letters, digits and . _ : @ + - / with no spaces, at most 80 characters. Anything else, such as a
// sentence, a path with spaces, a title or a message, is replaced by a marker that says only how long it was.

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+\-/]{0,79}$/;

export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value) && findSecrets(value).length === 0;
}

/** `[string:12]`: the value is withheld, its length is not secret. */
export const marker = (value: string): string => `[string:${value.length}]`;

/** An identifier-shaped string as it is, anything else as a marker. */
export function identifierOrMarker(value: string): string {
  return isIdentifier(value) ? value : marker(value);
}

/**
 * Builds text for a finding. Interpolated values must be numbers, booleans or identifiers; any other string becomes a
 * marker. The fixed text between the values is the script author's and is checked for secrets when the file is written.
 */
export function safeText(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = strings[0] ?? '';
  values.forEach((value, i) => {
    let piece: string;
    if (typeof value === 'number') piece = Number.isFinite(value) ? String(value) : 'n/a';
    else if (typeof value === 'boolean') piece = String(value);
    else if (typeof value === 'string') piece = identifierOrMarker(value);
    else if (Array.isArray(value))
      piece = value
        .map((v) => (typeof v === 'string' ? identifierOrMarker(v) : String(v)))
        .join(', ');
    else piece = '[value]';
    out += piece + (strings[i + 1] ?? '');
  });
  return out;
}

/** Keys whose string values are identifiers by nature. Everything else is withheld by redactValue. */
export const PASS_KEYS: ReadonlySet<string> = new Set([
  'type',
  'kind',
  'role',
  'status',
  'state',
  'provider',
  'version',
  'cli_version',
  'model',
  'source',
  'originator',
  'decoder',
  'platform',
  'arch',
  'event',
  'subtype',
  'stop_reason',
  'service_tier',
  'reasoning_effort',
  'effort',
]);

/**
 * A deep copy of `value` with every string replaced by a marker unless its key is in `passKeys` and the value is an
 * identifier. Numbers, booleans and null stay. Depth and array length are bounded.
 */
export function redactValue(
  value: unknown,
  passKeys: ReadonlySet<string> = PASS_KEYS,
  key = '',
  depth = 0,
): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string')
    return passKeys.has(key) && isIdentifier(value) ? value : marker(value);
  if (depth >= 6) return '[truncated]';
  if (Array.isArray(value))
    return value.slice(0, 50).map((item) => redactValue(item, passKeys, key, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      out[isFieldName(k) ? k : '*'] = redactValue(v, passKeys, k, depth + 1);
    }
    return out;
  }
  return '[value]';
}

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_$.-]{0,63}$/;
const LOOKS_LIKE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9a-f]{24,}$|^\d{6,}$/i;

/** A key that is a field name and not data: not a uuid, a long hex or number, a path or a token. */
export function isFieldName(key: string): boolean {
  return FIELD_NAME.test(key) && !LOOKS_LIKE_ID.test(key) && findSecrets(key).length === 0;
}
