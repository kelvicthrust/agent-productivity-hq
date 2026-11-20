import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importsOf, namedImports, stripComments } from '../experiments/static-rules.ts';

// What the capture module and the collector may not do, found by reading their source (TECH › Module boundaries: the capture
// module may import db-free Node fs and shared contracts only; it never reads Claude credentials, never touches project or local
// settings, never makes a network call, and never writes SQL).

const SRC = resolve(import.meta.dirname, '../../src/server');
const CAPTURE = join(SRC, 'integrations/claudeCapture');
const COLLECTOR = join(SRC, 'collectors/claudeAccount');

const sourcesIn = (dir: string): { name: string; code: string; raw: string }[] =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.(ts|mjs)$/.test(name) && !name.endsWith('.d.mts'))
    .map((name) => {
      const raw = readFileSync(join(dir, name), 'utf8');
      return { name, raw, code: stripComments(raw) };
    });

const capture = sourcesIn(CAPTURE);
const collector = sourcesIn(COLLECTOR);

describe('the capture module (src/server/integrations/claudeCapture)', () => {
  it('has the files the design names', () => {
    const names = capture.map((file) => file.name);
    for (const expected of [
      'plan.ts',
      'apply.ts',
      'revert.ts',
      'snapshot.ts',
      'health.ts',
      'assets/claude-statusline.mjs',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('imports no database code, no SQLite, no network module and no UI library', () => {
    for (const file of capture) {
      for (const specifier of importsOf(file.raw)) {
        expect(specifier, `${file.name} imports ${specifier}`).not.toMatch(
          /(^|\/)db(\/|$)|node:sqlite|sqlite|node:https?$|node:http2|node:net$|node:tls|node:dgram|undici|axios|node-fetch|react|astryx|\/client\//,
        );
      }
    }
  });

  it('has no SQL, no fetch and no WebSocket', () => {
    for (const file of capture) {
      expect(file.code, file.name).not.toMatch(
        /\.prepare\(|\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\s+FROM\b|\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/,
      );
    }
  });

  it('never mentions Claude’s credentials, the Keychain or Anthropic’s endpoints in code', () => {
    for (const file of capture) {
      expect(file.code, file.name).not.toMatch(
        /credentials|keychain|keyring|api\.anthropic|oauth|accessToken|security find-/i,
      );
    }
  });

  it('only ever names one Claude file: settings.json (and the project files it checks for a key, read-only)', () => {
    const named = capture.flatMap((file) =>
      [...file.code.matchAll(/['"`]([\w.-]*settings[\w.-]*\.json)['"`]/g)].map((match) => match[1]),
    );
    expect(new Set(named)).toEqual(new Set(['settings.json', 'settings.local.json']));
    // The local file appears only in the read-only project check.
    const usesLocal = capture
      .filter((file) => file.code.includes('settings.local.json'))
      .map((file) => file.name);
    expect(usesLocal).toEqual(['health.ts']);
  });

  it('the hook script imports only Node built-ins and is plain JavaScript with no dependency', () => {
    const script = capture.find((file) => file.name === 'assets/claude-statusline.mjs');
    expect(script).toBeDefined();
    expect(importsOf(script?.raw ?? '').every((specifier) => specifier.startsWith('node:'))).toBe(
      true,
    );
  });
});

describe('the collector (src/server/collectors/claudeAccount)', () => {
  it('writes through replaceRateLimits and imports no other query and no SQL', () => {
    for (const file of collector) {
      expect(file.code, file.name).not.toMatch(
        /\.prepare\(|\.exec\(|\bSELECT\b|\bINSERT\b|\bDELETE\b/,
      );
      expect(file.code, file.name).not.toMatch(/node:sqlite/);
      expect(namedImports(file.raw, '../../db/queries/accounts.ts'), file.name).toEqual([
        'RateLimitInput',
        'replaceRateLimits',
      ]);
    }
  });

  it('reads no file of Claude’s and makes no network call: it only reads the snapshot through the capture module', () => {
    for (const file of collector) {
      expect(file.code, file.name).not.toMatch(
        /node:fs|node:child_process|\bfetch\s*\(|node:https?|credentials|\.claude\b/i,
      );
    }
  });
});
