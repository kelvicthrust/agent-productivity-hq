import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findApp } from '../../src/server/integrations/claudeHooks/assets/claude-hook.mjs';
import {
  nodeIsUsable,
  registryAsScriptReadsIt,
} from '../../src/server/integrations/claudeHooks/deliver.ts';
import { USER_SETTINGS, asText, read, rig, type Rig } from './helpers.ts';

// The rule (data-and-sources › Claude Code hooks › The state): "on" means deliverable, decided by ONE function that applies the very
// rules the installed script applies. The same fixtures are given to the script's own check (`findApp`) and to the server's, and the
// verdicts must be identical; then the status is asked, and it must say "on" exactly when the script would deliver.

const TOKEN = 'T'.repeat(43);
const original = asText(USER_SETTINGS);
const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid;

const registry = (over: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ v: 1, pid: process.pid, port: 4317, token: TOKEN, ...over })}\n`;
const padded = (bytes: number): string => {
  const text = registry();
  return `${text.trimEnd()}${' '.repeat(bytes - text.trimEnd().length - 1)}\n`;
};

interface Fixture {
  name: string;
  make: (path: string, dir: string) => void;
}
const file =
  (text: string | Buffer, mode = 0o600) =>
  (path: string): void => {
    writeFileSync(path, text, { mode });
    chmodSync(path, mode);
  };

const FIXTURES: Fixture[] = [
  { name: 'this process, as HQ writes it', make: file(registry()) },
  { name: 'extra keys', make: file(registry({ extra: 1 })) },
  { name: 'read-only for its owner (0400)', make: file(registry(), 0o400) },
  ...[0o640, 0o644, 0o604, 0o620, 0o602, 0o660, 0o666, 0o601].map((mode) => ({
    name: `mode ${mode.toString(8)}`,
    make: file(registry(), mode),
  })),
  { name: 'exactly 4096 bytes', make: file(padded(4096)) },
  { name: '4097 bytes', make: file(padded(4097)) },
  {
    name: 'a symbolic link to a good registry',
    make: (path, dir) => {
      writeFileSync(join(dir, 'real.json'), registry(), { mode: 0o600 });
      symlinkSync(join(dir, 'real.json'), path);
    },
  },
  { name: 'a folder', make: (path) => mkdirSync(path) },
  { name: 'a named pipe', make: (path) => execFileSync('mkfifo', [path]) },
  { name: 'not JSON', make: file('port=4317') },
  { name: 'empty', make: file('') },
  { name: 'a byte-order mark', make: file(`${String.fromCharCode(0xfeff)}${registry()}`) },
  {
    name: 'invalid UTF-8',
    make: file(
      Buffer.concat([
        Buffer.from(registry().slice(0, 4)),
        Buffer.from([0xff, 0xfe]),
        Buffer.from(registry().slice(4)),
      ]),
    ),
  },
  { name: 'an array', make: file('[1,2]') },
  { name: 'null', make: file('null') },
  { name: 'version 2', make: file(registry({ v: 2 })) },
  {
    name: 'no version',
    make: file(JSON.stringify({ pid: process.pid, port: 4317, token: TOKEN })),
  },
  { name: 'a process that is gone', make: file(registry({ pid: deadPid() })) },
  ...[0, -1, 1.5, '1', null].map((pid) => ({
    name: `pid ${JSON.stringify(pid)}`,
    make: file(registry({ pid })),
  })),
  ...[0, 65_536, 1.5, '4317', -1].map((port) => ({
    name: `port ${JSON.stringify(port)}`,
    make: file(registry({ port })),
  })),
  { name: 'port 1', make: file(registry({ port: 1 })) },
  { name: 'port 65535', make: file(registry({ port: 65_535 })) },
  ...[
    ['19 characters', 'a'.repeat(19)],
    ['20 characters', 'a'.repeat(20)],
    ['200 characters', 'a'.repeat(200)],
    ['201 characters', 'a'.repeat(201)],
    ['a character outside the alphabet', `${'a'.repeat(30)}+`],
    ['not a string', 12_345],
    ['empty (neutralised)', ''],
  ].map(([name, token]) => ({ name: `token ${name}`, make: file(registry({ token })) })),
];

describe('the script and the server give every registry the same verdict', () => {
  for (const fixture of FIXTURES) {
    it(fixture.name, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'parity-'));
      try {
        fixture.make(join(dir, 'registry.json'), dir);
        const script = await findApp(dir);
        const server = registryAsScriptReadsIt(dir);
        expect(server === null ? null : { port: server.port, token: server.token }).toEqual(script);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('a registry that is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parity-'));
    expect(await findApp(dir)).toBeNull();
    expect(registryAsScriptReadsIt(dir)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

/** An enabled switch whose server listens, with the registry replaced by the fixture. */
async function installedWith(make: (path: string, dir: string) => void): Promise<Rig> {
  const r = rig({ settings: original });
  await r.hooks.listening({ port: 4317, token: TOKEN });
  await r.hooks.set(true);
  rmSync(r.hooks.paths.registry, { force: true });
  make(r.hooks.paths.registry, r.hooks.paths.dir);
  return r;
}

describe('the status says "on" exactly when the installed script would deliver', () => {
  for (const fixture of FIXTURES) {
    it(fixture.name, async () => {
      const r = await installedWith(fixture.make);
      const script = await findApp(r.hooks.paths.dir);
      const seen = registryAsScriptReadsIt(r.hooks.paths.dir);
      const ours =
        script !== null &&
        seen?.pid === process.pid &&
        script.port === 4317 &&
        script.token === TOKEN;
      const status = await r.hooks.status();
      expect(status.state === 'on', `${fixture.name}: ${status.state} ${status.reason}`).toBe(ours);
      if (!ours) {
        expect(status).toMatchObject({ state: 'needs_repair', reason: 'registry_unpublished' });
        // and repair fixes it (a folder or a pipe where the file goes is replaced by the rename, never written through)
        const plan = status.plans.repair!;
        expect(plan.ownFiles).toContain('registry');
        if (fixture.name === 'a folder') {
          // A folder is not HQ's to replace: repair says so (nothing changes) instead of claiming it fixed anything.
          await expect(r.hooks.set(true, { preview: plan.preview })).rejects.toMatchObject({
            failure: 'registry_failed',
          });
          expect(lstatSync(r.hooks.paths.registry).isDirectory()).toBe(true);
          return;
        }
        const fixed = await r.hooks.set(true, { preview: plan.preview });
        expect(fixed.state, `${fixture.name} after repair`).toBe('on');
        expect(await findApp(r.hooks.paths.dir)).toEqual({ port: 4317, token: TOKEN });
      }
    });
  }
});

describe('the script file and the Node the command names', () => {
  it('a script others can write, or its owner cannot read, is not deliverable, and repair fixes it', async () => {
    for (const mode of [0o666, 0o664, 0o646, 0o000, 0o200]) {
      const r = await installedWith(file(registry()));
      chmodSync(r.hooks.paths.script, mode);
      const status = await r.hooks.status();
      expect(status, mode.toString(8)).toMatchObject({
        state: 'needs_repair',
        reason: 'script_missing',
      });
      await r.hooks.set(true, { preview: status.plans.repair!.preview });
      expect((await r.hooks.status()).state, mode.toString(8)).toBe('on');
    }
  });

  it('a script that is not a regular file is not deliverable', async () => {
    const r = await installedWith(file(registry()));
    rmSync(r.hooks.paths.script);
    symlinkSync(join(r.root, 'elsewhere.mjs'), r.hooks.paths.script);
    expect(await r.hooks.status()).toMatchObject({
      state: 'needs_repair',
      reason: 'script_missing',
    });
  });

  it('a mode with exec bits (0755, 0700) is fine: the command reads the script, and only its owner can change it', async () => {
    const r = await installedWith(file(registry()));
    chmodSync(r.hooks.paths.script, 0o700);
    expect((await r.hooks.status()).state).toBe('on');
  });

  it('a Node that cannot run is needs_repair (node_missing), and only turning off is offered', async () => {
    const r = await installedWith(file(registry()));
    const broken = r.another({ nodeUsable: () => false });
    await broken.listening({ port: 4317, token: TOKEN });
    const status = await broken.status();
    expect(status).toMatchObject({ state: 'needs_repair', reason: 'node_missing' });
    expect(Object.keys(status.plans)).toEqual(['off']);
    await broken.close();
  });

  it('the check itself: a regular, executable file is usable; a missing path, a folder and a file that cannot be run are not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'node-'));
    try {
      writeFileSync(join(dir, 'runs'), '#!/bin/sh\n', { mode: 0o755 });
      writeFileSync(join(dir, 'does not run'), '#!/bin/sh\n', { mode: 0o644 });
      mkdirSync(join(dir, 'folder'), { mode: 0o755 });
      symlinkSync(join(dir, 'runs'), join(dir, 'link'));
      expect(nodeIsUsable(process.execPath)).toBe(true);
      expect(nodeIsUsable(join(dir, 'runs'))).toBe(true);
      expect(nodeIsUsable(join(dir, 'link'))).toBe(true);
      expect(nodeIsUsable(join(dir, 'does not run'))).toBe(false);
      expect(nodeIsUsable(join(dir, 'folder'))).toBe(false);
      expect(nodeIsUsable(join(dir, 'nowhere'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a real Node on this machine makes the status on (no stand-in)', async () => {
    const r = rig({ settings: original, extra: { nodePath: process.execPath } });
    const real = r.another({ nodePath: process.execPath, nodeUsable: undefined });
    await real.set(true);
    expect(await real.status()).toMatchObject({ state: 'on' });
    expect(read(r.settings)).toContain(process.execPath);
  });
});
