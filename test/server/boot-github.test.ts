import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { preProcessFile } from 'typescript';
import { describe, expect, it } from 'vitest';
import { BOOT_STEPS, boot } from '../../src/server/boot.ts';
import { trackRepo } from '../../src/server/db/queries/repos.ts';
import { ErrorEnvelope } from '../../src/shared/contracts/errors.ts';
import { RefreshRun, SourcesResponse } from '../../src/shared/contracts/sources.ts';
import { scriptedAdapter, succeeds } from '../fixtures/scripted-adapters/scripted.ts';
import { NOW, TZ, memoryLogger, tempConfig, tempDir } from './helpers.ts';
import { scriptedGithub, startWithGithub } from './github-boot.ts';

// The GitHub half of boot (G6_3, G6_4, G6_5): given the three ports, the process builds the account service and the sync, adds
// the sync to the run as stage 3 and hands the routes what they need; not given, GitHub is "not available in this session". The
// boot order itself does not change. Only the standalone and Paseo-managed servers use the live ports.

const ROOT = join(import.meta.dirname, '../..');
const stepsOf = (entries: Record<string, unknown>[]) =>
  entries
    .filter((e) => e['source'] === 'boot' && typeof e['step'] === 'string')
    .map((e) => e['step']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'dist') return [];
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

describe('boot with the GitHub ports', () => {
  it('discovers and tracks a repository during Setup without importing PRs until Finish', async () => {
    const s = await startWithGithub({ boot: { local: { env: {}, home: tempDir() } } });
    try {
      const account = { login: 'octo-kelvin', via: 'gh' };
      const page = await s.send('GET', '/api/repos/discover?login=octo-kelvin&via=gh');
      expect(page.json).toMatchObject({
        repositories: [{ nodeId: 'R_atlasapi0001', trackingState: 'untracked' }],
      });
      const added = await s.send('POST', '/api/repos', {
        input: 'kelvin/atlas-api',
        githubAccount: account,
        repositoryNodeId: 'R_atlasapi0001',
      });
      expect(added.status).toBe(201);
      expect(s.db().prepare('SELECT COUNT(*) AS n FROM refresh_run').get()).toEqual({ n: 0 });
      expect(s.github.requests.some((request) => request.path === '/graphql')).toBe(false);

      expect((await s.send('POST', '/api/setup/complete')).status).toBe(202);
      await s.untilBackfilled('kelvin/atlas-api');
      expect(s.db().prepare('SELECT COUNT(*) AS n FROM pull_request').get()).toEqual({ n: 3 });
    } finally {
      await s.stop();
    }
  });

  it('keeps the boot order: migrate, mark interrupted runs, retention, scheduler, listen', async () => {
    const s = await startWithGithub({ boot: { scheduler: true } });
    expect(stepsOf(s.entries)).toEqual([...BOOT_STEPS]);
    await s.stop();
  });

  it('adds the GitHub sync as stage 3: after Codex, Claude and Paseo, and before nothing else it needs', async () => {
    const clock = { now: NOW };
    const scripted = scriptedGithub(clock);
    const seenBy: Record<string, number> = {};
    const stage = (id: 'codex' | 'claude' | 'paseo') =>
      scriptedAdapter(id, [
        () => {
          // how many requests GitHub had already had when this source ran
          seenBy[id] = scripted.github.requests.length;
          return succeeds({ imported: 0 });
        },
      ]);
    const s = await startWithGithub({
      clock,
      scripted,
      boot: { adapters: [stage('codex'), stage('claude'), stage('paseo')] },
    });
    // a repo that is already tracked (as after an earlier add)
    trackRepo(s.db(), {
      id: 'kelvin/atlas-api',
      nodeId: 'R_atlasapi0001',
      displayName: 'Kelvin/Atlas-API',
      now: clock.now,
    });

    const run = await s.send('POST', '/api/refresh', {});
    expect(run.status).toBe(202);
    const id = RefreshRun.parse(run.json).id;
    let ended = RefreshRun.parse(run.json);
    for (let i = 0; i < 400 && ended.state === 'running'; i += 1) {
      await new Promise((done) => setTimeout(done, 5));
      ended = RefreshRun.parse((await s.send('GET', `/api/refresh/${id}`)).json);
    }
    expect(ended.state).toBe('succeeded');
    expect(seenBy).toEqual({ codex: 0, claude: 0, paseo: 0 });
    expect(ended.sources?.['github']).toMatchObject({ state: 'succeeded', imported: 3 });
    expect(scripted.github.requests.length).toBeGreaterThan(0);

    // GitHub reports through the same source row as the others
    const sources = SourcesResponse.parse((await s.send('GET', '/api/sources')).json);
    expect(sources.sources?.find((source) => source.id === 'github')).toMatchObject({
      id: 'github',
      status: 'ok',
    });
    await s.stop();
  });

  it('skips the GitHub sync when nothing is tracked or nobody is connected, and records no failure', async () => {
    const none = await startWithGithub();
    const ran = await none.refreshGithub();
    expect(ran.sources?.['github']?.state).toBe('skipped');
    expect(none.github.requests).toEqual([]);
    await none.stop();

    const signedOut = await startWithGithub({ ghSignedIn: false });
    trackRepo(signedOut.db(), {
      id: 'kelvin/atlas-api',
      nodeId: null,
      displayName: 'Kelvin/Atlas-API',
      now: NOW,
    });
    const skipped = await signedOut.refreshGithub();
    expect(skipped.sources?.['github']?.state).toBe('skipped');
    expect(signedOut.db().prepare('SELECT COUNT(*) AS n FROM source_state').get()).toEqual({
      n: 0,
    });
    await signedOut.stop();
  });

  it('starts the 15-minute timer when GitHub is the only source (it has something to refresh)', async () => {
    const withGithub = await startWithGithub({ boot: { scheduler: true } });
    const timer = (entries: Record<string, unknown>[]) =>
      entries.find((e) => e['step'] === 'scheduler');
    expect(timer(withGithub.entries)).toMatchObject({ started: true });
    await withGithub.stop();
  });
});

