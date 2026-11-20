import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT } from './lib.ts';

// G10_7: `pnpm start` works from a clean checkout. This makes one: only the files git tracks, copied to a new folder, built there
// by its own `pnpm build`, started with `node src/server/main.ts` (what `pnpm start` runs) on a fresh data folder and a fresh HOME
// (so nothing on this Mac is read), and asked for the first screen.
//
// Three honest limits. The installed packages are linked in rather than installed again, because a fresh install needs the network
// cache. The screenshots under docs/implementation/evidence are left out for speed; nothing builds or boots from them. And a sandbox
// that refuses local sockets cannot listen, so the part that serves Setup is then reported NOT RUN (skipped, with the reason), never
// passed: everything up to the listen still runs and is asserted.

const LEFT_OUT = 'docs/implementation/evidence/';

/** Paths that must never be tracked, including local findings and reconciliation reports. */
export const NEVER_TRACKED = [
  /^node_modules\//,
  /^dist\//,
  /^\.harness-dist\//,
  /^\.pdlc\//,
  /^\.preview-data\//,
  /^\.crew-data\//,
  /^\.agent-productivity-data\//,
  /^test-results\//,
  /\.db(-shm|-wal)?$/,
  /^docs\/implementation\/experiments\/E\d[^/]*\.md$/,
  /^reconcile\.txt$/,
  /^diagnose\.txt$/,
  /^(claude|codex)-ccusage\.json$/,
];

export const trackedProblems = (files: string[]): string[] =>
  files
    .filter((file) => NEVER_TRACKED.some((pattern) => pattern.test(file)))
    .map((file) => `${file} is tracked, so a clean checkout would carry it`);

export const filesToCopy = (files: string[]): string[] =>
  files.filter((file) => !file.startsWith(LEFT_OUT));

/**
 * The files a clean checkout is made of. Git's own list is used when it has one. An export of the project (no .git, or a git that
 * lists nothing) has none, which used to copy nothing and fail the build; the folder is then walked instead, leaving out what git
 * ignores or never tracks. A list that does not even hold package.json is no list at all: null, and the real-checkout tests skip
 * with their reason rather than fail on an environment that cannot say what is tracked (M10_START).
 */
export const NOT_PART_OF_A_CHECKOUT = [
  /^\.git\//,
  /^playwright-report\//,
  /^coverage\//,
  /^\.pnpm-store\//,
  /^\.pnpm-cache\//,
  /(^|\/)\.DS_Store$/,
];

export function projectInventory(
  fromGit: string[] | null,
  walk: () => string[],
): { files: string[]; source: 'git' | 'folder' } | null {
  const usable = (files: string[] | null): files is string[] =>
    files !== null && files.includes('package.json');
  if (usable(fromGit)) return { files: fromGit, source: 'git' };
  const walked = walk();
  return usable(walked) ? { files: walked, source: 'folder' } : null;
}

/** Every file under the project folder that a checkout would carry, relative and sorted: no build output, packages or databases. */
export function walkProject(root: string): string[] {
  const found: string[] = [];
  const visit = (relative: string): void => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const asDirectory = `${path}/`;
      if (entry.isDirectory()) {
        if (
          NEVER_TRACKED.some((pattern) => pattern.test(asDirectory)) ||
          NOT_PART_OF_A_CHECKOUT.some((pattern) => pattern.test(asDirectory))
        )
          continue;
        visit(path);
      } else if (
        entry.isFile() &&
        !NEVER_TRACKED.some((pattern) => pattern.test(path)) &&
        !NOT_PART_OF_A_CHECKOUT.some((pattern) => pattern.test(path))
      ) {
        found.push(path);
      }
    }
  };
  visit('');
  return found.sort();
}

type Stop = 'refused' | 'failed';

/** Why the server stopped: a refused listen (a sandbox, a taken address) is not a failed boot; anything else is. */
export function classifyStop(output: string): Stop {
  return /listen (EPERM|EACCES|EADDRNOTAVAIL)/.test(output) ? 'refused' : 'failed';
}

export interface Served {
  bootstrap: { setupComplete?: unknown };
  index: { status: number; body: string };
  setup: { status: number; body: string };
  /** After Setup's own two calls (look, then Finish): what Finish answered, what bootstrap says now, and whether Overview's data is served. */
  finished?: { finish: number; bootstrap: { setupComplete?: unknown }; overview: number };
}

