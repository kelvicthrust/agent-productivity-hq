const projectUrl = 'https://github.com/kelvicthrust/agent-productivity-hq';

export function ProjectCredit() {
  return (
    <footer className="mt-8 border-t border-border pt-3 text-caption text-ink-muted">
      Made with &lt;3 by{' '}
      <a
        href={projectUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex min-h-11 items-center text-ink underline underline-offset-2 min-[720px]:min-h-7"
      >
        kelvicthrust
      </a>
    </footer>
  );
}