describe('boot without the GitHub ports', () => {
  it('has no account card, no GitHub sync, and says GitHub is not available when asked to add a repo', async () => {
    const { logger } = memoryLogger();
    const server = await boot(tempConfig(), {
      logger,
      listen: async () => ({ close: (done) => done?.() }),
      now: () => NOW,
      timezone: TZ,
      scheduler: false,
    });
    const host = { host: '127.0.0.1:4317' };
    const write = {
      ...host,
      'x-agent-productivity-request': '1',
      'content-type': 'application/json',
    };
    const sources = (await (
      await server.app.request('http://127.0.0.1:4317/api/sources', { headers: host })
    ).json()) as Record<string, unknown>;
    expect(Object.keys(sources)).not.toContain('accounts');
    const add = await server.app.request('http://127.0.0.1:4317/api/repos', {
      method: 'POST',
      headers: write,
      body: JSON.stringify({ input: 'kelvin/atlas-api' }),
    });
    expect(add.status).toBe(422);
    expect(ErrorEnvelope.parse(await add.json()).error.code).toBe('github_not_connected');
    await server.shutdown();
  });
});

describe('the live ports belong to the standalone and Paseo-managed entry points', () => {
  const imports = ['src', 'scripts', 'test']
    .flatMap((directory) => sourceFiles(join(ROOT, directory)))
    .filter((path) => /\.(ts|tsx)$/.test(path))
    .map((path) => ({
      source: relative(ROOT, path),
      targets: preProcessFile(readFileSync(path, 'utf8'), true, true)
        .importedFiles.map(({ fileName }) => fileName)
        .filter((specifier) => specifier.startsWith('.'))
        .map((specifier) => resolve(dirname(path), specifier).replace(/\.[jt]sx?$/, '')),
    }));

  const importers = (module: string) =>
    imports
      .filter(({ targets }) => targets.includes(resolve(ROOT, module)))
      .map(({ source }) => source)
      .sort();

  it('imports the live adapters only from shared production wiring and each adapter’s test', () => {
    expect(importers('src/server/collectors/github/live')).toEqual([
      'src/server/live.ts',
      'test/collectors/github/live.test.ts',
    ]);
    expect(importers('src/server/collectors/chatgpt/live')).toEqual([
      'src/server/live.ts',
      'test/collectors/chatgpt/live.test.ts',
    ]);
  });

  it('keeps the shared production wiring reachable only from the two entry points', () => {
    expect(importers('src/server/live')).toEqual(['src/server/main.ts', 'src/server/managed.ts']);
    expect(importers('src/server/main')).toEqual([]);
    expect(importers('src/server/managed')).toEqual([]);
  });

  it('supplies GitHub and ChatGPT through the shared production dependencies', () => {
    const live = readFileSync(join(ROOT, 'src/server/live.ts'), 'utf8');
    expect(live).toMatch(/github:\s*createLiveGithub\(\)/);
    expect(live).toMatch(/chatgpt:\s*\{\s*launch:\s*createLiveLauncher\(\)/);
  });

  it('keeps Keychain access in the two provider ports and starts `gh` only in its port', () => {
    const files = sourceFiles(join(ROOT, 'src'))
      .filter((path) => /\.(ts|tsx)$/.test(path))
      .map((path) => [relative(ROOT, path), readFileSync(path, 'utf8')] as const);
    expect(files.filter(([, text]) => text.includes('@napi-rs/keyring')).map(([p]) => p)).toEqual([
      'src/server/collectors/github/live.ts',
      'src/server/integrations/claudePlan/credentials.ts',
    ]);
    expect(
      files.filter(([, text]) => /from 'node:child_process'/.test(text)).map(([p]) => p),
    ).toEqual([
      'src/server/collectors/chatgpt/live.ts',
      'src/server/collectors/github/live.ts',
      'src/server/http/owner-browser.ts',
    ]);
  });

  it('starts `codex` only in the ChatGPT live launcher', () => {
    const files = sourceFiles(join(ROOT, 'src'))
      .filter((path) => /\.(ts|tsx)$/.test(path))
      .map((path) => [relative(ROOT, path), readFileSync(path, 'utf8')] as const);
    expect(files.filter(([, text]) => /\bspawn\(/.test(text)).map(([p]) => p)).toEqual([
      'src/server/collectors/chatgpt/live.ts',
    ]);
  });
});