/**
 * What a first launch must show: setup not finished, and the built app answering at / and at /setup. When the Finish answer is given
 * (Setup's discovery, then Finish setup), completing Setup must work: Finish answers 202, bootstrap then says setup is done, and
 * Overview's data is served, which is what the browser's router needs to leave Setup for Overview.
 */
export function servingProblems({ bootstrap, index, setup, finished }: Served): string[] {
  const problems: string[] = [];
  if (bootstrap.setupComplete !== false)
    problems.push(
      `/api/bootstrap says setupComplete=${String(bootstrap.setupComplete)}, not false`,
    );
  for (const [name, page] of [
    ['/', index],
    ['/setup', setup],
  ] as const) {
    if (page.status !== 200) problems.push(`${name} answered ${page.status}, not 200`);
    if (!page.body.includes('<div id="root">'))
      problems.push(`${name} does not serve the built app`);
  }
  if (finished) {
    if (finished.finish !== 202) problems.push(`Finish setup answered ${finished.finish}, not 202`);
    if (finished.bootstrap.setupComplete !== true)
      problems.push(
        `after Finish, /api/bootstrap says setupComplete=${String(finished.bootstrap.setupComplete)}, not true`,
      );
    if (finished.overview !== 200)
      problems.push(`after Finish, /api/overview answered ${finished.overview}, not 200`);
  }
  return problems;
}

/** What a build must leave: the page and every script and style it points at. */
export function buildProblems(dir: string): string[] {
  const indexPath = join(dir, 'dist/client/index.html');
  if (!existsSync(indexPath)) return ['dist/client/index.html was not built'];
  const html = readFileSync(indexPath, 'utf8');
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]!);
  if (assets.length === 0) return ['the built page points at no script or style'];
  return assets
    .filter((asset) => !existsSync(join(dir, 'dist/client', asset)))
    .map((asset) => `the built page points at ${asset}, which was not built`);
}

