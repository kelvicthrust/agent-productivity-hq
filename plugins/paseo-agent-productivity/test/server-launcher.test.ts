import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LaunchError,
  runtimeInstallFailed,
  runtimeRequired,
  tailscaleUnavailable,
} from '../server/errors.ts';
import { createDashboardLauncher } from '../server/launcher.ts';
import type { OwnedProcess } from '../server/processes.ts';
import { checkRoutes, readTailnetHost } from '../server/tailscale.ts';
import type { PaseoRead } from '../shared/native.ts';

const dnsName = 'mini.example-tailnet.ts.net';
const authority = `${dnsName}:4317`;
const ownerLogin = 'owner@example.com';
const port = 4317;
const remotePort = 60512;
const url = `https://${authority}`;
const status = {
  BackendState: 'Running',
  Self: { DNSName: `${dnsName}.`, TailscaleIPs: ['100.90.0.2'], UserID: 42 },
  User: { 42: { LoginName: ownerLogin }, 68: { LoginName: 'other@example.com' } },
  CertDomains: [dnsName],
};

const route = {
  TCP: { 4317: { HTTPS: true } },
  Web: { [authority]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${remotePort}` } } } },
};

const check = { authority, legacyUrl: '', localPort: port };
const attached = { ...check, remotePort, ownSession: 'active' };
const bootstrap = { operation: 'bootstrap' } as const;
const readPaseo: PaseoRead = async ({ kind }) => ({ kind });
const conflict = (error: unknown) =>
  error instanceof LaunchError && error.reason === 'route-conflict';

test('takes the owner from Self.UserID of a connected untagged host with HTTPS enabled', () => {
  assert.deepEqual(readTailnetHost(status), { authority, ownerLogin, addresses: ['100.90.0.2'] });
  for (const bad of [
    { ...status, Self: { ...status.Self, DNSName: `${dnsName}/` } },
    { ...status, Self: { ...status.Self, UserID: 257 } },
    { ...status, Self: { ...status.Self, Tags: ['tag:server'] } },
    { ...status, BackendState: 'Stopped' },
    { ...status, CertDomains: [] },
  ]) {
    assert.throws(() => readTailnetHost(bad), LaunchError);
  }
});

test('rejects occupied HTTPS, Funnel, older shares, and alternate dashboard targets', () => {
  const legacyHost = `${dnsName}:8443`;
  const unrelated = {
    TCP: { 443: { HTTP: true } },
    Web: { [`${dnsName}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:51235' } } } },
  };
  assert.equal(checkRoutes(unrelated, check), undefined);
  for (const config of [
    route,
    { TCP: { 4317: { TCPForward: 'localhost:51973' } } },
    { TCP: { 10000: { TCPForward: 'localhost:4317' } } },
    { AllowFunnel: { [authority]: true } },
    { Web: { [legacyHost]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:63250' } } } } },
    { AllowFunnel: { [legacyHost]: true } },
    { TCP: { 8443: { TCPForward: 'localhost:63250' } } },
    {
      Web: {
        [`${dnsName}:443`]: {
          Handlers: { '/dash': { Proxy: 'https+insecure://localhost:4317/' } },
        },
      },
    },
    {
      Foreground: {
        other: {
          Web: {
            [`${dnsName}:80`]: { Handlers: { '/dash': { Proxy: 'http://[::1]:4317/dash' } } },
          },
        },
      },
    },
    { Services: { 'svc:private': { TCP: { 65: { TCPForward: '127.0.0.1:4317' } } } } },
  ]) {
    assert.throws(
      () => checkRoutes(config, { ...check, legacyUrl: `https://${legacyHost}` }),
      conflict,
    );
  }
  assert.throws(() => checkRoutes({ Web: [] }, check), LaunchError);
});

test('validates one foreground HTTPS root and its exact guarded target for reuse', () => {
  const own = { Foreground: { active: route } };
  assert.equal(checkRoutes(own, attached), 'active');
  assert.throws(() => checkRoutes(own, check), conflict);
  for (const replacement of [
    { Foreground: { other: route } },
    { Foreground: { active: { ...route, AllowFunnel: { [authority]: true } } } },
    { Foreground: { active: { ...route, TCP: { 4317: { HTTP: true } } } } },
    {
      Foreground: {
        active: {
          ...route,
          Web: {
            [authority]: {
              Handlers: { ...route.Web[authority]!.Handlers, '/other': { Text: 'alternate' } },
            },
          },
        },
      },
    },
    { ...own, TCP: { 8443: { TCPForward: `127.0.0.1:${remotePort}` } } },
  ]) {
    assert.throws(() => checkRoutes(replacement, attached), conflict);
  }
});

function ownedProcess(cleanup: () => void) {
  let alive = true;
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    closed,
    alive: () => alive,
    async stop() {
      if (!alive) return;
      alive = false;
      cleanup();
      finish();
    },
  } satisfies OwnedProcess;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function testLauncher(
  runtimePresent = true,
  installRuntime?: (signal: AbortSignal) => Promise<void>,
) {
  const inputs = async () => ({ directory: '/plugin', legacyUrl: '' });
  let serveConfig: unknown = {};
  let spawnFailure = false;
  let app: OwnedProcess | undefined;
  let share: OwnedProcess | undefined;
  let serviceStarts = 0;
  let serveStarts = 0;
  let tailscaleChecks = 0;
  let installs = 0;
  let tickets = 0;
  const cleanup: string[] = [];
  const launcher = createDashboardLauncher({
    runtimePaths: async (_directory, signal, install) => {
      if (!runtimePresent) {
        if (!install) throw runtimeRequired();
        installs++;
        if (installRuntime && signal) await installRuntime(signal);
        runtimePresent = true;
      }
      return {
        directory: '/plugin',
        version: '1.2.3',
        node: '/node',
        entry: '/dashboard',
        serveSession: '/serve-session.mjs',
      };
    },
    findTailscale: () => {
      tailscaleChecks++;
      return '/tailscale';
    },
    readTailscaleJson: async (_binary, [command]) => (command === 'status' ? status : serveConfig),
    requireFreeTailnetPort: async () => {},
    localPort: () => port,
    startDashboard: async (_runtime, localPort, _signal, reader) => {
      assert.equal(localPort, port);
      serviceStarts++;
      app = ownedProcess(() => cleanup.push('dashboard'));
      return {
        ...app,
        port,
        async attachRemote(host) {
          assert.equal(host.ownerLogin, ownerLogin);
          return remotePort;
        },
        async detachRemote() {
          cleanup.push('listener');
        },
        async issueBrowserTicket() {
          assert.equal(share?.alive(), true);
          assert.deepEqual(serveConfig, { Foreground: { active: route } });
          tickets++;
          return { ticket: String(tickets).padStart(43, 'A'), expiresAt: 2_000_000_000_000 };
        },
        async native({ operation }) {
          return { ok: true, data: { operation, paseo: await reader!({ kind: 'usage' }) } };
        },
      };
    },
    startServe: async (_runtime, _binary, host, target) => {
      assert.equal(host, authority);
      assert.equal(target, remotePort);
      serveStarts++;
      if (spawnFailure) throw tailscaleUnavailable();
      serveConfig = { Foreground: { active: route } };
      share = ownedProcess(() => {
        cleanup.push('serve');
        serveConfig = {};
      });
      return share;
    },
  });
  return {
    inputs,
    launcher,
    cleanup,
    configure: (next: unknown) => {
      serveConfig = next;
    },
    failServe: () => {
      spawnFailure = true;
    },
    stopDashboard: () => app?.stop(),
    stopShare: () => share?.stop(),
    counts: () => [serviceStarts, serveStarts],
    tailscaleChecks: () => tailscaleChecks,
    installs: () => installs,
    tickets: () => tickets,
  };
}

test('a concurrent normal launch cannot suppress an explicit install and install requests share one launch', async (t) => {
  const install = deferred();
  const { launcher, inputs, counts, installs, tickets } = testLauncher(
    false,
    () => install.promise,
  );
  t.after(() => install.resolve());
  t.after(() => launcher.stop());
  assert.deepEqual(launcher.runtimeInstallStatus(), { state: 'idle' });
  assert.equal(installs(), 0);
  const normal = launcher.launch(inputs);
  assert.deepEqual(launcher.startRuntimeInstall(inputs), { state: 'installing' });
  assert.deepEqual(launcher.startRuntimeInstall(inputs), { state: 'installing' });
  const unavailable = await normal;
  assert.equal(unavailable.ok ? undefined : unavailable.reason, 'runtime-required');
  const pending = await launcher.launch(inputs);
  assert.equal(pending.ok ? undefined : pending.reason, 'runtime-installing');
  assert.deepEqual(launcher.runtimeInstallStatus(), { state: 'installing' });
  assert.deepEqual(counts(), [0, 0]);
  install.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(launcher.runtimeInstallStatus(), {
    state: 'finished',
    result: { ok: true, url },
  });
  assert.equal(installs(), 1);
  assert.deepEqual(counts(), [1, 1]);
  assert.equal(tickets(), 0);
  assert.equal((await launcher.browserHandoff(inputs)).ok, true);
  assert.equal(tickets(), 1);
});

test('issues one distinct browser ticket per handoff after the private route is ready', async (t) => {
  const { launcher, inputs, counts, tickets, configure } = testLauncher();
  t.after(() => launcher.stop());
  configure(route);
  const conflict = await launcher.browserHandoff(inputs);
  assert.equal(!conflict.ok && conflict.reason, 'route-conflict');
  assert.equal(tickets(), 0);
  configure({});
  assert.deepEqual(await launcher.launch(inputs), { ok: true, url });
  assert.equal(tickets(), 0);
  const results = await Promise.all([
    launcher.browserHandoff(inputs),
    launcher.browserHandoff(inputs),
  ]);
  assert.deepEqual(
    results.map((result) => result.ok && result.url),
    [url, url],
  );
  assert.deepEqual(
    results.map((result) => result.ok && result.ticket),
    ['1'.padStart(43, 'A'), '2'.padStart(43, 'A')],
  );
  assert.equal(tickets(), 2);
  assert.deepEqual(counts(), [1, 1]);
});

test('stopping the launcher aborts and awaits an acknowledged runtime install', async () => {
  const installing = deferred();
  const { launcher, inputs, counts } = testLauncher(
    false,
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(runtimeInstallFailed()), { once: true });
        installing.resolve();
      }),
  );
  assert.deepEqual(launcher.startRuntimeInstall(inputs), { state: 'installing' });
  await installing.promise;
  await launcher.stop();
  const status = launcher.runtimeInstallStatus();
  assert.equal(status.state, 'finished');
  assert.equal(!status.result.ok && status.result.reason, 'runtime-install-failed');
  assert.deepEqual(counts(), [0, 0]);
});

