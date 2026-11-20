import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Proves the architecture rules in eslint.config.js fire on a sample import, and that the allowed
// directions stay allowed. The rules guard TECH.md's layer table, so a silent misconfiguration would
// otherwise only show up as a missing error.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const eslint = new ESLint({ cwd: ROOT });

async function restrictions(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: resolve(ROOT, filePath) });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === 'no-restricted-imports' || m.ruleId === 'no-restricted-globals')
    .map((m) => `${m.ruleId}: ${m.message}`);
}

describe('layer boundaries', () => {
  const forbidden: Array<[name: string, file: string, code: string, fragment: string]> = [
    [
      'styled-components in a component',
      'src/client/components/Zz.tsx',
      "import styled from 'styled-components';\nexport const A = styled.div``;\n",
      'styled-components',
    ],
    [
      'styled-components in the server',
      'src/server/zz.ts',
      "import styled from 'styled-components';\nexport { styled };\n",
      'styled-components',
    ],
    [
      'shared importing the server',
      'src/shared/domain/zz.ts',
      "import { x } from '../../server/db/open';\nexport { x };\n",
      'must not import server or client',
    ],
    [
      'shared importing the client',
      'src/shared/contracts/zz.ts',
      "import { x } from '../../client/lib/cx';\nexport { x };\n",
      'must not import server or client',
    ],
    [
      'shared importing React',
      'src/shared/domain/zz.ts',
      "import { useState } from 'react';\nexport { useState };\n",
      'framework-free',
    ],
    [
      'shared importing node:fs',
      'src/shared/domain/zz.ts',
      "import { readFileSync } from 'node:fs';\nexport { readFileSync };\n",
      'no node:*',
    ],
    [
      'server importing the client',
      'src/server/zz.ts',
      "import { x } from '../client/lib/cx';\nexport { x };\n",
      'must not import client',
    ],
    [
      'server importing React',
      'src/server/zz.ts',
      "import { useState } from 'react';\nexport { useState };\n",
      'UI libraries',
    ],
    [
      'server importing Astryx',
      'src/server/zz.ts',
      "import { Button } from '@astryxdesign/core/Button';\nexport { Button };\n",
      'UI libraries',
    ],
    [
      'the HTTP layer importing node:sqlite',
      'src/server/http/zz.ts',
      "import { DatabaseSync } from 'node:sqlite';\nexport { DatabaseSync };\n",
      'SQL stays inside src/server/db',
    ],
    [
      'a service importing node:sqlite',
      'src/server/services/zz.ts',
      "import { DatabaseSync } from 'node:sqlite';\nexport { DatabaseSync };\n",
      'SQL stays inside src/server/db',
    ],
    [
      'the server importing a second SQLite engine outside db',
      'src/server/zz.ts',
      "import Database from 'better-sqlite3';\nexport { Database };\n",
      'SQL stays inside src/server/db',
    ],
    [
      'the db module importing React',
      'src/server/db/zz.ts',
      "import { useState } from 'react';\nexport { useState };\n",
      'UI libraries',
    ],
    [
      'client importing the server',
      'src/client/lib/zz.ts',
      "import { x } from '../../server/db/open';\nexport { x };\n",
      'must not import server',
    ],
    [
      'client importing node:fs',
      'src/client/lib/zz.ts',
      "import { readFileSync } from 'node:fs';\nexport { readFileSync };\n",
      'browser',
    ],
    [
      'a feature importing another feature (relative)',
      'src/client/features/usage/Zz.tsx',
      "import { OverviewRoute } from '../overview/route';\nexport { OverviewRoute };\n",
      "another feature's internals",
    ],
    [
      'a feature importing another feature (via features/)',
      'src/client/features/usage/Zz.tsx',
      "import { OverviewRoute } from '../../features/overview/route';\nexport { OverviewRoute };\n",
      "another feature's internals",
    ],
    [
      'a component importing a feature',
      'src/client/components/Zz.tsx',
      "import { UsageRoute } from '../features/usage/route';\nexport { UsageRoute };\n",
      'must not import features',
    ],
    [
      'lib importing a component',
      'src/client/lib/zz.ts',
      "import { Icon } from '../components/Icon';\nexport { Icon };\n",
      'plumbing',
    ],
    [
      'lib importing a feature',
      'src/client/lib/zz.ts',
      "import { UsageRoute } from '../features/usage/route';\nexport { UsageRoute };\n",
      'plumbing',
    ],
    [
      'fetch outside lib/api.ts',
      'src/client/features/usage/zz.ts',
      "export const load = () => fetch('/api/usage');\n",
      'lib/api.ts',
    ],
  ];

  it.each(forbidden)('rejects %s', async (_name, file, code, fragment) => {
    const found = await restrictions(file, code);
    expect(
      found.some((m) => m.includes(fragment)),
      `expected "${fragment}" in ${JSON.stringify(found)}`,
    ).toBe(true);
  });

  const allowed: Array<[name: string, file: string, code: string]> = [
    [
      'a feature using components and lib',
      'src/client/features/usage/Zz.tsx',
      "import { Icon } from '../../components/Icon';\nimport { cx } from '../../lib/cx';\nexport { Icon, cx };\n",
    ],
    [
      'a component using lib',
      'src/client/components/Zz.tsx',
      "import { cx } from '../lib/cx';\nexport { cx };\n",
    ],
    [
      'the client using shared code',
      'src/client/lib/zz.ts',
      "import { x } from '../../shared/domain/zz';\nexport { x };\n",
    ],
    [
      'the server using shared code',
      'src/server/zz.ts',
      "import { x } from '../shared/domain/zz';\nimport { readFileSync } from 'node:fs';\nexport { x, readFileSync };\n",
    ],
    [
      'the db module using node:sqlite',
      'src/server/db/zz.ts',
      "import { DatabaseSync } from 'node:sqlite';\nexport { DatabaseSync };\n",
    ],
    [
      'shared using zod-style third-party code',
      'src/shared/contracts/zz.ts',
      "import { z } from 'zod';\nexport { z };\n",
    ],
    [
      'fetch inside lib/api.ts',
      'src/client/lib/api.ts',
      "export const load = () => fetch('/api/usage');\n",
    ],
  ];

  it.each(allowed)('allows %s', async (_name, file, code) => {
    expect(await restrictions(file, code)).toEqual([]);
  });
});

describe('formatting rules', () => {
  it('leaves no ESLint rule that conflicts with Prettier', () => {
    const bin = resolve(ROOT, 'node_modules/eslint-config-prettier/bin/cli.js');
    // Exits non-zero if any active rule conflicts with Prettier; the message goes to stderr.
    const run = spawnSync(
      process.execPath,
      [bin, 'src/client/main.tsx', 'scripts/generate-tokens.ts', 'eslint.config.js'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout + run.stderr).toContain(
      'No rules that are unnecessary or conflict with Prettier',
    );
  });
});
