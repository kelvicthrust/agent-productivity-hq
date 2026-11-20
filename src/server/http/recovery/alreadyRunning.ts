import { renderRecoveryPage } from './layout.ts';

// Another Agent Productivity HQ already holds this data folder's lock. The database has a single writer, so this process does not
// touch it. The page points to the running copy.

export interface AlreadyRunningInfo {
  /** Where the running copy answers, such as http://127.0.0.1:4317. */
  url: string;
  /** The instance lock file that names it. */
  lockPath: string;
  /** The running copy's process id, when the lock names one. */
  pid?: number;
}

export function alreadyRunningPage(info: AlreadyRunningInfo): string {
  return renderRecoveryPage({
    title: 'Already running',
    headline: 'Agent Productivity HQ is already running',
    lead: 'Another copy is using this data folder, so this one did not start.',
    facts: [
      { label: 'The running copy answers at', value: info.url },
      ...(info.pid === undefined ? [] : [{ label: 'Its process id', value: String(info.pid) }]),
      { label: 'The lock file', value: info.lockPath },
    ],
    stepsTitle: 'What you can do',
    steps: [
      { text: `Open the running copy at ${info.url} and use it there.` },
      {
        text: 'If nothing answers there, check whether the other process is still starting or shutting down.',
      },
      { text: 'Start Agent Productivity HQ again.' },
    ],
  });
}
