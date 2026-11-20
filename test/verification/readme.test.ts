import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PORT,
  LOOPBACK_HOST,
  defaultDataDir,
  loadConfig,
} from '../../src/server/lib/config.ts';
import {
  ROOT,
  SOURCE_LINKS,
  TOKEN_GENERATOR,
  UNNAMED_SCRIPTS,
  codeSpans,
  envReadsIn,
  envScopeFiles,
  linkTargets,
  read,
  readmeProblems,
  documentedVariables,
  section,
  type ReadmeInput,
} from './lib.ts';

// G10_7: README and setup commands and configuration match the manifest and the code.
// Negative controls check that a broken instruction or stale link is detected.

const readme = read('README.md');
const setup = read('docs/delivery/setup.md');
const pkg = JSON.parse(read('package.json')) as {
  scripts: Record<string, string>;
  engines: { node: string };
  packageManager: string;
};
const cli = JSON.parse(read('packages/cli/package.json')) as {
  name: string;
  version: string;
  bin: Record<string, string>;
};

const envReads = new Set(
  envScopeFiles().flatMap((path) => [...envReadsIn(readFileSync(join(ROOT, path), 'utf8'))]),
);

const sourceFiles = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );

const config = loadConfig({ AGENT_PRODUCTIVITY_DATA_DIR: '/data' });
const facts = (override: Partial<ReadmeInput> = {}): ReadmeInput => ({
  readme,
  setup,
  scripts: pkg.scripts,
  engines: pkg.engines.node,
  packageManager: pkg.packageManager,
  cliPackage: cli.name,
  cliArchive: `${cli.name.slice(1).replace('/', '-')}-${cli.version}.tgz`,
  cliCommand: Object.keys(cli.bin)[0]!,
  host: LOOPBACK_HOST,
  port: DEFAULT_PORT,
  defaultDataDir,
  dataFiles: {
    db: basename(config.dbPath),
    lock: basename(config.lockPath),
    logs: basename(config.logDir),
  },
  writesAppLog: sourceFiles('src/server').some((path) =>
    readFileSync(join(ROOT, path), 'utf8').includes('agent-productivity.log'),
  ),
  envReads,
  exists: (path) => existsSync(join(ROOT, path)),
  readMarkdown: read,
  ...override,
});
const problems = (override: Partial<ReadmeInput> = {}): string[] => readmeProblems(facts(override));

/** Turn the link to `target` into plain text within one section. */
const withoutLink = (markdown: string, heading: string, target: string): string => {
  const body = section(markdown, heading);
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const unlinked = body.replace(new RegExp(`\\[([^\\]]*)\\]\\(${escaped}[^)]*\\)`, 'g'), '$1');
  return markdown.replace(body, () => unlinked);
};

/** `exists`, except for the paths named. */
const existsExcept =
  (...missing: string[]) =>
  (path: string): boolean =>
    !missing.includes(path) && existsSync(join(ROOT, path));

