// What a person types into "Add a repository" (data-and-sources › Adding a repo, step 1): `owner/name`, or any address that
// names the repository on github.com, with whatever trails it (`/pulls`, `/tree/main/src`, `.git`, a query or a fragment).
// Pure: it never touches the network. The answer is only the owner and the name as typed; GitHub's `full_name` decides the
// canonical id once the access check has answered.

export type ParsedRepo = { ok: true; owner: string; name: string } | { ok: false; message: string };

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** The exact owner/name GitHub reports, without the URL handling used for owner input. */
export function isGithubRepoSlug(value: string): boolean {
  const [owner, name, trailing] = value.split('/');
  return (
    owner !== undefined &&
    name !== undefined &&
    trailing === undefined &&
    OWNER.test(owner) &&
    NAME.test(name) &&
    name !== '.' &&
    name !== '..'
  );
}

export const EMPTY_INPUT_MESSAGE = 'Enter a repository as owner/name or a GitHub URL.';
export const NOT_A_REPO_MESSAGE =
  'That doesn’t look like a GitHub repository. Use owner/name, for example kelvin/atlas-api.';
export const NOT_GITHUB_MESSAGE =
  'Only github.com repositories can be tracked. Use owner/name or a github.com address.';

const bad = (message: string): ParsedRepo => ({ ok: false, message });

function shaped(owner: string | undefined, rawName: string | undefined): ParsedRepo {
  if (!owner || !rawName) return bad(NOT_A_REPO_MESSAGE);
  const name = rawName.endsWith('.git') ? rawName.slice(0, -4) : rawName;
  if (!isGithubRepoSlug(`${owner}/${name}`)) return bad(NOT_A_REPO_MESSAGE);
  return { ok: true, owner, name };
}

/** Path segments without the empty ones a leading, trailing or doubled slash leaves. */
const segmentsOf = (path: string): string[] => path.split('/').filter((part) => part !== '');

export function parseRepoInput(raw: string): ParsedRepo {
  const text = raw.trim();
  if (text === '') return bad(EMPTY_INPUT_MESSAGE);

  // git@github.com:owner/name.git
  const scp = text.match(/^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(.+)$/);
  if (scp) {
    if (scp[1]?.toLowerCase() !== 'github.com') return bad(NOT_GITHUB_MESSAGE);
    const parts = segmentsOf(scp[2] ?? '');
    return parts.length === 2 ? shaped(parts[0], parts[1]) : bad(NOT_A_REPO_MESSAGE);
  }

  // https://github.com/owner/name/pulls, ssh://git@github.com/owner/name, github.com/owner/name
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text);
  if (hasScheme || /^(www\.)?github\.com\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(hasScheme ? text : `https://${text}`);
    } catch {
      return bad(NOT_A_REPO_MESSAGE);
    }
    const host = url.hostname.toLowerCase();
    if (host !== 'github.com' && host !== 'www.github.com') return bad(NOT_GITHUB_MESSAGE);
    // The owner and the name are the first two segments; anything after them is a page of the repository.
    const [owner, name] = segmentsOf(url.pathname);
    return shaped(owner, name);
  }

  // owner/name, and nothing else: a third segment is not a repository reference.
  const parts = segmentsOf(text);
  return parts.length === 2 && !/[?#\s]/.test(text)
    ? shaped(parts[0], parts[1])
    : bad(NOT_A_REPO_MESSAGE);
}
