// Shared by first-launch Setup and Sources & repos. See data-and-sources › GitHub delivery.
export const GITHUB_APP_GUIDE_LABEL = 'Register your GitHub App (one time)';

export function GithubAppGuide() {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-caption text-ink-muted">
        When GitHub CLI isn’t signed in, Agent Productivity HQ uses a personal GitHub App that you
        register once.
      </p>
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-copy text-ink marker:font-semibold marker:text-ink-muted">
        <li className="pl-1">
          Register a personal GitHub App at{' '}
          <a href="https://github.com/settings/apps/new" target="_blank" rel="noopener noreferrer">
            github.com/settings/apps/new
          </a>
          . Use a unique name, such as “Agent Productivity HQ” followed by your GitHub username. Set
          the homepage to http://127.0.0.1:4317 and leave webhooks off.
        </li>
        <li className="pl-1">Tick Enable Device Flow.</li>
        <li className="pl-1">
          Under Repository permissions, set Pull requests to Read-only. GitHub adds Metadata:
          Read-only for you. These are the minimum permissions Agent Productivity HQ needs. Keep
          expiring user tokens on.
        </li>
        <li className="pl-1">
          Install the App on your account and on every organization that owns a repository you
          track. Choose which repositories the App may access. Agent Productivity HQ can read
          repositories where you have access and the App is installed.
        </li>
        <li className="pl-1">
          Copy the App’s Client ID, starting with “Iv”, into the Client ID field and save it.
        </li>
      </ol>
    </div>
  );
}