describe('the README and setup guide match package.json and the code', () => {
  it('has something to compare with (so an empty scan cannot pass)', () => {
    expect(Object.keys(pkg.scripts)).toContain('start');
    expect(envReads.size).toBeGreaterThanOrEqual(8);
    expect(envReads).toContain('AGENT_PRODUCTIVITY_PORT');
    expect(documentedVariables(setup).length).toBeGreaterThanOrEqual(8);
    expect(DEFAULT_PORT).toBe(4317);
    // The sources the README defers to really are what the guard reads: both token scripts, both platform defaults, each link.
    expect(Object.keys(UNNAMED_SCRIPTS).sort()).toEqual(['tokens:check', 'tokens:generate']);
    expect(Object.keys(UNNAMED_SCRIPTS).every((name) => name in pkg.scripts)).toBe(true);
    expect(existsSync(join(ROOT, TOKEN_GENERATOR))).toBe(true);
    expect(defaultDataDir('darwin', {}, 'HOME')).not.toBe(defaultDataDir('linux', {}, 'HOME'));
    for (const { document, heading, target } of SOURCE_LINKS) {
      const markdown = document === 'README.md' ? readme : setup;
      expect(linkTargets(section(markdown, heading)).map((link) => link.split('#')[0])).toContain(
        target,
      );
    }
  });

  it('names real commands, the real port and data folder, every variable the code reads, and no variable it does not', () => {
    expect(problems()).toEqual([]);
  });

  describe('negative controls: each fault put in on purpose is found', () => {
    it('a screenshot removed or missing from the README', () => {
      expect(problems({ readme: readme.replace(/^!\[.+$/m, '') })).toContain(
        'The README must show the Overview screenshot before the launch table',
      );
      expect(problems({ exists: existsExcept('docs/images/overview.jpg') })).toContain(
        'README.md links to docs/images/overview.jpg, which does not exist',
      );
    });

    it('a terminal command out of sync with the npm package', () => {
      expect(problems({ cliPackage: '@example/other-cli' })).toEqual([
        'The README launch table must document how to open the dashboard with Terminal',
      ]);
    });

    it('a fallback command out of sync with the CLI archive', () => {
      expect(problems({ cliArchive: 'other.tgz' })).toEqual([
        'The setup guide must show the npx command for the packed CLI',
      ]);
    });

    it('a skill instruction out of sync with its setup heading', () => {
      expect(problems({ readme: readme.replace('#install-the-agent-skill', '') })).toContain(
        'The README launch table must link Agent skill to its setup instructions',
      );
    });

    it('a script renamed in package.json', () => {
      const { start, ...rest } = pkg.scripts;
      expect(start).toBeDefined();
      const found = problems({ scripts: { ...rest, serve: start! } }).join('\n');
      expect(found).toMatch(/README\.md names "pnpm start", which package.json does not define/);
      expect(found).toMatch(/package.json defines "serve", which neither document names/);
    });

    it('a script the README names that package.json does not have', () => {
      const changed = readme.replace('`pnpm bench`', '`pnpm benchmark`');
      expect(problems({ readme: changed }).join('\n')).toMatch(
        /"pnpm benchmark", which package.json does not define/,
      );
    });

    it('a start script that is no longer what the README describes', () => {
      expect(problems({ scripts: { ...pkg.scripts, start: 'node other.ts' } }).join('\n')).toMatch(
        /"pnpm start" is now "node other.ts"/,
      );
    });

    it.each([
      ['readme', readme, 'README.md'],
      ['setup', setup, 'docs/delivery/setup.md'],
    ] as const)(
      'the install, build and start commands out of order in %s',
      (key, markdown, path) => {
        const swapped = markdown.replace('pnpm build\npnpm start', 'pnpm start\npnpm build');
        expect(problems({ [key]: swapped })).toContain(
          `${path} must show pnpm install --frozen-lockfile, pnpm build, pnpm start in that order`,
        );
      },
    );

    it('a command the setup guide names that package.json does not have', () => {
      const changed = setup.replace('pnpm test:contract', 'pnpm test:contracts');
      expect(problems({ setup: changed })).toContain(
        'docs/delivery/setup.md names "pnpm test:contracts", which package.json does not define',
      );
    });

    it('a default port that moved in the code', () => {
      const found = problems({ port: 4318 }).join('\n');
      expect(found).toMatch(/does not give http:\/\/127\.0\.0\.1:4318/);
      expect(found).toMatch(
        /names http:\/\/127\.0\.0\.1:4317, but the default is http:\/\/127\.0\.0\.1:4318/,
      );
      expect(found).toMatch(/AGENT_PRODUCTIVITY_PORT row does not say the default is \*\*4318\*\*/);
    });

    it('a port that changed in the README only', () => {
      expect(
        problems({ readme: readme.replaceAll('127.0.0.1:4317', '127.0.0.1:4318') }).join('\n'),
      ).toMatch(
        /README\.md names http:\/\/127\.0\.0\.1:4318, but the default is http:\/\/127\.0\.0\.1:4317/,
      );
    });

    it('a file in the data folder renamed in the code', () => {
      const found = problems({
        dataFiles: { db: 'main.db', lock: 'agent-productivity.lock', logs: 'logs' },
      });
      expect(found.join('\n')).toMatch(/does not name main\.db/);
    });

    describe('the data folder defaults the guide leaves to the configuration', () => {
      it('a default that is not below the home folder, or the same on both platforms', () => {
        expect(problems({ defaultDataDir: () => '/var/crew' }).join('\n')).toMatch(
          /does not give macOS and Linux each a default data folder below the home folder/,
        );
        expect(
          problems({ defaultDataDir: (_platform, _env, home) => join(home, 'crew') }).join('\n'),
        ).toMatch(/does not give macOS and Linux each a default data folder/);
      });

      it('XDG_DATA_HOME no longer the Linux parent', () => {
        const found = problems({
          defaultDataDir: (platform, env, home) =>
            platform === 'linux'
              ? join(home, '.local', 'share', 'crew')
              : defaultDataDir(platform, env, home),
        }).join('\n');
        expect(found).toMatch(/XDG_DATA_HOME is not the parent of the Linux data folder/);
      });

      it('XDG_DATA_HOME starting to move the macOS folder', () => {
        const found = problems({
          defaultDataDir: (platform, env, home) =>
            defaultDataDir(env['XDG_DATA_HOME'] ? 'linux' : platform, env, home),
        }).join('\n');
        expect(found).toMatch(/XDG_DATA_HOME changes the macOS data folder/);
      });

      it('the setup guide no longer linking to the configuration', () => {
        const found = problems({
          setup: withoutLink(setup, '## Data directory', '../../src/server/lib/config.ts'),
        });
        expect(found).toEqual([
          'docs/delivery/setup.md\'s "## Data directory" section does not link to ../../src/server/lib/config.ts for the platform data folder defaults',
        ]);
      });

      it('the configuration moved', () => {
        expect(problems({ exists: existsExcept('src/server/lib/config.ts') }).join('\n')).toMatch(
          /links to src\/server\/lib\/config\.ts, which does not exist/,
        );
      });
    });

    describe('the token scripts the README leaves to package.json', () => {
      it.each(['## Design tokens', '## Checks'])(
        'the README no longer linking to package.json in %s',
        (heading) => {
          const found = problems({ readme: withoutLink(readme, heading, 'package.json') });
          expect(found).toEqual([
            expect.stringMatching(
              new RegExp(`"${heading}" section does not link to package\\.json`),
            ),
          ]);
        },
      );

      it('a section that points to a source removed from the README', () => {
        const found = problems({ readme: readme.replace('## Design tokens', '## Colors') });
        expect(found.join('\n')).toMatch(/no "## Design tokens" section/);
      });

      it.each(['tokens:generate', 'tokens:check'])('%s removed from package.json', (name) => {
        const { [name]: removed, ...rest } = pkg.scripts;
        expect(removed).toBeDefined();
        expect(problems({ scripts: rest }).join('\n')).toMatch(
          new RegExp(`package.json does not define "${name}"`),
        );
      });

      it('the generator stopped writing, or the check started writing', () => {
        const found = problems({
          scripts: {
            ...pkg.scripts,
            'tokens:generate': `node ${TOKEN_GENERATOR} --check`,
            'tokens:check': `node ${TOKEN_GENERATOR}`,
          },
        }).join('\n');
        expect(found).toMatch(/"pnpm tokens:generate" is now "node [^"]*--check"/);
        expect(found).toMatch(/"pnpm tokens:check" is now "node scripts\/generate-tokens\.ts"/);
      });

      it('a token script that no longer runs the generator', () => {
        expect(
          problems({ scripts: { ...pkg.scripts, 'tokens:check': 'echo --check' } }).join('\n'),
        ).toMatch(/"pnpm tokens:check" is now "echo --check"/);
      });

      it('the generator file missing', () => {
        expect(problems({ exists: existsExcept(TOKEN_GENERATOR) }).join('\n')).toMatch(
          /token scripts run scripts\/generate-tokens\.ts, which does not exist/,
        );
      });

      it('"pnpm verify" no longer running the parity check', () => {
        const verify = pkg.scripts['verify']!;
        expect(verify).toContain(' && pnpm tokens:check');
        expect(
          problems({
            scripts: { ...pkg.scripts, verify: verify.replace(' && pnpm tokens:check', '') },
          }).join('\n'),
        ).toMatch(/"pnpm verify" no longer runs "pnpm tokens:check"/);
      });

      it('a new script is not covered by the two the README leaves to package.json', () => {
        expect(problems({ scripts: { ...pkg.scripts, deploy: 'echo deploy' } }).join('\n')).toMatch(
          /package\.json defines "deploy", which neither document names/,
        );
      });
    });

    it('a variable the code reads that the table does not list', () => {
      const found = problems({ envReads: new Set([...envReads, 'CREW_SECRET_SAUCE']) }).join('\n');
      expect(found).toMatch(
        /code reads CREW_SECRET_SAUCE, which the setup guide's Environment variables table does not list/,
      );
    });

    it('a variable the table lists that nothing reads', () => {
      const without = new Set(envReads);
      without.delete('BENCH_RECORD');
      expect(problems({ envReads: without }).join('\n')).toMatch(
        /setup guide lists BENCH_RECORD, which nothing in the code reads/,
      );
    });

    it('a variable row removed from the table', () => {
      const lines = setup.split('\n').filter((line) => !line.startsWith('| `XDG_DATA_HOME`'));
      expect(problems({ setup: lines.join('\n') }).join('\n')).toMatch(
        /code reads XDG_DATA_HOME, which/,
      );
    });

    it('a variable listed twice', () => {
      const row = setup.split('\n').find((line) => line.startsWith('| `CODEX_HOME`'))!;
      expect(problems({ setup: setup.replace(row, `${row}\n${row}`) }).join('\n')).toMatch(
        /lists a variable twice/,
      );
    });

    it('a section the goal names that is missing', () => {
      const without = readme.replace('## Gotchas', '## Notes');
      expect(problems({ readme: without }).join('\n')).toMatch(/no "## Gotchas" section/);
    });

    it('a link to a page that does not exist', () => {
      const broken = `${readme}\n[gone](docs/implementation/not-here.md)\n`;
      expect(problems({ readme: broken }).join('\n')).toMatch(
        /links to docs\/implementation\/not-here\.md, which does not exist/,
      );
    });

    it('a link from the README to an outdated setup section', () => {
      const changed = setup.replace('## When something is wrong', '## Recovery');
      expect(problems({ setup: changed })).toContain(
        'README.md links to docs/delivery/setup.md#when-something-is-wrong, which has no matching heading',
      );
    });

    it('a link from the setup guide to an outdated README section', () => {
      const changed = readme.replace('### First launch (Setup)', '### Get started');
      expect(problems({ readme: changed })).toContain(
        'docs/delivery/setup.md links to README.md#first-launch-setup, which has no matching heading',
      );
    });

    it('a Node range or pnpm version that moved', () => {
      const found = problems({ engines: '>=27.0.0', packageManager: 'pnpm@12.0.0' }).join('\n');
      expect(found).toMatch(/Node engine range >=27\.0\.0/);
      expect(found).toMatch(/pnpm 12\.0\.0/);
    });
  });

  describe('how the README’s commands are read', () => {
    it('reads only code, not prose that happens to say pnpm', () => {
      expect(
        codeSpans('pnpm keeps its store.\n\n```sh\npnpm build # makes pnpm sing\n```\n`pnpm test`'),
      ).toBe('pnpm build\npnpm test');
    });

    it('reads the variable table', () => {
      expect(
        documentedVariables(
          '## Environment variables\n\n| Variable | Read by |\n| --- | --- |\n| `AGENT_PRODUCTIVITY_PORT` | start |\n| not a name | x |\n',
        ),
      ).toEqual(['AGENT_PRODUCTIVITY_PORT']);
    });
  });
});
