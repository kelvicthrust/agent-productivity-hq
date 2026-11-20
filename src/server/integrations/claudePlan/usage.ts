import { z } from 'zod';
import type { RateLimitInput } from '../../db/queries/accounts.ts';
import type { NetFetch } from '../../collectors/github/ports.ts';
import { CLAUDE_PLAN_LIMITS_URL } from '../../lib/net.ts';

const FALLBACK_COOLDOWN_MS = 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_EPOCH_MS = Date.parse('9999-12-31T23:59:59Z');
const ResetTimestamp = z.iso.datetime({ offset: true });

const WINDOWS = [
  ['five_hour', 300],
  ['seven_day', 10_080],
  ['seven_day_sonnet', 10_080],
  ['seven_day_opus', 10_080],
] as const;

export type UsageResult =
  | { state: 'ok'; limits: RateLimitInput[] }
  | { state: 'limited'; retryAt: number }
  | { state: 'reconnect' | 'unsupported' | 'failed' };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function usableWindow(
  limitId: string,
  windowMinutes: number,
  value: unknown,
): RateLimitInput | null {
  const entry = record(value);
  const usedPercent = entry?.['utilization'];
  const iso = entry?.['resets_at'];
  if (
    typeof usedPercent !== 'number' ||
    !Number.isFinite(usedPercent) ||
    usedPercent < 0 ||
    usedPercent > 100
  ) {
    return null;
  }

  if (iso === null) return { limitId, usedPercent, windowMinutes, resetsAt: null };
  const parsed = ResetTimestamp.safeParse(iso);
  if (!parsed.success) return null;
  const resetsAt = Date.parse(parsed.data);
  return Number.isFinite(resetsAt) && resetsAt >= 0 && resetsAt <= MAX_EPOCH_MS
    ? { limitId, usedPercent, windowMinutes, resetsAt }
    : null;
}

function sanitizedLimits(value: unknown): UsageResult {
  const body = record(value);
  if (body === null) return { state: 'failed' };
  const limits = WINDOWS.flatMap(([id, minutes]) => {
    const item = usableWindow(id, minutes, body[id]);
    return item === null ? [] : [item];
  });
  if (limits.length > 0) return { state: 'ok', limits };

  const known = WINDOWS.filter(([id]) => Object.hasOwn(body, id));
  return known.length > 0 && known.every(([id]) => body[id] === null)
    ? { state: 'unsupported' }
    : { state: 'failed' };
}

function retryAt(header: string | null, now: number): number {
  const value = header?.trim();
  if (!value) return now + FALLBACK_COOLDOWN_MS;
  let date: number;
  if (/^\d+$/.test(value)) {
    date = now + Number(value) * 1_000;
  } else {
    date = /^[A-Za-z]{3}, /.test(value) ? Date.parse(value) : NaN;
  }
  return Number.isSafeInteger(date) && date <= MAX_EPOCH_MS
    ? Math.max(now, date)
    : now + FALLBACK_COOLDOWN_MS;
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const data = Buffer.alloc(MAX_BODY_BYTES);
  let offset = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return JSON.parse(data.toString('utf8', 0, offset)) as unknown;
      if (offset + next.value.byteLength > data.byteLength) {
        await reader.cancel();
        return null;
      }
      data.set(next.value, offset);
      offset += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function readClaudePlanUsage(
  net: NetFetch,
  accessToken: string,
  now: () => number,
): Promise<UsageResult> {
  try {
    const response = await net(CLAUDE_PLAN_LIMITS_URL, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });
    if (response.ok) return sanitizedLimits(await boundedJson(response));

    // Provider error bodies are irrelevant, and can contain sensitive data.
    void response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) return { state: 'reconnect' };
    if (response.status === 429) {
      return { state: 'limited', retryAt: retryAt(response.headers.get('retry-after'), now()) };
    }
    return { state: 'failed' };
  } catch {
    return { state: 'failed' };
  }
}
