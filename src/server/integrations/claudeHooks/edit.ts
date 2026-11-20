import { ClaudeHooksError } from './errors.ts';
import { assertReadableByHq, inspect, parseSettings, planEntries } from './settings.ts';
import { layoutOf, spliceSettings } from './splice.ts';

// One settings file, text in and text out: HQ's entries added (`enabled`) or removed, by local edits to the file's own text and
// by nothing else (splice.ts is the only writer; HQ never prints a settings file from a parsed copy).

/**
 * The text of the settings file with HQ's entries for `command` added (or, when `enabled` is false, removed), or null for "nothing to
 * change". `text` is null for a file that does not exist yet, which starts from an empty object and is edited like any other.
 * Throws a `ClaudeHooksError`: a code of the contract for a file HQ cannot use, and `unsupported_layout` when the file is valid but its
 * text cannot be edited so that every other byte stays and the result reads back (last key wins) as exactly the intended settings, or
 * when the result would be more than HQ itself reads (over 4 MiB in bytes, or deeper than it reads).
 * Turning off recognises HQ's entries by their shape alone, whatever paths they name; `command` only decides what counts as exact.
 */
export function editSettingsText(
  text: string | null,
  command: string,
  enabled: boolean,
): string | null {
  if (text === null && !enabled) return null;
  const base = text ?? '{}\n';
  const value = parseSettings(base);
  const state = inspect(value, command);
  if (enabled ? state === 'present' : state === 'absent') return null;
  const plan = planEntries(value, command, enabled, layoutOf(base));
  if (plan.events.length === 0) return null;
  const result = spliceSettings(base, value, plan);
  if (result === null) throw new ClaudeHooksError('unsupported_layout');
  // The output must be readable by HQ's own reader, on every limit it reads by (size in bytes, text, JSON, depth), and read back as the
  // state asked for: a file HQ could not read again (it would then show no way to remove its entries) is never written.
  assertReadableByHq(result);
  if (inspect(parseSettings(result), command) !== (enabled ? 'present' : 'absent'))
    throw new ClaudeHooksError('unsupported_layout');
  return result;
}
