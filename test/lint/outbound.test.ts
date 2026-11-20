import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// All outbound HTTP passes src/server/lib/net.ts and its provider scopes.
// Two guards ensure no other module under src/ sends a request:
//   1. the ESLint rules in eslint.config.js fire on a sample (and the one allowed file stays allowed), and
//   2. a text scan of every source file, so a request made some way the lint rule does not know still fails a test.
// net.ts itself is tested by the allowlist test in test/collectors/github/auth (a request to any other host, path, method
// or scheme is refused).

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const eslint = new ESLint({ cwd: ROOT });

async function messages(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: resolve(ROOT, filePath) });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === 'no-restricted-imports' || m.ruleId === 'no-restricted-globals')
    .map((m) => m.message);
}

describe('the ESLint rules for outbound HTTP', () => {
  const forbidden: [name: string, file: string, code: string][] = [
    [
      'fetch in a collector',
      'src/server/collectors/github/zz.ts',
      "export const x = fetch('https://example.com');\n",
    ],
    [
      'fetch in a service',
      'src/server/services/zz.ts',
      "export const x = () => fetch('https://example.com');\n",
    ],
    [
      'node:https',
      'src/server/collectors/zz.ts',
      "import https from 'node:https';\nexport { https };\n",
    ],
    [
      'node:http request',
      'src/server/collectors/zz.ts',
      "import { request } from 'node:http';\nexport { request };\n",
    ],
    [
      'node:net connect',
      'src/server/collectors/zz.ts',
      "import { connect } from 'node:net';\nexport { connect };\n",
    ],
    [
      'undici',
      'src/server/collectors/zz.ts',
      "import { fetch as f } from 'undici';\nexport { f };\n",
    ],
    [
      'Octokit',
      'src/server/collectors/github/zz.ts',
      "import { Octokit } from '@octokit/rest';\nexport { Octokit };\n",
    ],
    ['axios', 'src/server/services/zz.ts', "import axios from 'axios';\nexport { axios };\n"],
    [
      'WebSocket',
      'src/server/collectors/zz.ts',
      "export const s = new WebSocket('wss://example.com');\n",
    ],
  ];
  for (const [name, file, code] of forbidden) {
    it(`refuses ${name}`, async () => {
      const found = await messages(file, code);
      expect(found.join(' ')).toContain('src/server/lib/net.ts');
    });
  }

  it('lets lib/net.ts call fetch, and lets the server keep serving (a type import of node:http)', async () => {
    expect(
      await messages('src/server/lib/net.ts', 'export const send = (u: string) => fetch(u);\n'),
    ).toEqual([]);
    expect(
      await messages(
        'src/server/zz.ts',
        "import type { Server } from 'node:http';\nexport type S = Server;\n",
      ),
    ).toEqual([]);
  });
});

// Comments and string literals are removed first, so a sentence that mentions `fetch(` cannot fail the scan.
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, "''");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe('a scan of every source file', () => {
  // The browser calls its own server through one function; the server reaches out through one module.
  const ALLOWED = new Set(['src/client/lib/api.ts', 'src/server/lib/net.ts']);
  const SENDS = [
    /\bfetch\s*\(/,
    /\bglobalThis\s*\.\s*fetch\b/,
    /\bXMLHttpRequest\b/,
    /\bnew\s+WebSocket\b/,
    /\bnew\s+EventSource\b/,
    /\bsendBeacon\b/,
  ];
  const files = sourceFiles(join(ROOT, 'src')).map((path) => relative(ROOT, path));

  it('finds the source files it is meant to read', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('src/client/lib/api.ts');
  });

  it('finds no way to send a request outside the two allowed files', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (ALLOWED.has(file)) continue;
      const text = code(readFileSync(join(ROOT, file), 'utf8'));
      for (const pattern of SENDS) if (pattern.test(text)) offenders.push(`${file}: ${pattern}`);
    }
    expect(offenders).toEqual([]);
  });

  it('finds no HTTP client imported anywhere under src/server', () => {
    const CLIENTS =
      /from\s+['"](?:node:https|node:http2|node:tls|node:dgram|undici|node-fetch|axios|got|ws|@octokit\/[^'"]+)['"]/;
    const offenders = files
      .filter((file) => file.startsWith('src/server/'))
      .filter((file) => CLIENTS.test(readFileSync(join(ROOT, file), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('keeps node:http to the type of the server it listens with', () => {
    const offenders = files
      .filter((file) => file.startsWith('src/server/'))
      .filter((file) => /from\s+['"]node:http['"]/.test(readFileSync(join(ROOT, file), 'utf8')))
      .filter(
        (file) =>
          !/import\s+type\s+\{[^}]*\}\s+from\s+['"]node:http['"]/.test(
            readFileSync(join(ROOT, file), 'utf8'),
          ),
      );
    expect(offenders).toEqual([]);
  });
});
