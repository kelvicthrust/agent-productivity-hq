import type { ParsedArgs } from './types.ts';

/**
 * Flags only: `--name value`, `--name=value` or `--name` on its own (a switch). A flag repeated keeps every value. There
 * are no positional arguments, so a switch followed by a flag is unambiguous.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const values = new Map<string, string[]>();
  const push = (name: string, value: string) =>
    values.set(name, [...(values.get(name) ?? []), value]);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--') || token === '--')
      throw new UsageError(
        `Unexpected argument "${token.slice(0, 40)}". Use flags only, like --out file.`,
      );
    const eq = token.indexOf('=');
    if (eq > 2) {
      push(token.slice(2, eq), token.slice(eq + 1));
      continue;
    }
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      push(name, next);
      i++;
    } else {
      push(name, 'true');
    }
  }
  return {
    get: (name) => values.get(name)?.at(-1),
    all: (name) => [...(values.get(name) ?? [])],
    has: (name) => values.has(name),
    names: () => [...values.keys()].sort(),
  };
}

/** A mistake in how the script was started. Exit code 2, with the message. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}