test('concurrent calls share one startup and the next click reuses the tracked healthy launch', async (t) => {
  const { launcher, inputs, counts, cleanup } = testLauncher();
  t.after(() => launcher.stop());
  const first = launcher.launch(inputs);
  assert.equal(launcher.launch(inputs), first);
  assert.deepEqual(await first, { ok: true, url });
  assert.deepEqual(await launcher.launch(inputs), { ok: true, url });
  assert.deepEqual(counts(), [1, 1]);
  await launcher.stop();
  assert.deepEqual(cleanup, ['serve', 'listener', 'dashboard']);
});

test('does not start either process behind an old Ports share, and releases a failed route listener', async (t) => {
  const { launcher, inputs, counts, cleanup, configure, failServe } = testLauncher();
  t.after(() => launcher.stop());
  configure(route);
  const conflict = await launcher.launch(inputs);
  assert.equal(conflict.ok ? undefined : conflict.reason, 'route-conflict');
  assert.deepEqual(counts(), [0, 0]);
  configure({});
  failServe();
  const failure = await launcher.launch(inputs);
  assert.equal(failure.ok ? undefined : failure.reason, 'tailscale-unavailable');
  assert.deepEqual(cleanup, ['listener']);
  assert.deepEqual(counts(), [1, 1]);
});

