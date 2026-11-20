import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Two rules that hold for everything under src/ (G10_8; TECH › Security and privacy: XSS), proved the way boundaries.test.ts proves the
// layer rules: through the repository's own eslint.config.js, on sample code in every layer, so a rule that stops firing in one
// layer (a later config block replaces an earlier one's options) shows here and not as a quiet gap.
//   1. nothing under src/ imports test/ or scripts/, statically or with import(), in any layer;
//   2. nothing under src/ uses dangerouslySetInnerHTML.
// A second check does not trust ESLint at all: it reads every import in src/ and resolves it on disk.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const eslint = new ESLint({ cwd: ROOT });

async function messages(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath: resolve(ROOT, filePath) });
  return (result?.messages ?? []).filter(
    (m) => m.ruleId === 'no-restricted-imports' || m.ruleId === 'no-restricted-syntax',
  );
}
const testImportFindings = async (file: string, code: string) =>
  (await messages(file, code)).filter((m) => m.message.includes('must not import from test/'));
const htmlFindings = async (file: string, code: string) =>
  (await messages(file, code)).filter((m) => m.message.includes('dangerouslySetInnerHTML'));

const LAYERS = [
  'src/shared/domain/zz.ts',
  'src/server/zz.ts',
  'src/server/db/zz.ts',
  'src/server/http/zz.ts',
  'src/client/lib/zz.ts',
  'src/client/components/Zz.tsx',
  'src/client/features/usage/Zz.tsx',
];

describe('src/ never imports test/ or scripts/', () => {
  it.each(LAYERS)('the rule fires in %s, for import, export-from and import()', async (file) => {
    const depth = '../'.repeat(file.split('/').length - 1);
    const cases = [
      `import { seedDatabase } from '${depth}test/fixtures/seed.ts';\nexport { seedDatabase };\n`,
      `export { FIXED_NOW } from '${depth}test/fixtures/seed.ts';\n`,
      `import { run } from '${depth}scripts/preview-seed.ts';\nexport { run };\n`,
      `export const load = () => import('${depth}test/helpers/x.ts');\n`,
      `export const load = () => import('${depth}scripts/preview-seed.ts');\n`,
    ];
    for (const code of cases) expect(await testImportFindings(file, code), code).toHaveLength(1);
  });

  it('leaves names that merely contain test or scripts alone', async () => {
    const fine = [
      "import { a } from './testimony.ts';\nexport { a };\n",
      "import { b } from '../contest/latest.ts';\nexport { b };\n",
      "import { c } from './scripts-like.ts';\nexport { c };\n",
      "export const d = () => import('./latest.ts');\n",
    ];
    for (const code of fine)
      expect(await testImportFindings('src/server/zz.ts', code), code).toEqual([]);
  });

  it('does not apply to test/ and scripts/ themselves, which exist to import src/ and each other', async () => {
    const code = "import { x } from '../scripts/preview-seed.ts';\nexport { x };\n";
    expect(await testImportFindings('test/zz.test.ts', code)).toEqual([]);
    expect(
      await testImportFindings(
        'scripts/zz.ts',
        "import { y } from '../test/fixtures/seed.ts';\nexport { y };\n",
      ),
    ).toEqual([]);
  });

  it('holds for the files that exist: every import in src/ resolves outside test/ and scripts/ (read from disk, without ESLint)', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx|mjs)$/.test(entry.name)) files.push(path);
      }
    };
    walk(join(ROOT, 'src'));
    expect(files.length).toBeGreaterThan(100); // it looked at the whole tree

    const specifier = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;
    const offending: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(specifier)) {
        const target = match[1]!;
        if (!target.startsWith('.')) continue;
        const resolved = relative(ROOT, resolve(dirname(file), target));
        if (/^(test|scripts)(\/|$)/.test(resolved))
          offending.push(`${relative(ROOT, file)} -> ${target}`);
      }
    }
    expect(offending).toEqual([]);
  });
});

describe('src/ never uses dangerouslySetInnerHTML', () => {
  it.each(['src/client/components/Zz.tsx', 'src/client/features/usage/Zz.tsx'])(
    'the rule fires in %s, as a JSX attribute and as a createElement property',
    async (file) => {
      const attribute =
        'export const A = ({ html }: { html: string }) => <div dangerouslySetInnerHTML={{ __html: html }} />;\n';
      const property =
        "import { createElement } from 'react';\nexport const B = (html: string) => createElement('div', { dangerouslySetInnerHTML: { __html: html } });\n";
      expect(await htmlFindings(file, attribute), 'JSX attribute').toHaveLength(1);
      expect(await htmlFindings(file, property), 'object property').toHaveLength(1);
    },
  );

  it('leaves ordinary text rendering alone', async () => {
    const fine = 'export const A = ({ title }: { title: string }) => <p>{title}</p>;\n';
    expect(await htmlFindings('src/client/components/Zz.tsx', fine)).toEqual([]);
  });

  it('holds for the files that exist: no file in src/ mentions it in code', () => {
    const offending: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx|mjs)$/.test(entry.name)) {
          const code = readFileSync(path, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
          if (code.includes('dangerouslySetInnerHTML')) offending.push(relative(ROOT, path));
        }
      }
    };
    walk(join(ROOT, 'src'));
    expect(offending).toEqual([]);
  });
});

describe('what preview mode leaves in src/', () => {
  // TECH asks for one thing from the preview in the product: the "Synthetic preview data" label, shown only when the preview command
  // gives the server a label (`previewLabel`). Everything else about the preview (the seed, the scripted sources, the temporary homes)
  // lives in test/ and scripts/. This lists the code that mentions it, comments left out, so a second use cannot appear unseen.
  it('the label is the only preview-mode code in src/: its option in boot.ts, app.ts and static.ts, and nothing else', () => {
    const found = new Map<string, Set<string>>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx|mjs)$/.test(entry.name)) {
          const code = readFileSync(path, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
          const hits = new Set(
            [
              ...code.matchAll(
                /previewLabel|withPreviewLabel|PREVIEW_STYLE|data-preview-label|preview:seed|preview-data|preview-isolated|Synthetic preview/g,
              ),
            ].map((m) => m[0]),
          );
          if (hits.size > 0) found.set(relative(ROOT, path), hits);
        }
      }
    };
    walk(join(ROOT, 'src'));
    expect([...found.keys()].sort()).toEqual([
      'src/server/boot.ts',
      'src/server/http/app.ts',
      'src/server/http/static.ts',
    ]);
    for (const hits of found.values())
      for (const hit of hits)
        expect([
          'previewLabel',
          'withPreviewLabel',
          'PREVIEW_STYLE',
          'data-preview-label',
        ]).toContain(hit); // never the seed command, its data folder or its isolation test
    expect(found.get('src/server/boot.ts')).toEqual(new Set(['previewLabel']));
  });
});
