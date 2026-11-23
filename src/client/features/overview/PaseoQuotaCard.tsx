import { Button } from '@astryxdesign/core/Button';
import { useToast } from '@astryxdesign/core/Toast';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Provider, ProviderFilter } from '../../../shared/contracts/common';
import { PaseoQuotaResponse } from '../../../shared/contracts/paseo-quota';
import { apiGet, apiSend } from '../../lib/api';
import { PROVIDER_NAMES } from '../../lib/copy';
import { formatWhen } from '../../lib/format';
import { queryKeys } from '../../lib/queryClient';
import { WRAPPING_LABEL } from '../../lib/wrapLabel';

const PATH = '/api/paseo-quota';
const PERCENT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const DIRECT_SOURCE: Record<Provider, string> = {
  codex: 'Direct Codex check',
  claude: 'Direct Claude Code check',
};

export function PaseoQuotaCard({
  provider,
  timeZone,
  today,
}: {
  provider: ProviderFilter;
  timeZone: string;
  today: string;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const quota = useQuery({
    queryKey: queryKeys.paseoQuota,
    queryFn: ({ signal }) => apiGet(PATH, PaseoQuotaResponse, { signal }),
  });
  const check = useMutation({
    mutationFn: (id: Provider) => apiSend('POST', `${PATH}/${id}/check`, PaseoQuotaResponse),
    onSuccess: async (result, id) => {
      await client.cancelQueries({ queryKey: queryKeys.paseoQuota });
      client.setQueryData(queryKeys.paseoQuota, result);
      const limit = result.providers.find((row) => row.provider === id);
      if (limit?.usedPercent == null || limit.stale) {
        toast({ body: `No current weekly quota was available for ${PROVIDER_NAMES[id]}.` });
      }
    },
    onError: () => toast({ body: 'Couldn’t check the weekly quota. Try again.', type: 'error' }),
  });

  const when = (value: string) => formatWhen(value, { timeZone, today });
  function details(
    id: Provider,
    reading: {
      source: 'paseo' | 'direct' | null;
      stale: boolean;
      refreshedAt: string | null;
      resetsAt: string | null;
    },
  ) {
    return [
      reading.source === 'paseo' ? 'Paseo report' : DIRECT_SOURCE[id],
      reading.stale ? 'Stale reading' : null,
      reading.refreshedAt ? `Reported ${when(reading.refreshedAt)}` : 'Report time unavailable',
      reading.resetsAt ? `Reset time ${when(reading.resetsAt)}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  return (
    <section
      aria-labelledby="paseo-quota-title"
      className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4 shadow-card"
    >
      <div>
        <h2 id="paseo-quota-title" className="font-display text-title-section text-ink">
          Weekly subscription quota
        </h2>
        <p className="text-caption text-ink-muted">
          Each provider reports its own seven-day window.
        </p>
      </div>
      {quota.isError && !quota.data ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-copy text-danger">
            Couldn’t load weekly quotas.
          </p>
          <Button
            label="Retry"
            variant="secondary"
            size="sm"
            onClick={() => void quota.refetch()}
          />
        </div>
      ) : !quota.data ? (
        <p role="status" className="text-copy text-ink-muted">
          Loading weekly quotas…
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border p-0">
          {quota.data.providers
            .filter((row) => provider === 'all' || row.provider === provider)
            .map((row) => {
              const name = PROVIDER_NAMES[row.provider];
              const pending = check.isPending && check.variables === row.provider;
              const descriptionId = `paseo-quota-check-${row.provider}`;
              return (
                <li
                  key={row.provider}
                  className="flex min-w-0 flex-col gap-2 py-3 first:pt-0 last:pb-0"
                >
                  <h3 className="text-label font-semibold text-ink">{name}</h3>
                  <div aria-live="polite">
                    {row.usedPercent === null ? (
                      <p className="text-copy text-ink-muted">General weekly quota unavailable.</p>
                    ) : (
                      <>
                        <p className="font-display text-metric text-ink">
                          {PERCENT.format(row.usedPercent)}%{' '}
                          <span className="font-sans text-label tracking-normal text-ink-muted">
                            of general weekly limit used
                          </span>
                        </p>
                        <p className="text-caption text-ink-muted">{details(row.provider, row)}</p>
                      </>
                    )}
                    {row.windows.length > 0 && (
                      <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
                        {row.windows.map((window) => (
                          <li key={`${window.source}/${window.id}`} className="min-w-0 break-words">
                            <p className="text-label font-semibold text-ink">
                              {window.label} · {PERCENT.format(window.usedPercent)}% used
                            </p>
                            <p className="text-caption text-ink-muted">
                              {details(row.provider, window)}
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  {row.canCheck && (
                    <div className="flex flex-col items-start gap-1">
                      <Button
                        label={pending ? `Checking ${name}…` : `Check ${name} quota`}
                        size="sm"
                        variant="secondary"
                        className={`max-[719px]:min-h-11 ${WRAPPING_LABEL}`}
                        aria-describedby={descriptionId}
                        aria-busy={pending || undefined}
                        aria-disabled={check.isPending || undefined}
                        onClick={() => {
                          if (!check.isPending) check.mutate(row.provider);
                        }}
                      />
                      <p id={descriptionId} className="text-caption text-ink-muted">
                        Uses the existing {name} sign-in if Paseo still has no current reading.
                      </p>
                    </div>
                  )}
                </li>
              );
            })}
        </ul>
      )}
    </section>
  );
}
