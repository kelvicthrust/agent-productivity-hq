import { z } from 'zod';
import type { AccountReport } from '../../shared/contracts/accounts.ts';
import { Provider } from '../../shared/contracts/common.ts';
import type { PaseoQuotaResponse, PaseoQuotaWindow } from '../../shared/contracts/paseo-quota.ts';

const WEEKLY_MINUTES = 10_080;
const CACHE_MS = 30_000;

// Pick only the fields used here. One invalid provider or window should leave the others readable.
const HostReport = z.object({ fetchedAt: z.string().nullish(), providers: z.array(z.unknown()) });
const HostProvider = z.object({
  providerId: Provider,
  status: z.enum(['available', 'unavailable', 'error']),
  fetchedAt: z.string().nullish(),
  windows: z.array(z.unknown()),
});
const HostWindow = z.object({
  id: z.string(),
  label: z.string(),
  usedPct: z.number().nullish(),
  remainingPct: z.number().nullish(),
  resetsAt: z.string().nullish(),
});
const DateTime = z.iso.datetime({ offset: true });

export interface PaseoQuotaService {
  read(): Promise<PaseoQuotaResponse>;
  check(provider: Provider): Promise<PaseoQuotaResponse>;
  clear(): void;
}

interface PaseoQuotaDeps {
  listUsage: () => Promise<unknown>;
  checkCodex: () => Promise<AccountReport | null>;
  checkClaude: () => Promise<AccountReport | null>;
  now?: () => number;
}

interface QuotaReading {
  general: PaseoQuotaWindow | null;
  scoped: PaseoQuotaWindow[];
}

