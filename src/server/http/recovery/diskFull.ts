import { renderRecoveryPage } from './layout.ts';

// The disk has no room left for the database to write (SQLITE_FULL or ENOSPC). Nothing was deleted to make room and nothing is
// retried in a loop: the owner frees space and starts again.

export interface DiskFullInfo {
  /** The data folder that could not be written. */
  dataDir: string;
  /** What the system reported, one short safe sentence. */
  detail?: string;
}

export function diskFullPage(info: DiskFullInfo): string {
  return renderRecoveryPage({
    title: 'Not enough disk space',
    headline: 'There isn’t enough disk space',
    lead: 'Agent Productivity HQ can’t save to its data folder because the disk is full, so it is showing this page instead of your data.',
    notes: info.detail ? [info.detail] : [],
    facts: [{ label: 'The data folder', value: info.dataDir }],
    stepsTitle: 'Free some space and start again',
    steps: [
      { text: 'Free some space on this Mac: empty the Trash, or remove files you no longer need.' },
      { text: 'Stop Agent Productivity HQ (press Control-C in the terminal that started it).' },
      {
        text: 'Start Agent Productivity HQ again. What was already imported is kept, and the import carries on from where it stopped.',
      },
    ],
  });
}
