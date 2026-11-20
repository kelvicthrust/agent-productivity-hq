import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { ROUTES, routeKey } from '../../src/shared/contracts/routes.ts';
import { RefreshRun, SetupDiscoverResponse } from '../../src/shared/contracts/sources.ts';

// What first-launch Setup promises at the contract (G10_1, G10_2; P-39, P-40, P-41, P-43; TECH J1), pinned in BOTH copies: the two
// setup routes take nothing from the client (no body, no query, no path parameter), so no folder, path, key, password or cookie can
// be sent to them or asked for by them; discovery answers sources and accounts, finishing answers the run it started with 202; and
// the document says so in its M10 delta. A later change that lets a route take a body must change this file on purpose.

const text = readFileSync(join(import.meta.dirname, '../../docs/tech/local-api.md'), 'utf8');
const block = text.match(/```yaml\n([\s\S]*?)```/)![1]!;
type Json = Record<string, unknown>;
const doc = parse(block) as { paths: Record<string, Record<string, Json>> };

const route = (key: string) => {
  const found = ROUTES.find((r) => routeKey(r) === key);
  expect(found, key).toBeDefined();
  return found!;
};

describe('the setup routes in the code', () => {
  it('are two POSTs behind the app header that take no body, no query and no path parameter', () => {
    for (const key of ['POST /api/setup/discover', 'POST /api/setup/complete']) {
      const r = route(key);
      expect(r.csrf, key).toBe(true);
      expect(r.body, key).toBeUndefined();
      expect(r.query, key).toBeUndefined();
      expect(r.params, key).toBeUndefined();
    }
  });

  it('answer sources and accounts for discovery, and 202 with the run that was started for finishing', () => {
    const discover = route('POST /api/setup/discover');
    expect(Object.keys(discover.responses)).toEqual(['200']);
    expect(discover.responses['200']).toBe(SetupDiscoverResponse);
    const complete = route('POST /api/setup/complete');
    expect(Object.keys(complete.responses)).toEqual(['202']);
    expect(complete.responses['202']).toBe(RefreshRun);
  });

  it('give discovery a response that holds exactly sources and accounts (where a source was found is shown, never asked)', () => {
    const shape = Object.keys(SetupDiscoverResponse.shape).sort();
    expect(shape).toEqual(['accounts', 'sources']);
  });
});

describe('the setup routes in the document', () => {
  const operation = (path: string) => doc.paths[path]!['post']!;

  it('take only the app header: no request body and no parameter but X-Agent-Productivity-Request', () => {
    for (const path of ['/api/setup/discover', '/api/setup/complete']) {
      const op = operation(path);
      expect(op['requestBody'], path).toBeUndefined();
      const params = (op['parameters'] as Json[]).map(
        (p) => `${String(p['in'])}:${String(p['name'])}`,
      );
      expect(params, path).toEqual(['header:X-Agent-Productivity-Request']);
    }
  });

  it('says in the M10 delta that discovery only looks, takes nothing from the client and that finishing allows an empty setup', () => {
    const delta = text.match(/\*\*M10 delta \(Implementation\):\*\*[^\n]*/)?.[0] ?? '';
    expect(delta).toContain('Discover only looks');
    expect(delta).toContain('takes nothing from the client');
    expect(delta).toContain('no path, folder, key or token');
    expect(delta).toContain('zero sources and zero repos');
    expect(delta).toContain('starts no second run');
  });
});