function trackedFiles(): string[] | null {
  try {
    return execFileSync('git', ['ls-files', '-z'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\0')
      .filter(Boolean);
  } catch {
    return null;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

type Boot =
  | { kind: 'listening'; served: Served }
  | { kind: 'refused'; output: string }
  | { kind: 'failed'; output: string };

/** Starts the checkout's server and returns what it did: served the first screen, was refused a socket, or broke. */
async function boot(dir: string, env: Record<string, string>): Promise<Boot> {
  const child = spawn(process.execPath, ['src/server/main.ts'], {
    cwd: dir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

  const outcome = await Promise.race([
    (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const url = /is running at (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
        if (url) return url;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return null;
    })(),
    exited.then(() => 'exited' as const),
  ]);

  if (outcome === 'exited') {
    return { kind: classifyStop(output), output };
  }
  if (outcome === null) {
    child.kill('SIGKILL');
    return { kind: 'failed', output: `no "is running at" line in 30 s\n${output}` };
  }
  try {
    const page = async (path: string) => {
      const response = await fetch(`${outcome}${path}`);
      return { status: response.status, body: await response.text() };
    };
    const bootstrap = (await (
      await fetch(`${outcome}/api/bootstrap`)
    ).json()) as Served['bootstrap'];
    const served: Served = { bootstrap, index: await page('/'), setup: await page('/setup') };
    // Setup's own two calls, as the browser makes them (the write guard wants the request header and a JSON content type).
    const write = { 'x-agent-productivity-request': '1', 'content-type': 'application/json' };
    await fetch(`${outcome}/api/setup/discover`, { method: 'POST', headers: write });
    const finish = await fetch(`${outcome}/api/setup/complete`, { method: 'POST', headers: write });
    served.finished = {
      finish: finish.status,
      bootstrap: (await (await fetch(`${outcome}/api/bootstrap`)).json()) as Served['bootstrap'],
      overview: (await fetch(`${outcome}/api/overview`)).status,
    };
    return { kind: 'listening', served };
  } finally {
    child.kill('SIGINT');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    child.kill('SIGKILL');
  }
}

// `pnpm start` is src/server/main.ts: the live GitHub, ChatGPT and Claude ports, then boot, then a real listen. The start above runs
// all of that up to the listen. This second start keeps what a first screen depends on (the real boot over a fresh data folder, with
// this machine's own adapters, and the checkout's own build) and replaces the one step that needs a socket with a stand-in that
// keeps the server's request handler, so the three first-launch answers can be asked of it where no socket can be opened. It leaves
// out the live GitHub, ChatGPT and Claude ports on purpose: only main.ts and their own tests may import those
// (test/server/boot-github.test.ts holds that), and a first screen does not use them.
const PROBE = `
import { homedir } from 'node:os';
import { boot } from './src/server/boot.ts';
import { loadConfig } from './src/server/lib/config.ts';

const config = loadConfig();
let handle;
const server = await boot(config, {
  local: { env: process.env, home: homedir() },
  listen: async ({ fetch }) => {
    handle = fetch;
    return { close: (done) => done?.() };
  },
});
const ask = async (path) => {
  const host = '127.0.0.1:' + config.port;
  const response = await handle(new Request('http://' + host + path, { headers: { host } }));
  return { status: response.status, body: await response.text() };
};
const bootstrap = JSON.parse((await ask('/api/bootstrap')).body);
const answer = { mode: server.mode, bootstrap, index: await ask('/'), setup: await ask('/setup') };
// Setup's own two calls, as the browser makes them: look (nothing is imported), then Finish setup. The write guard wants the request
// header and a JSON content type. Then bootstrap says setup is done and Overview's data is served.
const write = { 'x-agent-productivity-request': '1', 'content-type': 'application/json' };
const post = async (path) => {
  const host = '127.0.0.1:' + config.port;
  const response = await handle(
    new Request('http://' + host + path, { method: 'POST', headers: { host, ...write } }),
  );
  return { status: response.status, body: await response.text() };
};
await post('/api/setup/discover');
const finish = await post('/api/setup/complete');
answer.finished = {
  finish: finish.status,
  bootstrap: JSON.parse((await ask('/api/bootstrap')).body),
  overview: (await ask('/api/overview')).status,
};
await server.shutdown();
console.log('PROBE ' + JSON.stringify(answer));
process.exit(0);
`;

const mode = (path: string): number => statSync(path).mode & 0o777;

/**
 * The checkout's own `pnpm build` (the script is `NODE_ENV=production vite build`). Where pnpm is not installed (a check host that
 * carries only Node and the linked packages), the same build is run through Node directly, so a missing package manager is not
 * read as a broken checkout. Any other failure of the build is the checkout's and is thrown.
 */
function buildCheckout(dir: string): void {
  try {
    execFileSync('pnpm', ['build'], { cwd: dir, stdio: 'pipe', timeout: 120_000 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    execFileSync(process.execPath, [join(dir, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
      cwd: dir,
      stdio: 'pipe',
      timeout: 120_000,
      env: { ...process.env, NODE_ENV: 'production' },
    });
  }
}

describe('a clean checkout starts on a first launch', () => {
  describe('the rules, proved on faults put in on purpose', () => {
    it('flags tracked build output, package folders, databases and local reports', () => {
      expect(trackedProblems(['package.json', 'src/server/main.ts'])).toEqual([]);
      expect(
        trackedProblems(['dist/client/index.html', 'package.json', 'data/agent-productivity.db']),
      ).toEqual([
        'dist/client/index.html is tracked, so a clean checkout would carry it',
        'data/agent-productivity.db is tracked, so a clean checkout would carry it',
      ]);
      expect(trackedProblems(['node_modules/x/index.js', '.pdlc/a.json'])).toHaveLength(2);
      expect(
        trackedProblems([
          'docs/implementation/experiments/README.md',
          'docs/implementation/experiments/E4.md',
          'reconcile.txt',
          'diagnose.txt',
          'claude-ccusage.json',
          'codex-ccusage.json',
        ]),
      ).toEqual([
        'docs/implementation/experiments/E4.md is tracked, so a clean checkout would carry it',
        'reconcile.txt is tracked, so a clean checkout would carry it',
        'diagnose.txt is tracked, so a clean checkout would carry it',
        'claude-ccusage.json is tracked, so a clean checkout would carry it',
        'codex-ccusage.json is tracked, so a clean checkout would carry it',
      ]);
    });

    it('leaves out only the screenshots', () => {
      const copied = filesToCopy([
        'package.json',
        'docs/implementation/evidence/m10/setup-found-product-1280.png',
        'docs/archive/implementation/execution-record.md',
      ]);
      expect(copied).toEqual(['package.json', 'docs/archive/implementation/execution-record.md']);
    });

    it('takes git’s list when it has one, and walks the folder when git lists nothing (an export with no tracked-file inventory)', () => {
      const walked = ['package.json', 'src/server/main.ts'];
      expect(projectInventory(['package.json', 'a.ts'], () => walked)).toEqual({
        files: ['package.json', 'a.ts'],
        source: 'git',
      });
      // The failure of M10_START: git answered with an empty list, so nothing was copied and the build had no package.json.
      expect(projectInventory([], () => walked)).toEqual({ files: walked, source: 'folder' });
      expect(projectInventory(null, () => walked)).toEqual({ files: walked, source: 'folder' });
      // A list without package.json is no list; and a folder without one is reported as nothing, so the tests skip with a reason.
      expect(projectInventory(['a.ts'], () => walked)?.source).toBe('folder');
      expect(projectInventory([], () => [])).toBeNull();
      expect(projectInventory(null, () => ['a.ts'])).toBeNull();
    });

    it('walks a project folder without build output, packages, databases or other ignored paths', () => {
      const root = mkdtempSync(join(tmpdir(), 'crew-walk-'));
      try {
        const put = (path: string): void => {
          mkdirSync(dirname(join(root, path)), { recursive: true });
          writeFileSync(join(root, path), '');
        };
        for (const path of [
          'package.json',
          'src/server/main.ts',
          '.prettierrc.json',
          'docs/a.md',
          'docs/implementation/experiments/E8.md',
          'docs/implementation/experiments/README.md',
          'node_modules/x/index.js',
          'dist/client/index.html',
          '.pdlc/outbox/a.json',
          '.git/HEAD',
          'test-results/r.json',
          'playwright-report/index.html',
          '.harness-dist/index.html',
          'data/agent-productivity.db',
          'reconcile.txt',
          'diagnose.txt',
          'claude-ccusage.json',
          'codex-ccusage.json',
          'src/.DS_Store',
        ])
          put(path);
        const files = walkProject(root);
        expect(files).toEqual([
          '.prettierrc.json',
          'docs/a.md',
          'docs/implementation/experiments/README.md',
          'package.json',
          'src/server/main.ts',
        ]);
        expect(trackedProblems(files)).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('calls a refused socket not-run and any other stop a failure', () => {
      expect(
        classifyStop('Could not start: listen EPERM: operation not permitted 127.0.0.1:45317'),
      ).toBe('refused');
      expect(classifyStop('Could not start: listen EACCES: permission denied 127.0.0.1:80')).toBe(
        'refused',
      );
      expect(classifyStop('Could not start: listen EADDRINUSE: address already in use')).toBe(
        'failed',
      );
      expect(classifyStop('SyntaxError: Unexpected token')).toBe('failed');
      expect(classifyStop('')).toBe('failed');
    });

    it('asks for setup not finished and the built app at / and at /setup', () => {
      const good: Served = {
        bootstrap: { setupComplete: false },
        index: { status: 200, body: '<div id="root"></div>' },
        setup: { status: 200, body: '<div id="root"></div>' },
      };
      expect(servingProblems(good)).toEqual([]);
      expect(servingProblems({ ...good, bootstrap: { setupComplete: true } })).toEqual([
        '/api/bootstrap says setupComplete=true, not false',
      ]);
      expect(servingProblems({ ...good, bootstrap: {} })).toEqual([
        '/api/bootstrap says setupComplete=undefined, not false',
      ]);
      expect(servingProblems({ ...good, setup: { status: 404, body: 'Not found' } })).toEqual([
        '/setup answered 404, not 200',
        '/setup does not serve the built app',
      ]);
      expect(servingProblems({ ...good, index: { status: 200, body: '<html></html>' } })).toEqual([
        '/ does not serve the built app',
      ]);
    });

    it('asks, when it can, that completing Setup works: Finish answers 202, bootstrap says done, Overview’s data is served', () => {
      const done: NonNullable<Served['finished']> = {
        finish: 202,
        bootstrap: { setupComplete: true },
        overview: 200,
      };
      const good: Served = {
        bootstrap: { setupComplete: false },
        index: { status: 200, body: '<div id="root"></div>' },
        setup: { status: 200, body: '<div id="root"></div>' },
        finished: done,
      };
      expect(servingProblems(good)).toEqual([]);
      expect(servingProblems({ ...good, finished: { ...done, finish: 500 } })).toEqual([
        'Finish setup answered 500, not 202',
      ]);
      expect(
        servingProblems({ ...good, finished: { ...done, bootstrap: { setupComplete: false } } }),
      ).toEqual(['after Finish, /api/bootstrap says setupComplete=false, not true']);
      expect(servingProblems({ ...good, finished: { ...done, overview: 500 } })).toEqual([
        'after Finish, /api/overview answered 500, not 200',
      ]);
      // Without the Finish answer nothing about completing is asked, so the earlier three-answer shape still passes.
      const { finished: ignored, ...without } = good;
      void ignored;
      expect(servingProblems(without)).toEqual([]);
    });

    it('asks for the built page and every file it points at', () => {
      const empty = mkdtempSync(join(tmpdir(), 'crew-build-'));
      try {
        expect(buildProblems(empty)).toEqual(['dist/client/index.html was not built']);
        mkdirSync(join(empty, 'dist/client/assets'), { recursive: true });
        const index = join(empty, 'dist/client/index.html');
        writeFileSync(index, '<html></html>');
        expect(buildProblems(empty)).toEqual(['the built page points at no script or style']);
        writeFileSync(index, '<script type="module" src="/assets/app.js"></script>');
        expect(buildProblems(empty)).toEqual([
          'the built page points at /assets/app.js, which was not built',
        ]);
        writeFileSync(join(empty, 'dist/client/assets/app.js'), '');
        expect(buildProblems(empty)).toEqual([]);
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    });
  });

  describe('the real checkout', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'crew-checkout-'));
    const dir = join(workspace, 'checkout');
    const home = join(workspace, 'home');
    const data = join(workspace, 'data');
    let tracked: string[] | null = null;
    let inventorySource: 'git' | 'folder' | null = null;
    let booted: Boot | null = null;
    let probed: (Served & { mode: string }) | null = null;

    beforeAll(async () => {
      const inventory = projectInventory(trackedFiles(), () => walkProject(ROOT));
      // A deleted working-tree file will be absent from the next commit.
      tracked = inventory?.files.filter((file) => existsSync(join(ROOT, file))) ?? null;
      inventorySource = inventory?.source ?? null;
      if (!tracked) return;
      mkdirSync(dir);
      mkdirSync(home);
      for (const file of filesToCopy(tracked)) {
        const from = join(ROOT, file);
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        copyFileSync(from, join(dir, file));
      }
      symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
      buildCheckout(dir);

      const port = await freePort().catch(() => 45_000 + Math.floor(Math.random() * 10_000));
      const env = {
        PATH: process.env['PATH'] ?? '',
        HOME: home,
        TMPDIR: process.env['TMPDIR'] ?? tmpdir(),
        AGENT_PRODUCTIVITY_PORT: String(port),
      };
      // First, with no socket: the handler answers a first launch. Its own fresh data folder, so the real start below finds none.
      writeFileSync(join(dir, 'verification-probe.ts'), PROBE);
      const printed = execFileSync(process.execPath, ['verification-probe.ts'], {
        cwd: dir,
        env: { ...env, AGENT_PRODUCTIVITY_DATA_DIR: join(workspace, 'probe-data') },
        encoding: 'utf8',
        timeout: 60_000,
      });
      probed = JSON.parse(/^PROBE (.*)$/m.exec(printed)![1]!) as Served & { mode: string };
      // Then for real: the process `pnpm start` runs, on a fresh data folder.
      booted = await boot(dir, { ...env, AGENT_PRODUCTIVITY_DATA_DIR: data });
    }, 180_000);

    afterAll(() => rmSync(workspace, { recursive: true, force: true }));

    it('is made of the project’s own files only (git’s list, or the folder’s where git lists none), with no build output, package folder or database', (ctx) => {
      if (!tracked)
        return ctx.skip('there is no list of tracked files and the folder holds no package.json');
      expect(inventorySource === 'git' || inventorySource === 'folder').toBe(true);
      expect(tracked.length).toBeGreaterThan(300);
      expect(trackedProblems(tracked)).toEqual([]);
      expect(existsSync(join(dir, 'package.json'))).toBe(true);
      expect(existsSync(join(dir, 'dist'))).toBe(true); // its own build, made here
      expect(tracked).toContain('src/server/main.ts');
    });

    it('builds on its own: pnpm build leaves the page and every file it points at', (ctx) => {
      if (!tracked) return ctx.skip('there is no project inventory to build a checkout from');
      expect(buildProblems(dir)).toEqual([]);
    });

    it('ships the self-hosted font and license texts for the standalone browser build', (ctx) => {
      if (!tracked) return ctx.skip('there is no project inventory to build a checkout from');
      const client = join(dir, 'dist/client');
      const assets = readdirSync(join(client, 'assets'));
      expect(assets).toContainEqual(expect.stringMatching(/^nunito-latin-wght-.*\.woff2$/));
      expect(readFileSync(join(client, 'licenses/Nunito-OFL.txt'))).toEqual(
        readFileSync(join(dir, 'src/client/theme/fonts/OFL.txt')),
      );
      expect(assets).toContainEqual(expect.stringMatching(/^playpen-sans-latin-wght-.*\.woff2$/));
      expect(readFileSync(join(client, 'licenses/Playpen-Sans-OFL.txt'))).toEqual(
        readFileSync(join(dir, 'src/client/theme/fonts/OFL-PlaypenSans.txt')),
      );

      const notices = readFileSync(join(client, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
      for (const source of ['astryx-0.7.9.txt', 'stylex-0.19.1.txt', 'vite-8.3.6.txt']) {
        expect(notices).toContain(
          readFileSync(join(dir, 'scripts/licenses', source), 'utf8').trimEnd(),
        );
      }
      expect(notices).toContain('Copyright (c) Tailwind Labs, Inc.');

      const namedPackages = new Set(
        [...notices.matchAll(/^## (.+)@\S+ \(/gm)].map((match) => match[1]),
      );
      for (const asset of assets.filter((file) => file.endsWith('.js.map'))) {
        const { sources } = JSON.parse(readFileSync(join(client, 'assets', asset), 'utf8')) as {
          sources: string[];
        };
        for (const source of sources) {
          if (!source.includes('/node_modules/')) continue;
          const parts = source.split('/node_modules/').at(-1)!.split('/');
          const name = parts.slice(0, parts[0]?.startsWith('@') ? 2 : 1).join('/');
          expect(namedPackages.has(name), `Missing notice for ${name}`).toBe(true);
        }
      }
    });

    it('starts on a fresh data folder: it is made private, and the database is made, before anything listens', (ctx) => {
      if (!booted) return ctx.skip('there is no project inventory to build a checkout from');
      if (booted.kind === 'failed')
        throw new Error(`the checkout did not start:\n${booted.output}`);
      expect(mode(data)).toBe(0o700);
      expect(mode(join(data, 'agent-productivity.db'))).toBe(0o600);
      expect(readFileSync(join(dir, 'package.json'), 'utf8')).toMatch(
        /"start": "node src\/server\/main\.ts"/,
      );
    });

    it('answers a first launch through its own request handler, with no socket: setup not finished, the built app at / and /setup', (ctx) => {
      if (!probed) return ctx.skip('there is no project inventory to build a checkout from');
      expect(probed.mode).toBe('normal');
      expect(servingProblems(probed)).toEqual([]);
    });

    it('serves Setup on a first launch over a real socket (NOT RUN where this machine refuses one)', (ctx) => {
      if (!booted) return ctx.skip('there is no project inventory to build a checkout from');
      if (booted.kind === 'failed')
        throw new Error(`the checkout did not start:\n${booted.output}`);
      if (booted.kind === 'refused') {
        console.warn(
          `clean checkout: the server was refused a local socket (${booted.output.trim()}), so serving over a real socket was NOT RUN; the build, the start up to the listen and the handler's own answers were checked`,
        );
        return ctx.skip('this machine refuses local sockets, so the checkout could not listen');
      }
      expect(servingProblems(booted.served)).toEqual([]);
    });
  });
});
