import { describe, expect, it } from 'vitest';
import { experiment as e6 } from '../../scripts/experiments/e6-github.ts';
import { FindingsBuilder, renderFindings } from '../../scripts/experiments/lib/findings.ts';
import { findSecrets } from '../../scripts/experiments/lib/secrets.ts';

// The synthetic E6 report exercises G6_1 with passing route steps and a failed minimal-permissions step.

/** What G6_1 requires E6 to have shown: the gh route and App route steps 1, 2, 4, 5 and 6. */
const REQUIRED = [
  'gh-token-and-login', // gh route
  'gh-graphql-merged-prs', // gh route
  'app-device-flow', // App route 1
  'keyring-binary-loads', // App route 2
  'keychain-round-trip', // App route 2
  'app-refresh-no-secret', // App route 4
  'app-uninstalled-owner-404', // App route 5
  'app-inaccessible-repo', // App route 6
] as const;
/** App route 3: keep the failed criterion visible beside the passing route steps. */
const WAIVED = 'app-minimal-permissions';

type Verdict = 'PASS' | 'FAIL' | 'NOT RUN';

/** The criteria a findings file lists: `- **PASS** \`id\` — …`. */
export function criteria(text: string): Map<string, Verdict> {
  const found = new Map<string, Verdict>();
  for (const match of text.matchAll(/^- \*\*(PASS|FAIL|NOT RUN)\*\* `([a-z0-9-]+)` — /gm)) {
    found.set(match[2] as string, match[1] as Verdict);
  }
  return found;
}

/** What is wrong with a findings text for G6_1. `checkScenario` also checks the synthetic route verdicts. */
export function problems(text: string, checkScenario: boolean): string[] {
  const listed = criteria(text);
  const out: string[] = [];
  for (const id of [...REQUIRED, WAIVED]) {
    if (!listed.has(id)) out.push(`criterion ${id} is not listed`);
  }
  if (checkScenario) {
    for (const id of REQUIRED) {
      if (listed.get(id) !== 'PASS') out.push(`${id} is ${listed.get(id) ?? 'missing'}, not PASS`);
    }
    if (listed.get(WAIVED) === 'PASS') out.push(`${WAIVED} was turned into a pass`);
  }
  if (findSecrets(text).length > 0) out.push('a token-shaped value is present');
  if (/\/Users\/|\/home\/|\/var\/folders\/|\/private\/|[A-Za-z]:\\/.test(text))
    out.push('an absolute path is present');
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(text))
    out.push('an e-mail address is present');
  return out;
}

const builder = new FindingsBuilder(e6.meta, () => Date.UTC(2000, 0, 1));
for (const id of REQUIRED) builder.criterion(id, 'pass');
builder.criterion(WAIVED, 'fail');
const fixture = renderFindings(
  builder.build({
    filesRead: 0,
    bytesRead: 0,
    programsStarted: [],
    hostsContacted: [],
    workspaceFolders: 0,
  }),
);

/** Built at run time: no token-shaped literal is committed (a secret scanner would flag one). */
const tokenShaped = (): string => ['ghu', 'A1b2C3d4E5'.repeat(4)].join('_');

describe('the synthetic E6 findings', () => {
  it('has the report structure and records the minimal-permissions failure alongside the passing steps', () => {
    expect(fixture).toMatch(/^# E6 · GitHub access, both routes/m);
    expect(fixture).toMatch(/^- Result: \*\*FAIL\*\*/m);
    expect(fixture).toMatch(/^## Criteria/m);
    expect(criteria(fixture).get(WAIVED)).toBe('FAIL');
    expect(problems(fixture, true)).toEqual([]);
  });

  const flip = (text: string, id: string, to: Verdict): string =>
    text.replace(
      new RegExp(`^- \\*\\*(PASS|FAIL|NOT RUN)\\*\\* \`${id}\``, 'm'),
      `- **${to}** \`${id}\``,
    );

  it('notices step 3 turned into a pass', () => {
    const mutated = flip(fixture, WAIVED, 'PASS');
    expect(mutated).not.toBe(fixture);
    expect(problems(mutated, true)).toContain(`${WAIVED} was turned into a pass`);
  });

  it('notices a required step that no longer passes, and a required step that is missing', () => {
    const failed = flip(fixture, 'app-refresh-no-secret', 'FAIL');
    expect(problems(failed, true)).toContain('app-refresh-no-secret is FAIL, not PASS');
    const removed = fixture
      .split('\n')
      .filter((line) => !line.includes('`app-uninstalled-owner-404`'))
      .join('\n');
    expect(problems(removed, false)).toContain('criterion app-uninstalled-owner-404 is not listed');
    expect(problems(removed, true)).toContain('app-uninstalled-owner-404 is missing, not PASS');
  });

  it('notices step 3 missing from the list, so the waiver can never be silent', () => {
    const removed = fixture
      .split('\n')
      .filter((line) => !line.includes(`\`${WAIVED}\``))
      .join('\n');
    expect(problems(removed, false)).toContain(`criterion ${WAIVED} is not listed`);
  });

  it('notices a token-shaped value, an absolute path and an e-mail address', () => {
    expect(problems(`${fixture}\n- leaked ${tokenShaped()}`, false)).toContain(
      'a token-shaped value is present',
    );
    expect(problems(`${fixture}\n- file /Users/someone/x`, false)).toContain(
      'an absolute path is present',
    );
    expect(problems(`${fixture}\n- someone@example.com`, false)).toContain(
      'an e-mail address is present',
    );
  });
});
