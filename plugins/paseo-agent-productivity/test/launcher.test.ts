import assert from 'node:assert/strict';
import test from 'node:test';
import { createLaunchRequests } from '../client/launch.ts';
import { dashboardSettings, isTailnetHttpsOrigin } from '../shared/dashboard.ts';

const workspaceId = 'workspace-running-dashboard';
const serverId = 'srv_mini';
const privateUrl = 'https://mini.example-tailnet.ts.net:8443';

test('the dashboard binding is stored on the Paseo host and defaults to unconfigured', () => {
  assert.equal(dashboardSettings.scope, 'host');
  assert.deepEqual(dashboardSettings.schema.parse({}), { workspaceId: '', privateUrl: '' });
  const old = { workspaceId, privateUrl };
  assert.deepEqual(dashboardSettings.migrate?.(old, 1), old);
  assert.deepEqual(dashboardSettings.schema.parse({ workspaceId }), {
    workspaceId,
    privateUrl: '',
  });
});

test('only Tailscale HTTPS origins are usable as browser targets', () => {
  for (const url of [privateUrl, 'https://mini.example-tailnet.ts.net/']) {
    assert.equal(isTailnetHttpsOrigin(url), true, url);
  }

  for (const url of [
    'http://mini.example-tailnet.ts.net',
    'http://127.0.0.1:4312',
    'https://localhost:4312',
    'https://100.90.12.1:8443',
    'https://mini.example-tailnet.ts.net.attacker.example',
    'https://mini.example-tailnet.ts.net@attacker.example',
    'https://user:password@mini.example-tailnet.ts.net',
    'https://mini.example-tailnet.ts.net:0',
    'https://mini.example-tailnet.ts.net:65536',
    'https://mini.example-tailnet.ts.net/?query',
    'https://mini.example-tailnet.ts.net/\n',
    'javascript:alert(1)',
  ]) {
    assert.equal(isTailnetHttpsOrigin(url), false, url);
  }
});

test('a sidebar request is usable exactly once and expires on a different host', () => {
  const requests = createLaunchRequests();
  const id = requests.issue(serverId);
  assert.equal(requests.take('unrelated-route', serverId), undefined);
  assert.deepEqual(requests.take(id, serverId), { id, hostId: serverId });
  assert.equal(requests.take(id, serverId), undefined);

  const nextId = requests.issue(serverId);
  assert.equal(requests.take(nextId, 'srv_other'), undefined);
  assert.equal(requests.take(nextId, serverId), undefined);
});

test('a newer sidebar click supersedes the pending route request', () => {
  const requests = createLaunchRequests();
  const previous = requests.issue(serverId);
  const current = requests.issue(serverId);
  assert.equal(requests.take(previous, serverId), undefined);
  assert.deepEqual(requests.take(current, serverId), { id: current, hostId: serverId });
});
