// What a token or credential looks like. Used three ways: the output layer refuses to print a matching line, the findings
// writer refuses to write one, and the fixture test refuses to commit one. Matches are never echoed back in a message.

export interface SecretPattern {
  name: string;
  pattern: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'github-fine-grained-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'api-key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { name: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { name: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'authorization-header', pattern: /\bauthorization\s*[:=]\s*\S+/i },
  {
    name: 'oauth-token-value',
    pattern: /\b(?:access|refresh|id)_token["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/i,
  },
];

export interface SecretMatch {
  name: string;
  index: number;
}

export function findSecrets(text: string): SecretMatch[] {
  const found: SecretMatch[] = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    const match = pattern.exec(text);
    if (match) found.push({ name, index: match.index });
  }
  return found;
}

/** Thrown when something that looks like a token or credential was about to be printed or written. */
export class LeakError extends Error {
  readonly kinds: string[];
  constructor(where: string, kinds: string[]) {
    super(
      `Refused to ${where}: it looks like a token or credential (${kinds.join(', ')}). Nothing was printed or written.`,
    );
    this.name = 'LeakError';
    this.kinds = kinds;
  }
}

export function assertNoSecrets(text: string, where: string): void {
  const matches = findSecrets(text);
  if (matches.length > 0)
    throw new LeakError(
      where,
      matches.map((m) => m.name),
    );
}

/** Replaces anything that looks like a token with a marker. Used only for error messages, never for results. */
export function withholdSecrets(text: string): string {
  let out = text;
  for (const { pattern } of SECRET_PATTERNS) {
    out = out.replace(
      new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`),
      '[withheld]',
    );
  }
  return out;
}
