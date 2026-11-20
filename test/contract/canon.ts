import { z } from 'zod';

// Reduces a JSON Schema (from the OpenAPI copy, or from zod) to the parts the contract cares about, so the two can be
// compared even though they spell things differently (`type: [integer, "null"]` vs `anyOf`, `const` vs `enum`, closed
// objects, zod's safe-integer bounds). It resolves $ref against the document's components.

type Json = Record<string, unknown>;

export interface Canon {
  types: string[];
  enum?: unknown[];
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  maxLength?: number;
  /** Object with named properties. */
  props?: Record<string, Canon>;
  required: string[];
  /** Array element. */
  items?: Canon;
  /** Object used as a map: the value schema. */
  additional?: Canon;
  /** Object or value with no stated shape. */
  free?: true;
}

const SAFE = Number.MAX_SAFE_INTEGER;
const sorted = (xs: string[]) => [...new Set(xs)].sort();

export function resolveRef(ref: string, doc: Json): Json {
  const parts = ref.replace(/^#\//, '').split('/');
  let node: unknown = doc;
  for (const part of parts) node = (node as Json)[part];
  if (!node || typeof node !== 'object') throw new Error(`Unresolved $ref ${ref}`);
  return node as Json;
}

const typeOf = (value: unknown): string =>
  value === null
    ? 'null'
    : Number.isInteger(value)
      ? 'integer'
      : Array.isArray(value)
        ? 'array'
        : typeof value;

export function canon(schema: Json, doc: Json): Canon {
  if (typeof schema['$ref'] === 'string') return canon(resolveRef(schema['$ref'], doc), doc);

  if (Array.isArray(schema['allOf'])) {
    const parts = (schema['allOf'] as Json[]).map((part) => canon(part, doc));
    const merged: Canon = {
      types: sorted(parts.flatMap((p) => p.types)),
      required: sorted(parts.flatMap((p) => p.required)),
    };
    merged.props = Object.assign({}, ...parts.map((p) => p.props ?? {}));
    return merged;
  }

  if (Array.isArray(schema['anyOf'])) {
    const parts = (schema['anyOf'] as Json[]).map((part) => canon(part, doc));
    const nulls = parts.filter((p) => p.types.length === 1 && p.types[0] === 'null' && !p.enum);
    const rest = parts.filter((p) => !nulls.includes(p));
    if (rest.length !== 1)
      throw new Error(`Unsupported anyOf: ${JSON.stringify(schema).slice(0, 120)}`);
    const only = rest[0]!;
    return { ...only, types: sorted([...only.types, ...(nulls.length ? ['null'] : [])]) };
  }

  const out: Canon = { types: [], required: [] };
  const rawType = schema['type'];
  let types =
    rawType === undefined
      ? []
      : Array.isArray(rawType)
        ? (rawType as string[])
        : [rawType as string];

  let values = Array.isArray(schema['enum']) ? [...(schema['enum'] as unknown[])] : undefined;
  if ('const' in schema) values = [schema['const']];
  if (values) {
    if (types.length === 0) types = [...new Set(values.map(typeOf))];
    if (types.includes('null')) values = values.filter((v) => v !== null);
    out.enum = [...values].sort((a, b) => String(a).localeCompare(String(b)));
  }
  out.types = sorted(types);

  if (typeof schema['format'] === 'string') out.format = schema['format'];
  else if (typeof schema['pattern'] === 'string') out.pattern = schema['pattern'];
  if (typeof schema['minimum'] === 'number' && schema['minimum'] !== -SAFE)
    out.minimum = schema['minimum'];
  if (typeof schema['maximum'] === 'number' && schema['maximum'] !== SAFE)
    out.maximum = schema['maximum'];
  if (typeof schema['maxItems'] === 'number') out.maxItems = schema['maxItems'];
  if (typeof schema['maxLength'] === 'number') out.maxLength = schema['maxLength'];

  const props = schema['properties'] as Record<string, Json> | undefined;
  if (props) {
    out.props = Object.fromEntries(
      Object.entries(props).map(([name, value]) => [name, canon(value, doc)]),
    );
    out.required = sorted((schema['required'] as string[] | undefined) ?? []);
  }
  const extra = schema['additionalProperties'];
  if (!props && out.types.includes('object')) {
    if (extra && typeof extra === 'object' && Object.keys(extra).length > 0)
      out.additional = canon(extra as Json, doc);
    else out.free = true;
  }
  if (schema['items'] && typeof schema['items'] === 'object')
    out.items = canon(schema['items'] as Json, doc);
  return out;
}

/** The JSON Schema zod produces for `schema`, without the $schema marker. */
export function zodJson(schema: z.ZodType, io: 'input' | 'output' = 'output'): Json {
  const json = z.toJSONSchema(schema, { io, unrepresentable: 'any', reused: 'inline' }) as Json;
  delete json['$schema'];
  return json;
}

/**
 * Compares what the code says (`code`) with what the document says (`doc`). Both are canonical forms. Properties, types,
 * enums, formats and the listed limits must agree. `required` may be stricter in code than in the document, never looser.
 * Returns the differences as readable lines (empty when they agree).
 */
export function differences(code: Canon, doc: Canon, path = '$'): string[] {
  const out: string[] = [];
  const same = (name: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      out.push(`${path}.${name}: code ${JSON.stringify(a)} but document ${JSON.stringify(b)}`);
  };
  same('types', code.types, doc.types);
  same('enum', code.enum, doc.enum);
  same('format', code.format, doc.format);
  same('pattern', code.pattern, doc.pattern);
  same('minimum', code.minimum, doc.minimum);
  same('maximum', code.maximum, doc.maximum);
  same('maxItems', code.maxItems, doc.maxItems);
  same('maxLength', code.maxLength, doc.maxLength);
  same('free', code.free, doc.free);

  const missingRequired = doc.required.filter((name) => !code.required.includes(name));
  if (missingRequired.length)
    out.push(`${path}: the document requires ${missingRequired.join(', ')} but code does not`);

  if (code.props || doc.props) {
    const a = Object.keys(code.props ?? {}).sort();
    const b = Object.keys(doc.props ?? {}).sort();
    if (JSON.stringify(a) !== JSON.stringify(b))
      out.push(`${path}: properties differ. code [${a}] document [${b}]`);
    for (const name of a.filter((n) => b.includes(n)))
      out.push(...differences(code.props![name]!, doc.props![name]!, `${path}.${name}`));
    const unknownRequired = code.required.filter((name) => !a.includes(name));
    if (unknownRequired.length)
      out.push(
        `${path}: code requires properties it does not define: ${unknownRequired.join(', ')}`,
      );
  }
  if (code.items || doc.items) {
    if (!code.items || !doc.items)
      out.push(`${path}: array items differ (code ${!!code.items}, document ${!!doc.items})`);
    else out.push(...differences(code.items, doc.items, `${path}[]`));
  }
  if (code.additional || doc.additional) {
    if (!code.additional || !doc.additional)
      out.push(
        `${path}: map values differ (code ${!!code.additional}, document ${!!doc.additional})`,
      );
    else out.push(...differences(code.additional, doc.additional, `${path}{}`));
  }
  return out;
}
