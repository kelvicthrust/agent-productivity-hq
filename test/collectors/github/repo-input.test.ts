import { describe, expect, it } from 'vitest';
import {
  EMPTY_INPUT_MESSAGE,
  NOT_A_REPO_MESSAGE,
  NOT_GITHUB_MESSAGE,
  parseRepoInput,
} from '../../../src/shared/domain/repoInput.ts';

// "Add a repository" takes owner/name or any address that names the repository on github.com (P-14). Pure parsing: the
// canonical id is decided later, by GitHub's `full_name`.

describe('parseRepoInput', () => {
  const accepted: [string, string][] = [
    ['kelvin/atlas-api', 'kelvin/atlas-api'],
    ['  Kelvin/Atlas-API  ', 'Kelvin/Atlas-API'],
    ['https://github.com/kelvin/atlas-api', 'kelvin/atlas-api'],
    ['https://www.github.com/kelvin/atlas-api/', 'kelvin/atlas-api'],
    ['http://github.com/kelvin/atlas-api.git', 'kelvin/atlas-api'],
    ['github.com/kelvin/atlas-api', 'kelvin/atlas-api'],
    ['https://github.com/kelvin/atlas-api/pulls', 'kelvin/atlas-api'],
    ['https://github.com/kelvin/atlas-api/pull/42/files?diff=split#top', 'kelvin/atlas-api'],
    ['https://github.com/kelvin/atlas-api/tree/main/src/server', 'kelvin/atlas-api'],
    ['git@github.com:kelvin/atlas-api.git', 'kelvin/atlas-api'],
    ['ssh://git@github.com/kelvin/atlas-api', 'kelvin/atlas-api'],
    ['kelvin/dot.name_with-chars', 'kelvin/dot.name_with-chars'],
  ];
  for (const [input, expected] of accepted) {
    it(`reads ${JSON.stringify(input)}`, () => {
      expect(parseRepoInput(input)).toEqual({
        ok: true,
        owner: expected.split('/')[0],
        name: expected.split('/')[1],
      });
    });
  }

  const refused: [string, string][] = [
    ['', EMPTY_INPUT_MESSAGE],
    ['   ', EMPTY_INPUT_MESSAGE],
    ['kelvin', NOT_A_REPO_MESSAGE],
    ['kelvin/', NOT_A_REPO_MESSAGE],
    ['/atlas-api', NOT_A_REPO_MESSAGE],
    ['a/b/c', NOT_A_REPO_MESSAGE],
    ['kelvin/atlas api', NOT_A_REPO_MESSAGE],
    ['kelvin/atlas-api?x=1', NOT_A_REPO_MESSAGE],
    ['-kelvin/atlas-api', NOT_A_REPO_MESSAGE],
    ['kelvin/..', NOT_A_REPO_MESSAGE],
    ['kelvin/.git', NOT_A_REPO_MESSAGE],
    [`${'a'.repeat(40)}/repo`, NOT_A_REPO_MESSAGE],
    ['https://github.com/kelvin', NOT_A_REPO_MESSAGE],
    ['https://gitlab.com/kelvin/atlas-api', NOT_GITHUB_MESSAGE],
    ['git@gitlab.com:kelvin/atlas-api.git', NOT_GITHUB_MESSAGE],
    ['https://github.com.evil.example/kelvin/atlas-api', NOT_GITHUB_MESSAGE],
  ];
  for (const [input, message] of refused) {
    it(`refuses ${JSON.stringify(input.slice(0, 50))} with a plain sentence`, () => {
      expect(parseRepoInput(input)).toEqual({ ok: false, message });
    });
  }
});
