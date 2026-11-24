import { Button } from '@astryxdesign/core/Button';
import { Icon } from '../../../components/Icon';
import { focusGithubSection } from '../github/anchor';
import { REPO_COPY } from './copy';
import type { Problem } from '../../../lib/repos';

// A failed add, in words, with the one step that fixes it when there is one: the GitHub setup (no sign-in yet) or the page where
// the App gets installed on an owner. It is an alert, so it is read out when it appears; the field names it with aria-describedby.
export function ProblemLine({
  id,
  problem,
  onNeedsGithub = focusGithubSection,
}: {
  id: string;
  problem: Problem;
  onNeedsGithub?: () => void;
}) {
  return (
    <div
      id={id}
      role="alert"
      className="flex flex-col items-start gap-1.5 text-caption text-danger"
    >
      <p className="flex items-start gap-1.5">
        <Icon name="error" className="mt-px" />
        <span className="min-w-0">{problem.message}</span>
      </p>
      {problem.installUrl && (
        <Button
          label={REPO_COPY.openInstall}
          href={problem.installUrl}
          target="_blank"
          rel="noopener noreferrer"
          size="sm"
          variant="secondary"
          icon={<Icon name="external" />}
          className="max-[719px]:min-h-11"
        />
      )}
      {problem.needsApp && (
        <Button
          label={REPO_COPY.openGuide}
          size="sm"
          variant="secondary"
          className="max-[719px]:min-h-11"
          onClick={onNeedsGithub}
        />
      )}
    </div>
  );
}
