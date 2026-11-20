import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path';

// What the three guard tests in this folder share (M10, G10_4 and G10_7). They are pure functions over text so each guard can be
// run twice: once on the real files, where it must find nothing wrong, and once on a copy with one fault put in on purpose, where
// it must find exactly that fault. A guard that cannot fail proves nothing.

export const ROOT = join(import.meta.dirname, '../..');

export const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/** The part of a Markdown document under `## heading`, up to the next `## ` heading. */
export function section(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return '';
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

/** The cells of one Markdown table row, trimmed. A `\|` inside a cell stays part of the cell. */
export function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

/** Table body rows (not the header and not the divider) of the first table in `markdown`. */
export function tableRows(markdown: string): string[][] {
  const rows = markdown.split('\n').filter((line) => line.trim().startsWith('|'));
  return rows
    .slice(2) // header, divider
    .map(cells)
    .filter((row) => row.length > 1);
}

// --- TECH's verification plan and the candidate packet (G10_4) -------------------------------------------------------------------

export interface TechRow {
  /** The requirement cell, exactly as TECH writes it ("P-01, P-02", "D7 table layout"). */
  req: string;
  check: string;
  type: string;
}

/** Every row of TECH › Verification plan. */
export function techVerificationRows(tech: string): TechRow[] {
  const lines = tech.split('\n');
  const start = lines.findIndex((line) => line.trim() === '## Verification plan');
  if (start === -1) return [];
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  return tableRows(lines.slice(start + 1, end === -1 ? undefined : end).join('\n')).map((row) => ({
    req: row[0] ?? '',
    check: row[1] ?? '',
    type: row[2] ?? '',
  }));
}

export interface PacketRow {
  req: string;
  evidence: string;
  status: string;
}

export const PACKET_TABLE_HEADING = '## Requirements against checks';

export function packetRows(packet: string): PacketRow[] {
  return tableRows(section(packet, PACKET_TABLE_HEADING)).map((row) => ({
    req: row[0] ?? '',
    evidence: row[1] ?? '',
    status: row[2] ?? '',
  }));
}

/** A status says what happened: a pass, a failure, a not-run, an owner's own run, or something stated as unverified. */
export const STATUS_WORDS = /\b(passed|pass|failed|fail|not-run|owner-run|unverified|done)\b/i;

export const WORD_LIMIT = 3000;

/** The files a packet row may name: every path below these folders, plus the files at the root. */
const INDEXED = ['test', 'scripts', 'src', 'docs'];

export interface FileIndex {
  files: Set<string>;
  names: Set<string>;
}

export function indexFiles(root: string = ROOT): FileIndex {
  const files = new Set<string>();
  const names = new Set<string>();
  const add = (path: string): void => {
    files.add(path);
    names.add(basename(path));
  };
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.name === 'node_modules') continue;
      if (entry.isDirectory()) {
        files.add(path);
        walk(path);
      } else add(path);
    }
  };
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile()) add(entry.name);
  }
  for (const dir of INDEXED) walk(dir);
  return { files, names };
}

