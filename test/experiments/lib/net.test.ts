import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createNet,
  HostNotAllowedError,
  NetFixtureMissError,
} from '../../../scripts/experiments/lib/net.ts';
import { cleanupTmp, makeTmp } from '../harness.ts';

afterAll(cleanupTmp);

function net(requests: unknown[], hosts = ['api.example.test']) {
  const path = join(makeTmp(), 'net.json');
  writeFileSync(path, JSON.stringify({ requests }));
  const announced: string[] = [];
  return {
    net: createNet({ hosts, fixturePath: path, announce: (l) => announced.push(l) }),
    announced,
  };
}

describe('network guard', () => {
  it('refuses a host that is not listed, plain http, and a lookalike, before any connection is attempted', async () => {
    const { net: n, announced } = net([]);
    await expect(n.fetch('https://evil.example/x')).rejects.toBeInstanceOf(HostNotAllowedError);
    await expect(n.fetch('https://api.example.test.evil.example/x')).rejects.toBeInstanceOf(
      HostNotAllowedError,
    );
    await expect(n.fetch('http://api.example.test/x')).rejects.toBeInstanceOf(HostNotAllowedError);
    await expect(n.fetch('https://api.example.test:8443/x')).rejects.toBeInstanceOf(
      HostNotAllowedError,
    );
    expect(n.contacted()).toEqual([]);
    expect(announced).toEqual([]);
  });

  it('refuses a host that is not listed even in real mode, without touching the network', async () => {
    const real = createNet({ hosts: ['api.example.test'], announce: () => undefined });
    await expect(
      real.fetch('https://github.com/login/device/code', { method: 'POST' }),
    ).rejects.toBeInstanceOf(HostNotAllowedError);
    expect(real.contacted()).toEqual([]);
  });

  it('answers from the fixture, announcing each host once and recording what was asked', async () => {
    const { net: n, announced } = net([
      {
        method: 'GET',
        url: 'https://api.example.test/ping',
        response: { status: 200, json: { ok: true } },
      },
      {
        method: 'GET',
        url: 'https://api.example.test/text?x=1',
        response: { status: 404, text: 'nope', headers: { 'x-a': 'b' } },
      },
    ]);
    const ok = await n.fetch('https://api.example.test/ping');
    expect([ok.status, ok.json()]).toEqual([200, { ok: true }]);
    const missing = await n.fetch('https://api.example.test/text?x=1');
    expect([missing.status, missing.text(), missing.headers['x-a']]).toEqual([404, 'nope', 'b']);
    expect(announced).toEqual(['Will contact: api.example.test']);
    expect(n.contacted()).toEqual(['api.example.test']);
    expect(n.requests()).toEqual(['GET api.example.test/ping', 'GET api.example.test/text']);
  });

  it('matches on method and body, and plays a polling sequence with once entries in order', async () => {
    const { net: n } = net([
      {
        method: 'POST',
        url: 'https://api.example.test/token',
        bodyIncludes: 'device_code=D',
        once: true,
        response: { status: 200, json: { error: 'authorization_pending' } },
      },
      {
        method: 'POST',
        url: 'https://api.example.test/token',
        bodyIncludes: 'device_code=D',
        response: { status: 200, json: { done: true } },
      },
      {
        method: 'POST',
        url: 'https://api.example.test/token',
        bodyIncludes: 'refresh_token=R',
        response: { status: 200, json: { refreshed: true } },
      },
    ]);
    const post = (body: string) =>
      n.fetch('https://api.example.test/token', { method: 'POST', body });
    expect((await post('device_code=D')).json()).toEqual({ error: 'authorization_pending' });
    expect((await post('device_code=D')).json()).toEqual({ done: true });
    expect((await post('refresh_token=R')).json()).toEqual({ refreshed: true });
  });

  it('says which request had no fixture, without the body', async () => {
    const { net: n } = net([
      { method: 'GET', url: 'https://api.example.test/a', response: { status: 200, text: '' } },
    ]);
    await expect(
      n.fetch('https://api.example.test/b', { method: 'POST', body: 'secret=1' }),
    ).rejects.toThrow(NetFixtureMissError);
    await expect(
      n.fetch('https://api.example.test/b', { method: 'POST', body: 'secret=1' }),
    ).rejects.not.toThrow(/secret/);
  });
});
