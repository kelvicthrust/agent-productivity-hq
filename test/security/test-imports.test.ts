import { resolve } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { ROOT } from './techTable.ts';

// Nothing under src/ may import from test/ (or scripts/): the product must not depend on the code that checks it, and a test
// helper that reaches the build would ship fixtures, seeds and preview data. The rule is `no-restricted-imports` with the patterns
// below, applied here to every file under src/ through ESLint's own API, so it needs no change to eslint.config.js. The same
// patterns, added to that file's rule options for src/**, make `pnpm lint` enforce it on every run.

const TEST_IMPORT_PATTERNS = [
  {
    group: ['**/test', '**/test/**', '**/scripts', '**/scripts/**'],
    message:
      'src/ must not import from test/ or scripts/: fixtures, seeds and previews stay out of the product.',
  },
];
const MESSAGE = TEST_IMPORT_PATTERNS[0]!.message;

// `no-restricted-imports` covers `import` and `export … from`; a dynamic `import('…')` needs a syntax selector of its own.
const DYNAMIC_IMPORT = {
  selector: 'ImportExpression > Literal[value=/\\.\\.\\W+(test|scripts)($|\\W)/]',
  message: MESSAGE,
};

const eslint = new ESLint({
  cwd: ROOT,
  overrideConfig: {
    files: ['src/**/*.{ts,tsx,mjs}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: TEST_IMPORT_PATTERNS }],
      'no-restricted-syntax': ['error', DYNAMIC_IMPORT],
    },
  },
});

const findings = async (filePath: string, code: string) => {
  const [result] = await eslint.lintText(code, { filePath: resolve(ROOT, filePath) });
  return (result?.messages ?? []).filter((m) => m.message.endsWith(MESSAGE)).length;
};

describe('src/ does not import test/ or scripts/', () => {
  it('the rule fires on every way of reaching them, and leaves ordinary imports alone', async () => {
    const bad = [
      "import { seedDatabase } from '../../test/fixtures/seed.ts';\nexport { seedDatabase };\n",
      "export { FIXED_NOW } from '../../../test/fixtures/seed.ts';\n",
      "export const load = () => import('../../test/helpers/x.ts');\n",
      "import type { World } from '../../../test/e2e/helpers/world';\nexport type { World };\n",
      "import { run } from '../../scripts/preview-seed.ts';\nexport { run };\n",
    ];
    for (const code of bad) expect(await findings('src/server/zz.ts', code), code).toBe(1);
    for (const file of ['src/client/lib/zz.ts', 'src/shared/domain/zz.ts'])
      expect(await findings(file, bad[0]!), file).toBe(1);
    const fine = [
      "import { z } from 'zod';\nexport { z };\n",
      "import { ErrorEnvelope } from '../../shared/contracts/errors.ts';\nexport { ErrorEnvelope };\n",
      "import { testimony } from './testimony.ts';\nexport { testimony };\n", // a name that merely contains "test"
      "import { latest } from '../contest/latest.ts';\nexport { latest };\n",
    ];
    for (const code of fine) expect(await findings('src/server/zz.ts', code), code).toBe(0);
  });

  it('no file under src/ breaks it', async () => {
    const results = await eslint.lintFiles(['src/**/*.{ts,tsx,mjs}']);
    const offending = results.flatMap((r) =>
      r.messages
        .filter((m) => m.message.endsWith(MESSAGE))
        .map((m) => `${r.filePath.replace(`${ROOT}/`, '')}:${m.line}`),
    );
    expect(offending).toEqual([]);
    expect(results.length).toBeGreaterThan(100); // it looked at the whole tree
  }, 120_000);
});