/** Backticked tokens in a cell that look like a file or folder (not a command, not a hash). */
export function pathTokens(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1]!)
    .filter((token) => /^[\w@./*+-]+$/.test(token))
    .filter((token) => token.includes('/') || /\.(ts|tsx|md|txt|json|mjs)$/.test(token));
}

/**
 * Does a token name something that exists? A path is looked up as written and under docs/implementation/; a bare file name
 * (`a11y.spec.ts`, written after a folder in the same cell) is found by its name; a `*` is a glob over the indexed paths.
 */
export function resolves(token: string, index: FileIndex): boolean {
  const path = token.replace(/\/$/, '');
  if (path.includes('*')) {
    const pattern = new RegExp(
      `^${path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`,
    );
    return [...index.files].some((file) => pattern.test(file));
  }
  if (index.files.has(path) || index.files.has(join('docs/implementation', path))) return true;
  return !path.includes('/') && index.names.has(path);
}

export interface PacketInput {
  tech: string;
  packet: string;
  index: FileIndex;
}

/** Every way the candidate packet fails G10_4 and G10_9. An empty list is a packet that names every row with evidence and a status. */
export function packetProblems({ tech, packet, index }: PacketInput): string[] {
  const problems: string[] = [];
  const wanted = techVerificationRows(tech);
  if (wanted.length === 0) problems.push('TECH has no verification plan rows to check against');

  const rows = packetRows(packet);
  const named = new Map(rows.map((row) => [row.req, row]));
  for (const { req } of wanted) {
    if (!named.has(req)) problems.push(`no row for TECH's "${req}"`);
  }
  for (const row of rows) {
    if (!STATUS_WORDS.test(row.status))
      problems.push(`"${row.req}" gives no status (passed, not-run, owner-run, unverified ...)`);
    else if (!/^unverified\b/i.test(row.status))
      problems.push(`"${row.req}" is claimed as assessed in the historical packet`);
    const tokens = pathTokens(row.evidence);
    if (tokens.length === 0) problems.push(`"${row.req}" names no file or folder as evidence`);
    for (const token of tokens) {
      if (!resolves(token, index))
        problems.push(`"${row.req}" names \`${token}\`, which does not exist`);
    }
  }

  const words = packet.split(/\s+/).filter(Boolean).length;
  if (words > WORD_LIMIT)
    problems.push(`the packet has ${words} words, over the ${WORD_LIMIT} limit`);
  if (!/26\.3\.1/.test(packet)) problems.push('the packet does not name the Node version 26.3.1');
  if (!/not-run/.test(packet)) problems.push('the packet lists nothing as not-run');
  const scope = section(packet, '## Scope');
  if (!scope.includes('Historical candidate'))
    problems.push('the packet does not identify its historical scope');
  if (!scope.includes('No current runtime assessment'))
    problems.push('the packet does not state the limit on current runtime assessment');
  for (const experiment of ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E8']) {
    if (!new RegExp(`\\b${experiment}\\b`).test(packet))
      problems.push(`the packet does not account for the ${experiment} experiment`);
  }
  for (const heading of [
    '## Simulated, stubbed, not-run',
    '## Limits, decisions, recovery',
    '## Verification should target',
  ]) {
    if (!packet.includes(heading)) problems.push(`the packet has no "${heading}" section`);
  }
  return problems;
}

// --- The README and setup guide against package.json and the code (G10_7) --------------------------------------------------------

/** `pnpm` words that are not scripts in package.json. */
export const PNPM_BUILTINS = new Set(['install', 'exec', 'audit', 'add', 'run', 'dlx', 'i']);

/** Variables read directly by tools outside this project's code. */
export const READ_BY_TOOLS = new Set(['PLAYWRIGHT_BROWSERS_PATH']);

/**
 * Scripts the README need not name, each with the reason. The README reaches these through its link to package.json (see
 * SOURCE_LINKS), so the guard checks that the link is there and that each script still exists and still does its job, instead of
 * looking for the command's text.
 */
export const UNNAMED_SCRIPTS: Record<string, string> = {
  'tokens:generate': 'the README sends the reader to package.json for token generation',
  'tokens:check': 'the README sends the reader to package.json for the token parity check',
};

/** The generator both token scripts run: `tokens:check` is the same program with `--check`, which writes nothing. */
export const TOKEN_GENERATOR = 'scripts/generate-tokens.ts';

/**
 * Where the README names a canonical source instead of copying what it says: the section that must link to it, the file it must
 * link to, and what it stands in for. Their text is not copied into the README, so the guard checks the link, and checks the
 * source for the facts the README states about it (the scripts above, the data folder rules in `readmeProblems`).
 */
export interface SourceLink {
  document: 'README.md' | 'docs/delivery/setup.md';
  heading: string;
  target: string;
  covers: string;
}

export const SOURCE_LINKS: SourceLink[] = [
  {
    document: 'README.md',
    heading: '## Design tokens',
    target: 'package.json',
    covers: 'the token generation and parity scripts',
  },
  {
    document: 'README.md',
    heading: '## Checks',
    target: 'package.json',
    covers: 'the token parity check',
  },
  {
    document: 'README.md',
    heading: '## Run from source',
    target: 'docs/delivery/setup.md',
    covers: 'configuration, recovery and upgrades',
  },
  {
    document: 'docs/delivery/setup.md',
    heading: '## Data directory',
    target: '../../src/server/lib/config.ts',
    covers: 'the platform data folder defaults',
  },
];

/** Every Markdown link target in `markdown`, as written (with any `#anchor`). */
export function linkTargets(markdown: string): string[] {
  return [...markdown.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]!);
}

/** Is `path` inside `parent`, at any depth? */
const isBelow = (path: string, parent: string): boolean => {
  const from = relative(parent, path);
  return from !== '' && !from.startsWith('..') && !isAbsolute(from);
};

export interface ReadmeInput {
  readme: string;
  setup: string;
  scripts: Record<string, string>;
  engines: string;
  packageManager: string;
  cliPackage: string;
  cliArchive: string;
  cliCommand: string;
  host: string;
  port: number;
  /**
   * The config's platform default, `defaultDataDir`. The setup guide links to the config and makes
   * claims about it (a default for each platform, `XDG_DATA_HOME` as the Linux parent, ignored on macOS), which are checked here.
   */
  defaultDataDir: (platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string) => string;
  /** The names of the files below the data folder, from the config. */
  dataFiles: { db: string; lock: string; logs: string };
  /** Whether any source file writes `agent-productivity.log`. */
  writesAppLog: boolean;
  /** Every environment variable the project's own code reads. */
  envReads: Set<string>;
  /** Does a repository-relative link target exist? */
  exists: (path: string) => boolean;
  /** Read a linked Markdown file for heading checks. */
  readMarkdown: (path: string) => string;
}

/** The variables listed in the setup guide's `## Environment variables` table. */
export function documentedVariables(setup: string): string[] {
  return tableRows(section(setup, '## Environment variables'))
    .map((row) => /^`([A-Z][A-Z0-9_]*)`$/.exec(row[0] ?? '')?.[1])
    .filter((name): name is string => name !== undefined);
}

/** The code in a Markdown document: fenced blocks (minus their `# comments`) and inline `code`. */
export function codeSpans(markdown: string): string {
  const fenced = [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) =>
    match[1]!
      .split('\n')
      .map((line) => line.replace(/\s#\s.*$/, ''))
      .join('\n')
      .trim(),
  );
  const inline = [...markdown.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map(
    (match) => match[1]!,
  );
  return [...fenced, ...inline].join('\n');
}

export function readmeProblems(input: ReadmeInput): string[] {
  const { readme, setup } = input;
  const documents: Record<SourceLink['document'], string> = {
    'README.md': readme,
    'docs/delivery/setup.md': setup,
  };
  const problems: string[] = [];

  const launchHeading = '## Quick start';
  const sourceHeading = '## Run from source';
  const screenshot = /^!\[[^\]\n]+\]\(docs\/images\/overview\.(?:png|jpe?g)\)/m.exec(readme);
  if (!screenshot || screenshot.index > readme.indexOf(launchHeading))
    problems.push('The README must show the Overview screenshot before the launch table');
  if (readme.indexOf(launchHeading) > readme.indexOf(sourceHeading))
    problems.push('The README must show the launch table before the source instructions');

  const launchRows = new Map(tableRows(section(readme, launchHeading)).map((row) => [row[0], row]));
  const archivePath = `/absolute/path/to/${input.cliArchive}`;
  const archiveCommand = `npx --package="${archivePath}" ${input.cliCommand}`;
  for (const [method, setupLink, action] of [
    [
      'Terminal',
      'docs/delivery/setup.md#run-a-release-archive-with-npx',
      `npx --yes ${input.cliPackage}`,
    ],
    ['Paseo', 'docs/delivery/setup.md#install-from-the-release-archive', 'Agent HQ'],
  ] as const) {
    const row = launchRows.get(method);
    if (!row?.[1] || !linkTargets(row[1]).includes(setupLink))
      problems.push(`The README launch table must link ${method} to its setup instructions`);
    if (!row?.[2]?.includes(action))
      problems.push(
        `The README launch table must document how to open the dashboard with ${method}`,
      );
  }
  const terminalSetup = section(setup, '## Run a release archive with npx');
  if (!terminalSetup.includes(archiveCommand))
    problems.push('The setup guide must show the npx command for the packed CLI');

  // Commands in either document are defined in the manifest. Together they must cover every script.
  const named = new Set<string>();
  for (const [path, markdown] of Object.entries(documents)) {
    const commands = new Set(
      [...codeSpans(markdown).matchAll(/\bpnpm\s+([a-z][a-z0-9:-]*)/g)].map((match) => match[1]!),
    );
    for (const name of commands) {
      named.add(name);
      if (!PNPM_BUILTINS.has(name) && !(name in input.scripts))
        problems.push(`${path} names "pnpm ${name}", which package.json does not define`);
    }
  }
  for (const name of Object.keys(input.scripts)) {
    if (!named.has(name) && !(name in UNNAMED_SCRIPTS))
      problems.push(`package.json defines "${name}", which neither document names`);
  }
  // The scripts the README leaves to package.json must still be there and still do what a reader following the link expects.
  for (const [name, reason] of Object.entries(UNNAMED_SCRIPTS)) {
    if (!(name in input.scripts))
      problems.push(`package.json does not define "${name}": ${reason}`);
  }
  const generate = input.scripts['tokens:generate'];
  if (generate !== undefined && (!generate.includes(TOKEN_GENERATOR) || /--check\b/.test(generate)))
    problems.push(
      `"pnpm tokens:generate" is now "${generate}", not the generator writing the files`,
    );
  const parity = input.scripts['tokens:check'];
  if (parity !== undefined && (!parity.includes(TOKEN_GENERATOR) || !/--check\b/.test(parity)))
    problems.push(
      `"pnpm tokens:check" is now "${parity}", not the generator's check without writing`,
    );
  if (!input.exists(TOKEN_GENERATOR))
    problems.push(`the token scripts run ${TOKEN_GENERATOR}, which does not exist`);
  if (!/\bpnpm\s+tokens:check\b/.test(input.scripts['verify'] ?? ''))
    problems.push(
      '"pnpm verify" no longer runs "pnpm tokens:check", which the README says it does',
    );

  if (input.scripts['start'] !== 'node src/server/main.ts')
    problems.push(
      `"pnpm start" is now "${input.scripts['start']}", which the README does not describe`,
    );

  const pnpmVersion = /^pnpm@(.+)$/.exec(input.packageManager)?.[1];
  const url = `http://${input.host}:${input.port}`;
  for (const [path, markdown] of Object.entries(documents)) {
    const fromSource = path === 'README.md' ? sourceHeading : '## Install and run';
    const installBlock = /```[^\n]*\n([\s\S]*?)```/.exec(section(markdown, fromSource))?.[1] ?? '';
    const commands = installBlock.split('\n').map((line) => line.replace(/\s#\s.*$/, '').trim());
    const order = ['pnpm install --frozen-lockfile', 'pnpm build', 'pnpm start'].map((command) =>
      commands.indexOf(command),
    );
    if (order.some((at) => at === -1) || order[0]! > order[1]! || order[1]! > order[2]!)
      problems.push(
        `${path} must show pnpm install --frozen-lockfile, pnpm build, pnpm start in that order`,
      );

    const requirements = section(
      markdown,
      path === 'README.md' ? sourceHeading : '## Requirements',
    );
    if (!requirements.includes(input.engines))
      problems.push(`${path} does not name the Node engine range ${input.engines}`);
    if (!pnpmVersion || !requirements.includes(`pnpm ${pnpmVersion}`))
      problems.push(`${path} does not name ${input.packageManager.replace('@', ' ')}`);
    if (!markdown.includes(url)) problems.push(`${path} does not give ${url}`);
    for (const [address] of markdown.matchAll(/http:\/\/127\.0\.0\.1:\d+/g)) {
      if (address !== url) problems.push(`${path} names ${address}, but the default is ${url}`);
    }
  }

  const environment = section(setup, '## Environment variables');
  if (
    !new RegExp(`AGENT_PRODUCTIVITY_PORT[^\\n]*Default \\*\\*${input.port}\\*\\*`).test(environment)
  )
    problems.push(`the AGENT_PRODUCTIVITY_PORT row does not say the default is **${input.port}**`);

  // The setup guide links to the config for the platform defaults (the links are checked
  // below), so these are the claims it makes about the config: each platform has its own default below the home folder, XDG_DATA_HOME
  // is the parent of the Linux default and is ignored on macOS. Placeholder names keep this free of any real path.
  const [home, xdg] = ['HOME', 'XDG-DATA'];
  const mac = input.defaultDataDir('darwin', {}, home);
  const linux = input.defaultDataDir('linux', {}, home);
  if (!isBelow(mac, home) || !isBelow(linux, home) || mac === linux)
    problems.push(
      `the config does not give macOS and Linux each a default data folder below the home folder (macOS "${mac}", Linux "${linux}")`,
    );
  if (input.defaultDataDir('darwin', { XDG_DATA_HOME: xdg }, home) !== mac)
    problems.push(
      'XDG_DATA_HOME changes the macOS data folder, but the setup guide says it is ignored there',
    );
  if (dirname(input.defaultDataDir('linux', { XDG_DATA_HOME: xdg }, home)) !== xdg)
    problems.push(
      'XDG_DATA_HOME is not the parent of the Linux data folder, as the setup guide says',
    );
  const dataDirectory = section(setup, '## Data directory');
  if (!dataDirectory.includes(input.dataFiles.db))
    problems.push(`the setup guide does not name ${input.dataFiles.db}`);
  if (!dataDirectory.includes(input.dataFiles.lock))
    problems.push(`the setup guide does not name ${input.dataFiles.lock}`);
  if (
    input.writesAppLog &&
    !dataDirectory.includes(`${input.dataFiles.logs}/agent-productivity.log`)
  )
    problems.push(`the setup guide does not name ${input.dataFiles.logs}/agent-productivity.log`);

  // Environment variables: both directions.
  const documented = documentedVariables(setup);
  for (const name of input.envReads) {
    if (!documented.includes(name))
      problems.push(
        `the code reads ${name}, which the setup guide's Environment variables table does not list`,
      );
  }
  for (const name of documented) {
    if (!input.envReads.has(name) && !READ_BY_TOOLS.has(name))
      problems.push(`the setup guide lists ${name}, which nothing in the code reads`);
  }
  if (new Set(documented).size !== documented.length)
    problems.push('the Environment variables table lists a variable twice');

  // Sections the goal names.
  for (const [markdown, label, headings] of [
    [readme, 'README', ['## Gotchas', '### First launch (Setup)', launchHeading, sourceHeading]],
    [
      setup,
      'setup guide',
      ['## Environment variables', '## When something is wrong', '## Upgrade and rollback'],
    ],
  ] as const) {
    for (const heading of headings) {
      if (!markdown.split('\n').some((line) => line.trim() === heading))
        problems.push(`the ${label} has no "${heading}" section`);
    }
  }
  if (!readme.includes('docs/implementation/experiments/README.md'))
    problems.push('the README does not point to the experiments runbook');

  // Where the README defers to a canonical source, the section that does so links to it.
  for (const { document, heading, target, covers } of SOURCE_LINKS) {
    const body = section(documents[document], heading);
    if (body === '')
      problems.push(
        `${document} has no "${heading}" section, which points to ${target} for ${covers}`,
      );
    else if (!linkTargets(body).some((link) => link.replace(/#.*$/, '') === target))
      problems.push(`${document}'s "${heading}" section does not link to ${target} for ${covers}`);
  }

  for (const [document, markdown] of Object.entries(documents)) {
    for (const target of new Set(linkTargets(markdown))) {
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [file, anchor] = target.split('#');
      const path = file ? join(dirname(document), file) : document;
      if (!input.exists(path)) {
        problems.push(`${document} links to ${path}, which does not exist`);
      } else if (anchor && extname(path) === '.md') {
        const linked = documents[path as SourceLink['document']] ?? input.readMarkdown(path);
        const headings = [...linked.matchAll(/^#{1,6} +(.+)$/gm)].map((match) =>
          match[1]!
            .trim()
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s_-]/gu, '')
            .replaceAll(' ', '-'),
        );
        if (!headings.includes(anchor))
          problems.push(`${document} links to ${path}#${anchor}, which has no matching heading`);
      }
    }
  }
  return problems;
}

/** Every environment variable named in the project's own code: `process.env.X`, `process.env['X']` and `env['X']`. */
export function envReadsIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) found.add(match[1]!);
  for (const match of text.matchAll(/\benv\s*\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\]/g))
    found.add(match[1]!);
  return found;
}

/** The source files whose environment reads belong to the product and its tooling (not the browser code, not other tests). */
export function envScopeFiles(root: string = ROOT): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(path);
      } else if (/\.(ts|mjs)$/.test(entry.name)) out.push(path);
    }
  };
  for (const dir of ['src/server', 'src/shared', 'scripts', 'test/bench']) walk(dir);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && /\.config\.(ts|js|mjs)$/.test(entry.name)) out.push(entry.name);
  }
  return out.filter((path) => !/\.test\.ts$/.test(path) || path.startsWith('test/bench'));
}

export const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

export const relativeTo = (path: string): string => relative(ROOT, path);
