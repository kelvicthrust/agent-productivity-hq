import { SOURCES_COPY } from '../../../lib/copy';
import { useBootstrap } from '../../../lib/bootstrap';
import { GithubConnection } from '../github/GithubConnection';
import { useGithub } from '../github/data';
import { ChatgptRow } from './ChatgptRow';
import { ClaudeRow } from './ClaudeRow';
import { ACCOUNTS_COPY } from './copy';
import { useAccounts } from './data';

// The Accounts section of Sources & repos: GitHub access, ChatGPT sign-in, and on-demand Claude plan limits.
// GitHub is the first row (features/sources/github), as in D7: GitHub, then ChatGPT and Claude. The Sources page mounts this section
// (route.tsx), so the name `AccountsSection` and this file's place are the contract.
//
// Connection and report availability are shown separately: a connection does not guarantee a report or local history. The rows
// read the sources the whole page shares and change only when the server has answered (lib/accounts).

export function AccountsSection() {
  const { sources, chatgpt, claude } = useAccounts();
  const { card: github } = useGithub();
  const bootstrap = useBootstrap().data;
  // A process that serves none of the three accounts has nothing to set up here.
  if (sources.data && !chatgpt && !claude && !github) return null;
  return (
    <section
      aria-labelledby="src-accounts-title"
      className="flex min-w-0 flex-col gap-3 rounded-md border border-border bg-surface p-4 shadow-card"
    >
      <div className="min-w-0">
        <h2 id="src-accounts-title" className="font-display text-title-section text-ink">
          {SOURCES_COPY.accounts.title}
        </h2>
        <p className="mt-0.5 text-caption text-ink-muted">{SOURCES_COPY.accounts.scope}</p>
      </div>
      {sources.isError && !sources.data ? (
        <p role="alert" className="text-copy text-danger">
          {ACCOUNTS_COPY.loadFailed}
        </p>
      ) : !sources.data ? (
        <p role="status" className="text-copy text-ink-muted">
          {ACCOUNTS_COPY.loading}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          <GithubConnection />
          {chatgpt && <ChatgptRow card={chatgpt} />}
          {claude && bootstrap && (!bootstrap.paseoManaged || claude.captureHealth?.recorded) && (
            <ClaudeRow card={claude} removalOnly={bootstrap.paseoManaged === true} />
          )}
        </ul>
      )}
      <p className="text-caption text-ink-muted">{SOURCES_COPY.accounts.footnote}</p>
    </section>
  );
}