function timestamp(value: string | null | undefined): string | null {
  if (!DateTime.safeParse(value).success || value == null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

const percentIsValid = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

function hostLimits(
  provider: z.infer<typeof HostProvider>,
  fetchedAt: string | null,
): QuotaReading {
  const reading: QuotaReading = { general: null, scoped: [] };
  // The daemon's compatibility response supplies the oldest report time once for the whole list.
  const refreshedAt = timestamp(provider.fetchedAt) ?? fetchedAt;
  const seen = new Set<string>();
  for (const item of provider.windows) {
    const parsed = HostWindow.safeParse(item);
    if (!parsed.success) continue;
    const { id, label, usedPct, remainingPct, resetsAt } = parsed.data;
    const general = id === 'weekly' || (provider.providerId === 'claude' && id === 'seven_day');
    const scoped =
      provider.providerId === 'claude'
        ? /^(?:weekly_(?:model|surface)_|seven_day_)\S+$/.test(id)
        : id === 'code_review:weekly' || /^limit:\S+:weekly$/.test(id);
    if ((!general && !scoped) || seen.has(id)) continue;
    const usedPercent = percentIsValid(usedPct)
      ? usedPct
      : percentIsValid(remainingPct) && remainingPct <= 100
        ? 100 - remainingPct
        : null;
    if (usedPercent === null) continue;

    const quota = {
      id,
      label,
      usedPercent,
      resetsAt: timestamp(resetsAt),
      source: 'paseo' as const,
      refreshedAt,
      stale: refreshedAt === null,
    };
    seen.add(id);
    if (general) reading.general ??= quota;
    else reading.scoped.push(quota);
  }
  return reading;
}

function directLimits(provider: Provider, report: AccountReport | null): QuotaReading | undefined {
  if (
    report?.unit !== 'percent' ||
    report.account !== (provider === 'codex' ? 'chatgpt' : 'claude')
  ) {
    return undefined;
  }
  if (provider === 'claude' && report.provenance !== 'claude_code_oauth') return undefined;

  const reading: QuotaReading = { general: null, scoped: [] };
  const refreshedAt = timestamp(report.refreshedAt);
  for (const window of report.rateLimits ?? []) {
    if (window.windowMinutes !== WEEKLY_MINUTES || !percentIsValid(window.usedPercent)) continue;
    const quota = {
      id: window.limitId,
      label: window.label ?? 'Weekly',
      usedPercent: window.usedPercent,
      resetsAt: timestamp(window.resetsAt),
      source: 'direct' as const,
      refreshedAt,
      stale: report.stale === true || refreshedAt === null,
    };
    // The Codex port returns only the app's verified general weekly report. Claude's port also has model limits.
    if (provider === 'codex' || window.limitId === 'seven_day') reading.general ??= quota;
    else if (window.limitId.startsWith('seven_day_')) reading.scoped.push(quota);
  }
  return reading;
}

function withFreshness(window: PaseoQuotaWindow | null | undefined, now: number, failed = false) {
  if (!window) return null;
  const expiresAt =
    window.resetsAt === null
      ? window.refreshedAt === null
        ? 0
        : Date.parse(window.refreshedAt) + WEEKLY_MINUTES * 60_000
      : Date.parse(window.resetsAt);
  return { ...window, stale: window.stale || failed || expiresAt <= now };
}

/** Read the daemon's provider reports separately from the live roster. A direct check always starts with a daemon read. */
export function createPaseoQuotaService(deps: PaseoQuotaDeps): PaseoQuotaService {
  const now = deps.now ?? Date.now;
  const host = new Map<Provider, QuotaReading>();
  const direct = new Map<Provider, QuotaReading>();
  const failed = new Set<Provider>();
  const checking = new Map<Provider, Promise<PaseoQuotaResponse>>();
  let pending: Promise<void> | undefined;
  let readAt = -Infinity;
  let generation = 0;

  async function refreshHost(current: number) {
    try {
      const report = HostReport.parse(await deps.listUsage());
      if (current !== generation) return;
      const fetchedAt = timestamp(report.fetchedAt);
      const time = now();
      const reports = report.providers.flatMap((value) => {
        const parsed = HostProvider.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      });
      for (const provider of Provider.options) {
        const rows = reports.filter((report) => report.providerId === provider);
        const available = rows
          .filter((row) => row.status === 'available')
          .map((row) => hostLimits(row, fetchedAt));
        // Multiple host accounts can share a provider ID. Choose one report without combining their quota windows.
        const reading =
          available.find((value) => withFreshness(value.general, time)?.stale === false) ??
          available.find((value) => value.general !== null) ??
          available.find((value) => value.scoped.length > 0);
        if (reading) {
          host.set(provider, reading);
          failed.delete(provider);
        } else if (rows.some((row) => row.status === 'error')) {
          failed.add(provider);
        } else {
          host.delete(provider);
          failed.delete(provider);
        }
      }
    } catch {
      if (current === generation) {
        for (const provider of Provider.options) failed.add(provider);
      }
    } finally {
      if (current === generation) readAt = now();
    }
  }

  function refresh(force: boolean): Promise<void> {
    if (pending) return pending;
    if (!force && now() - readAt < CACHE_MS) return Promise.resolve();
    const current = generation;
    pending = refreshHost(current).finally(() => {
      if (current === generation) pending = undefined;
    });
    return pending;
  }

  function response(): PaseoQuotaResponse {
    const time = now();
    return {
      providers: Provider.options.map((provider) => {
        const hostReading = host.get(provider);
        const directReading = direct.get(provider);
        const hostFailed = failed.has(provider);
        const hostGeneral = withFreshness(hostReading?.general, time, hostFailed);
        const canCheck = !hostGeneral || hostGeneral.stale;
        const directGeneral = withFreshness(directReading?.general, time);
        const general = canCheck ? (directGeneral ?? hostGeneral) : hostGeneral;
        const windows = (hostReading?.scoped ?? []).map((window) =>
          withFreshness(window, time, hostFailed)!,
        );
        if (canCheck) {
          for (const window of directReading?.scoped ?? []) {
            windows.push(withFreshness(window, time)!);
          }
        }
        return {
          provider,
          source: general?.source ?? null,
          usedPercent: general?.usedPercent ?? null,
          resetsAt: general?.resetsAt ?? null,
          refreshedAt: general?.refreshedAt ?? null,
          stale: general?.stale ?? false,
          canCheck,
          windows,
        };
      }),
    };
  }

  async function checkProvider(provider: Provider, current: number): Promise<PaseoQuotaResponse> {
    await refresh(true);
    if (current !== generation) return response();
    const hostGeneral = withFreshness(host.get(provider)?.general, now(), failed.has(provider));
    if (hostGeneral === null || hostGeneral.stale) {
      const check = provider === 'codex' ? deps.checkCodex : deps.checkClaude;
      const reading = directLimits(
        provider,
        await Promise.resolve()
          .then(check)
          .catch(() => null),
      );
      if (current === generation) {
        if (reading) direct.set(provider, reading);
        else direct.delete(provider);
      }
    }
    return response();
  }

  return {
    async read() {
      await refresh(false);
      return response();
    },
    check(provider) {
      const existing = checking.get(provider);
      if (existing) return existing;
      const current = generation;
      const operation = checkProvider(provider, current).finally(() => {
        if (current === generation) checking.delete(provider);
      });
      checking.set(provider, operation);
      return operation;
    },
    clear() {
      generation += 1;
      host.clear();
      direct.clear();
      failed.clear();
      checking.clear();
      pending = undefined;
      readAt = -Infinity;
    },
  };
}