test('losing the live dashboard ends its owned Serve session and permits a fresh handshake', async (t) => {
  const { launcher, inputs, counts, cleanup, stopDashboard } = testLauncher();
  t.after(() => launcher.stop());
  assert.deepEqual(await launcher.launch(inputs), { ok: true, url });
  await stopDashboard();
  assert.deepEqual(await launcher.launch(inputs), { ok: true, url });
  assert.deepEqual(counts(), [2, 2]);
  assert.deepEqual(cleanup, ['dashboard', 'serve']);
});

test('native starts one reusable child without Tailscale and survives loss of the browser share', async (t) => {
  const { launcher, inputs, counts, tailscaleChecks, cleanup, stopShare } = testLauncher();
  t.after(() => launcher.stop());
  const ready = { ok: true, data: { operation: 'bootstrap', paseo: { kind: 'usage' } } };
  assert.deepEqual(
    await Promise.all([
      launcher.native(inputs, bootstrap, readPaseo),
      launcher.native(inputs, bootstrap, readPaseo),
    ]),
    [ready, ready],
  );
  assert.deepEqual(counts(), [1, 0]);
  assert.equal(tailscaleChecks(), 0);
  assert.deepEqual(await launcher.launch(inputs, readPaseo), { ok: true, url });
  await stopShare();
  assert.deepEqual(await launcher.native(inputs, bootstrap, readPaseo), ready);
  assert.deepEqual(cleanup, ['serve', 'listener']);
  assert.deepEqual(await launcher.launch(inputs, readPaseo), { ok: true, url });
  assert.deepEqual(counts(), [1, 2]);
});

