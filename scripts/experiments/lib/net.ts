import { readFileSync } from 'node:fs';
import type { FetchInit, FetchResponse } from './types.ts';

// The only place an experiment can reach a network. HTTPS only, to the hostnames in meta.network. With --net-fixture it
// answers from a file (a list of request matchers) and never opens a connection, which is how selftest runs E6.

export class HostNotAllowedError extends Error {
  constructor(host: string) {
    super(`"${host.slice(0, 60)}" is not in this script's list of hosts it may contact.`);
    this.name = 'HostNotAllowedError';
  }
}

export class NetFixtureMissError extends Error {
  constructor(method: string, url: string) {
    super(`No fixture response for ${method} ${url.slice(0, 120)}.`);
    this.name = 'NetFixtureMissError';
  }
}

interface FixtureEntry {
  method: string;
  url: string;
  bodyIncludes?: string;
  once?: boolean;
  response: { status: number; headers?: Record<string, string>; json?: unknown; text?: string };
}

export interface NetConfig {
  hosts: readonly string[];
  fixturePath?: string | undefined;
  announce(line: string): void;
}

export interface Net {
  fetch(url: string, init?: FetchInit): Promise<FetchResponse>;
  contacted(): string[];
  /** Requests answered or sent, as "METHOD host/path" without query or body, for assertions. */
  requests(): string[];
}

const MAX_BODY = 8 * 1024 * 1024;

function toResponse(status: number, headers: Record<string, string>, text: string): FetchResponse {
  return { status, headers, text: () => text, json: () => JSON.parse(text) as unknown };
}

export function createNet(config: NetConfig): Net {
  const contacted = new Set<string>();
  const requests: string[] = [];
  const used = new Set<number>();
  const fixture: FixtureEntry[] | null = config.fixturePath
    ? ((JSON.parse(readFileSync(config.fixturePath, 'utf8')) as { requests: FixtureEntry[] })
        .requests ?? [])
    : null;
  const allowedHosts = config.hosts.map((h) => h.toLowerCase());

  return {
    contacted: () => [...contacted].sort(),
    requests: () => [...requests],
    async fetch(url, init = {}) {
      const parsed = new URL(url);
      const method = (init.method ?? 'GET').toUpperCase();
      if (parsed.protocol !== 'https:')
        throw new HostNotAllowedError(`${parsed.protocol}//${parsed.host}`);
      const host = parsed.host.toLowerCase();
      // The host with its port, exactly as listed: "api.github.com" means port 443 only.
      if (!allowedHosts.includes(host)) throw new HostNotAllowedError(host);
      if (!contacted.has(parsed.hostname)) config.announce(`Will contact: ${parsed.hostname}`);
      contacted.add(parsed.hostname);
      requests.push(`${method} ${parsed.hostname}${parsed.pathname}`);

      if (fixture) {
        const bare = `${parsed.origin}${parsed.pathname}${parsed.search}`;
        const body = init.body ?? '';
        const index = fixture.findIndex(
          (entry, i) =>
            entry.method.toUpperCase() === method &&
            entry.url === bare &&
            !(entry.once && used.has(i)) &&
            (!entry.bodyIncludes || body.includes(entry.bodyIncludes)),
        );
        if (index < 0) throw new NetFixtureMissError(method, bare);
        used.add(index);
        const { response } = fixture[index]!;
        const text =
          response.json !== undefined ? JSON.stringify(response.json) : (response.text ?? '');
        return toResponse(response.status, response.headers ?? {}, text);
      }

      const res = await fetch(parsed, {
        method,
        headers: init.headers ?? {},
        body: init.body ?? null,
        redirect: 'manual',
        signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
      });
      const location = res.headers.get('location');
      if (location) {
        const target = new URL(location, parsed);
        if (!allowedHosts.includes(target.host.toLowerCase()))
          throw new HostNotAllowedError(target.host);
      }
      const text = (await res.text()).slice(0, MAX_BODY);
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key] = value;
      });
      return toResponse(res.status, headers, text);
    },
  };
}
