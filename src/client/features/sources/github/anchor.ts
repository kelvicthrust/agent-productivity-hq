// The GitHub section's heading, which the repository form points to when the reason a repo could not be added is that GitHub is
// not set up yet. Moving focus to a heading (it has tabIndex -1) scrolls it into view and tells a screen reader where it landed;
// a bare #fragment link would scroll but leave focus behind.
export const GITHUB_TITLE_ID = 'src-github-title';

export function focusGithubSection(): void {
  document.getElementById(GITHUB_TITLE_ID)?.focus();
}
