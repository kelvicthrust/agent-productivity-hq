import { isFieldName } from './redact.ts';

// The field list of a pile of records, without any value. Experiments use it to report "which fields exist, how often,
// of which type". Keys that are data (ids, paths, tokens) or that appear in large numbers under one parent are folded
// into `*`, so a map keyed by session id cannot leak the ids through the field list.

export interface FieldEntry {
  path: string;
  types: string[];
  /** How many times the path was seen. */
  count: number;
  /** In how many records it was seen at least once. */
  records: number;
}

type Slot = { types: Set<string>; count: number; records: number };

export class FieldInventory {
  readonly #slots = new Map<string, Slot>();
  readonly #children = new Map<string, Set<string>>();
  readonly #maxChildren: number;
  readonly #maxDepth: number;
  #records = 0;

  constructor(options: { maxChildren?: number; maxDepth?: number } = {}) {
    this.#maxChildren = options.maxChildren ?? 60;
    this.#maxDepth = options.maxDepth ?? 8;
  }

  get recordCount(): number {
    return this.#records;
  }

  add(record: unknown): void {
    this.#records++;
    const seen = new Set<string>();
    this.#walk(record, '', 0, seen);
    for (const path of seen) this.#slot(path).records++;
  }

  #slot(path: string): Slot {
    let slot = this.#slots.get(path);
    if (!slot) {
      slot = { types: new Set(), count: 0, records: 0 };
      this.#slots.set(path, slot);
    }
    return slot;
  }

  #segment(parent: string, key: string): string {
    if (!isFieldName(key)) return '*';
    let known = this.#children.get(parent);
    if (!known) {
      known = new Set();
      this.#children.set(parent, known);
    }
    if (known.has(key)) return key;
    if (known.size >= this.#maxChildren) return '*';
    known.add(key);
    return key;
  }

  #walk(value: unknown, path: string, depth: number, seen: Set<string>): void {
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (path !== '') {
      const slot = this.#slot(path);
      slot.types.add(type);
      slot.count++;
      seen.add(path);
    }
    if (depth >= this.#maxDepth) return;
    if (Array.isArray(value)) {
      for (const item of value) this.#walk(item, `${path}[]`, depth + 1, seen);
    } else if (type === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const segment = this.#segment(path, key);
        this.#walk(child, path === '' ? segment : `${path}.${segment}`, depth + 1, seen);
      }
    }
  }

  entries(): FieldEntry[] {
    return [...this.#slots.entries()]
      .map(([path, slot]) => ({
        path,
        types: [...slot.types].sort(),
        count: slot.count,
        records: slot.records,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  has(path: string): boolean {
    return this.#slots.has(path);
  }

  /** In how many records `path` was present. */
  presence(path: string): number {
    return this.#slots.get(path)?.records ?? 0;
  }

  paths(): string[] {
    return this.entries().map((e) => e.path);
  }
}
