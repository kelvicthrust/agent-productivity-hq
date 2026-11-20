import { Button } from '@astryxdesign/core/Button';
import type { ComponentProps } from 'react';
import { Link } from 'react-router';
import type { AccountReport } from '../../../shared/contracts/accounts';
import type { Provider, Scope } from '../../../shared/contracts/common';
import type { AccountStatus } from '../../../shared/contracts/sources';
import { AccountCard, type ReportingAccount } from '../../components/AccountCard';
import { OVERVIEW_COPY } from './copy';
import { WRAPPING_LABEL } from '../../lib/wrapLabel';
import { useNow } from '../../lib/useNow';

const COPY = OVERVIEW_COPY.accounts;

/** The local provider an account belongs to, for the Provider filter: ChatGPT is Codex's account, Claude is Claude Code's. */
const PROVIDER_OF: Record<ReportingAccount['id'], Provider> = {
  chatgpt: 'codex',
  claude: 'claude',
};

/** React Router's Link under the `href` name Astryx's Button passes to a custom link component. */
function RouterLink({ href, ...rest }: Omit<ComponentProps<typeof Link>, 'to'> & { href: string }) {
  return <Link to={href} {...rest} />;
}

const isReporting = (account: AccountStatus): account is ReportingAccount =>
  account.id === 'chatgpt' || account.id === 'claude';

/** Sources actions are for initial setup and sign-in problems. */
function nextStep(account: ReportingAccount): { label: string; primary: boolean } | null {
  if (account.id === 'claude') {
    if (
      account.status === 'connected' ||
      account.status === 'existing' ||
      account.reason === 'check_unavailable'
    ) {
      return null;
    }
    const state = account.planLimits?.state ?? 'unchecked';
    switch (state) {
      case 'unchecked':
      case 'signed_out':
      case 'unsupported':
      case 'reconnect':
      case 'credential_denied':
        return { label: COPY.action.claude, primary: false };
      default:
        return null;
    }
  }
  const named = COPY.action.chatgpt;
  switch (account.status) {
    case 'notconnected':
      return { label: named.connect, primary: false };
    case 'reconnect':
      return { label: named.reconnect, primary: true };
    default:
      return null;
  }
}

export function AccountCards({
  accounts,
  reports,
  scope,
  timeZone,
  today,
}: {
  /** `coverage.accounts`. */
  accounts: readonly AccountStatus[];
  /** The reports keep the providers' own windows. */
  reports: readonly AccountReport[];
  scope: Pick<Scope, 'provider'>;
  timeZone: string;
  /** Today's date in the report timezone (from bootstrap). */
  today: string;
}) {
  const now = useNow();
  const { provider } = scope;
  const shown = accounts
    .filter(isReporting)
    .filter((account) => provider === 'all' || PROVIDER_OF[account.id] === provider);
  return (
    <section
      aria-labelledby="ov-acct-title"
      className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4 shadow-card"
    >
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-2">
        <h2 id="ov-acct-title" className="font-display text-title-section text-ink">
          {COPY.title}
        </h2>
        <span className="rounded-full bg-sunken px-2 text-caption whitespace-nowrap text-ink-muted">
          {COPY.tag}
        </span>
      </div>
      {shown.length > 0 && (
        <ul className="m-0 flex list-none flex-col p-0">
          {shown.map((account) => {
            const step = nextStep(account);
            return (
              <AccountCard
                key={account.id}
                account={account}
                report={reports.find((report) => report.account === account.id) ?? null}
                when={{ timeZone, today, now }}
                action={
                  step && (
                    <Button
                      label={step.label}
                      href="/sources"
                      as={RouterLink}
                      size="sm"
                      variant={step.primary ? 'primary' : 'secondary'}
                      className={WRAPPING_LABEL}
                    />
                  )
                }
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}
