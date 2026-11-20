import type { AccountStatus } from '../../../shared/contracts/sources';
import type { Discovery } from '../../lib/setup';
import { ChatgptRow } from './ChatgptRow';
import { SETUP_COPY } from './copy';
import { GithubRow } from './GithubRow';
import { StepCard } from './parts';

// Step 2, "Connect accounts": GitHub (merged PRs and private repo access) and ChatGPT (account-reported Codex usage), both optional. The
// cards are server state, read from `GET /api/sources` like the Sources page, so a connection made here shows there at once. Discovery adds
// the one thing a read of stored rows cannot know on a first launch: whether `codex` is on this computer, which decides whether ChatGPT
// can be connected at all. Claude plan limits can be checked on demand in Sources.

export function AccountsStep({
  accounts,
  accountsFailed,
  answer,
  looking,
  onLookAgain,
}: {
  accounts: readonly AccountStatus[] | undefined;
  accountsFailed: boolean;
  answer: Discovery | null;
  looking: boolean;
  onLookAgain: () => void;
}) {
  const copy = SETUP_COPY.accounts;
  const github = accounts?.find((account) => account.id === 'github');
  const liveChatgpt = accounts?.find((account) => account.id === 'chatgpt');
  const found = answer?.accounts?.find((account) => account.id === 'chatgpt');
  // No `codex` on this computer: discovery's word stands until a connection says otherwise (a read of stored rows has not looked yet).
  const noCodex = found?.status === 'unavailable' && found.reason === 'codex_not_found';
  const chatgpt =
    noCodex && liveChatgpt?.status === 'notconnected' ? found : (liveChatgpt ?? found);
  const codexSource = answer?.sources?.find((source) => source.id === 'codex');
  const noLocalCodex =
    codexSource !== undefined && codexSource.status !== 'ok' && codexSource.status !== 'partial';

  return (
    <StepCard id="setup-step-accounts" title={copy.title} scope={copy.scope}>
      {accountsFailed ? (
        <p role="alert" className="text-copy text-danger">
          {copy.loadFailed}
        </p>
      ) : !accounts ? (
        <p role="status" className="text-copy text-ink-muted">
          {copy.loading}
        </p>
      ) : (
        <ul className="flex flex-col">
          <GithubRow card={github} />
          <ChatgptRow
            card={chatgpt}
            noLocalCodex={noLocalCodex}
            onCheckAgain={onLookAgain}
            checking={looking}
          />
        </ul>
      )}
      <p className="text-caption text-ink-muted">{copy.claude}</p>
      <p className="text-caption text-ink-muted">{copy.footnote}</p>
    </StepCard>
  );
}
