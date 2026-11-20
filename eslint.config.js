// ESLint (flat config). Enforces the module boundaries from TECH.md "System and implementation architecture":
//   shared  -> pure: no server, client, React or node:* imports
//   server  -> no client or React/Astryx imports
//   client  -> no server or node:* imports; features never import each other; components and lib never import
//              features; `fetch` only inside src/client/lib/api.ts
// and the stack rule: no styled-components (frontend-standards; it needs an explicit owner exception),
// and two rules for everything under src: nothing imports test/ or scripts/ (the product must not depend on the code that checks
// it, and a fixture or seed must never reach the build), and nothing uses dangerouslySetInnerHTML (TECH › Security: XSS).
// test/lint/boundaries.test.ts proves each rule fires on a sample import.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import { existsSync, readdirSync } from 'node:fs';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const featuresDir = new URL('./src/client/features/', import.meta.url);
const features = existsSync(featuresDir)
  ? readdirSync(featuresDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  : [];

const STYLED = {
  name: 'styled-components',
  message:
    'styled-components needs an explicit owner exception (frontend-standards). Use Tailwind utilities and Astryx.',
};
const PUBLIC_UI = ['react', 'react-dom', '@astryxdesign/*'];

/** `no-restricted-imports` options for one layer. Later config blocks replace earlier ones, so each lists everything. */
const restrict = ({ paths = [], patterns = [] }) => [
  'error',
  { paths: [STYLED, ...paths], patterns },
];
const group = (names, message) => ({ group: names, message });
// Every layer under src carries this pattern in its own list, because a later block replaces an earlier one's options.
const TEST_IMPORTS =
  'src/ must not import from test/ or scripts/: fixtures, seeds and previews stay out of the product.';
const testImports = group(['**/test', '**/test/**', '**/scripts', '**/scripts/**'], TEST_IMPORTS);

const sharedRules = restrict({
  paths: [
    { name: 'react', message: 'src/shared is pure and framework-free.' },
    { name: 'react-dom', message: 'src/shared is pure and framework-free.' },
  ],
  patterns: [
    testImports,
    group(['**/server/**', '**/client/**'], 'src/shared must not import server or client code.'),
    group(['node:*'], 'src/shared is pure: no node:* modules (no I/O, DB or network).'),
  ],
});
const serverBase = {
  paths: PUBLIC_UI.filter((n) => !n.includes('*')).map((name) => ({
    name,
    message: 'src/server must not import UI libraries.',
  })),
  patterns: [
    testImports,
    group(['**/client/**'], 'src/server must not import client code.'),
    group(['@astryxdesign/*'], 'src/server must not import UI libraries.'),
  ],
};
// All SQL lives in src/server/db (TECH: "the only SQLite access"); everything else calls its typed query functions.
// Outbound HTTP leaves through src/server/lib/net.ts, with separate scopes for GitHub and the explicit Claude plan check.
// No other file under src/server may call `fetch` or reach for an HTTP client. Inbound serving
// (`import type { Server } from 'node:http'`, @hono/node-server) is not an outbound client and stays allowed.
const OUTBOUND =
  'Outbound HTTP goes through src/server/lib/net.ts, which enforces the provider allowlists (TECH › Security and privacy).';
const outboundPaths = [
  {
    name: 'node:http',
    importNames: ['request', 'get', 'Agent', 'globalAgent'],
    message: OUTBOUND,
  },
  { name: 'node:net', importNames: ['connect', 'createConnection', 'Socket'], message: OUTBOUND },
];
const serverRules = restrict({
  paths: [...serverBase.paths, ...outboundPaths],
  patterns: [
    ...serverBase.patterns,
    group(
      ['node:sqlite', 'better-sqlite3', 'sqlite3'],
      'SQL stays inside src/server/db: call a typed query function from there.',
    ),
    group(
      [
        'node:https',
        'node:http2',
        'node:tls',
        'node:dgram',
        'undici',
        'node-fetch',
        'axios',
        'got',
        'ws',
        '@octokit/*',
      ],
      OUTBOUND + ' There is no Octokit and no other HTTP client.',
    ),
  ],
});
const dbRules = restrict(serverBase);
const clientPatterns = [
  testImports,
  group(['**/server/**'], 'src/client must not import server code.'),
  group(
    ['node:*', 'hono', '@hono/*'],
    'src/client runs in the browser: no node:* or server frameworks.',
  ),
];
const clientRules = restrict({ patterns: clientPatterns });
const componentRules = restrict({
  patterns: [
    ...clientPatterns,
    group(
      ['**/features/**'],
      'src/client/components must not import features (features import components).',
    ),
  ],
});
const libRules = restrict({
  patterns: [
    ...clientPatterns,
    group(
      ['**/features/**', '**/components/**'],
      'src/client/lib is plumbing: it must not import features or components.',
    ),
  ],
});
const featureRules = (name) =>
  restrict({
    patterns: [
      ...clientPatterns,
      group(
        features
          .filter((other) => other !== name)
          .flatMap((other) => [`**/features/${other}/**`, `../${other}/**`]),
        "A feature must not import another feature's internals. Share through src/client/components or src/client/lib.",
      ),
    ],
  });

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      '.harness-dist/**',
      'node_modules/**',
      '.pnpm-store/**',
      '.pdlc/**',
      '.claude/**',
      'playwright-report/**',
      'test-results/**',
      'coverage/**',
      // Accepted inputs from earlier stages: authoritative, not linted or reformatted here.
      'docs/**',
      'design-system/**',
      'DESIGN.md',
      'PRODUCT.md',
      'TECH.md',
      // Generated by scripts/generate-tokens.ts; tokens:check guards them instead.
      'src/client/theme/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-restricted-imports': restrict({}) },
  },
  {
    files: [
      'src/client/**/*.{ts,tsx}',
      'test/shell/**/*.{ts,tsx}',
      'test/client/**/*.{ts,tsx}',
      'test/components/**/*.{ts,tsx}',
      'test/e2e/harness/**/*.{ts,tsx}',
    ],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['**/*.tsx'],
    ...jsxA11y.flatConfigs.recommended,
  },
  {
    files: ['**/*.{ts,tsx}'],
    ...reactHooks.configs.flat.recommended,
  },
  { files: ['src/shared/**/*.{ts,tsx}'], rules: { 'no-restricted-imports': sharedRules } },
  { files: ['src/server/**/*.{ts,tsx}'], rules: { 'no-restricted-imports': serverRules } },
  { files: ['src/server/db/**/*.ts'], rules: { 'no-restricted-imports': dbRules } },
  { files: ['src/client/**/*.{ts,tsx}'], rules: { 'no-restricted-imports': clientRules } },
  {
    files: ['src/client/components/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': componentRules },
  },
  { files: ['src/client/lib/**/*.{ts,tsx}'], rules: { 'no-restricted-imports': libRules } },
  ...features.map((name) => ({
    files: [`src/client/features/${name}/**/*.{ts,tsx}`],
    rules: { 'no-restricted-imports': featureRules(name) },
  })),
  {
    files: ['src/server/**/*.ts'],
    ignores: ['src/server/lib/net.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'].map((name) => ({
          name,
          message: OUTBOUND,
        })),
      ],
    },
  },
  {
    files: ['src/client/**/*.{ts,tsx}'],
    ignores: ['src/client/lib/api.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Call the API through src/client/lib/api.ts.' },
      ],
    },
  },
  // A dynamic `import('../test/…')` is not an import declaration, so `no-restricted-imports` cannot see it; a syntax selector does.
  // `dangerouslySetInnerHTML` is how React is made to render text as markup: the product renders every title and name as text.
  {
    files: ['src/**/*.{ts,tsx,mjs}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression > Literal[value=/\\.\\.\\W+(test|scripts)($|\\W)/]',
          message: TEST_IMPORTS,
        },
        {
          selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
          message:
            'Render text as text: dangerouslySetInnerHTML is not allowed (TECH › Security and privacy: XSS).',
        },
        {
          selector:
            'Property[key.name="dangerouslySetInnerHTML"], Property[key.value="dangerouslySetInnerHTML"]',
          message:
            'Render text as text: dangerouslySetInnerHTML is not allowed (TECH › Security and privacy: XSS).',
        },
      ],
    },
  },
  // Last: switch off every formatting rule that would fight Prettier.
  prettier,
);