test('a refused browser route leaves native data available', async (t) => {
  const { launcher, inputs, counts, configure, failServe } = testLauncher();
  t.after(() => launcher.stop());
  const before = await launcher.native(inputs, bootstrap, readPaseo);
  assert.equal(before.ok, true);
  configure(route);
  const conflict = await launcher.launch(inputs, readPaseo);
  assert.equal(!conflict.ok && conflict.reason, 'route-conflict');
  assert.deepEqual(await launcher.native(inputs, bootstrap, readPaseo), before);
  configure({});
  failServe();
  const failed = await launcher.launch(inputs, readPaseo);
  assert.equal(!failed.ok && failed.reason, 'tailscale-unavailable');
  assert.deepEqual(await launcher.native(inputs, bootstrap, readPaseo), before);
  assert.deepEqual(counts(), [1, 1]);
});

test('an explicit native runtime install never checks Tailscale', async (t) => {
  const holdInstall = deferred();
  const { launcher, inputs, installs, counts, tailscaleChecks } = testLauncher(
    false,
    () => holdInstall.promise,
  );
  t.after(() => holdInstall.resolve());
  t.after(() => launcher.stop());
  assert.deepEqual(launcher.nativeRuntimeInstallStatus(), { state: 'idle' });
  const missing = await launcher.native(inputs, bootstrap, readPaseo);
  assert.equal(!missing.ok && missing.reason, 'runtime-required');
  assert.deepEqual(launcher.startNativeRuntimeInstall(inputs, readPaseo), { state: 'installing' });
  assert.deepEqual(launcher.startNativeRuntimeInstall(inputs, readPaseo), { state: 'installing' });
  const installing = await launcher.native(inputs, bootstrap, readPaseo);
  assert.equal(!installing.ok && installing.reason, 'runtime-installing');
  holdInstall.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(launcher.nativeRuntimeInstallStatus(), {
    state: 'finished',
    result: { ok: true },
  });
  assert.deepEqual(launcher.runtimeInstallStatus(), { state: 'idle' });
  assert.equal(installs(), 1);
  assert.equal(tailscaleChecks(), 0);
  assert.deepEqual(counts(), [1, 0]);
});
