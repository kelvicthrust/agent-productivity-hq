import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OverviewResponse } from '../../src/shared/contracts/overview.ts';
import {
  PrDetailResponse,
  PrsResponse,
  PullRequest,
  RecordsResponse,
} from '../../src/shared/contracts/prs.ts';

// G8_8: tokens are never allocated to a pull request. A PR is evidence of involvement; the tokens of a session stay on the dates
// they were used (TECH › Attribution, and the footnote every opened PR carries). The contract is where that is held: no shape
// that describes a PR, or the figures about PRs, has a field for tokens, so no service can fill one in by accident.
//
// What is allowed to carry tokens, and is not looked at here: a session (its own tokens), a repo row (the local tokens of the repo's
// sessions, not of its PRs) and the Overview's recorded-tokens tile.

type Json = { properties?: Record<string, Json>; items?: Json; anyOf?: Json[]; allOf?: Json[] };

/** Every property name anywhere inside a JSON Schema, at any depth. */
function names(schema: Json, into: string[] = []): string[] {
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    into.push(name);
    names(child, into);
  }
  if (schema.items) names(schema.items, into);
  for (const branch of [...(schema.anyOf ?? []), ...(schema.allOf ?? [])]) names(branch, into);
  return into;
}

const jsonOf = (schema: z.ZodType): Json => z.toJSONSchema(schema, { io: 'output' }) as Json;
const tokenFields = (schema: z.ZodType): string[] =>
  names(jsonOf(schema)).filter((name) => /token/i.test(name));

describe('no token field on anything that describes a pull request', () => {
  it('a PR in the Delivery list, the PR detail and the records drawer has none', () => {
    expect(tokenFields(PullRequest)).toEqual([]);
    expect(tokenFields(PrsResponse)).toEqual([]);
    // The detail's PR is the same shape; its evidence items list SESSIONS, which carry their own recorded tokens and nothing else.
    const detail = jsonOf(PrDetailResponse);
    expect(names(detail.properties!['pr']!).filter((name) => /token/i.test(name))).toEqual([]);
    const records = jsonOf(RecordsResponse);
    expect(names(records.properties!['prs']!).filter((name) => /token/i.test(name))).toEqual([]);
  });

  it('the Overview figures about PRs have none (only the recorded-tokens tile and the repo rows say tokens, of sessions)', () => {
    const kpis = jsonOf(OverviewResponse).properties!['kpis']!.properties!;
    expect(names(kpis['mergedPrs']!).filter((name) => /token/i.test(name))).toEqual([]);
    expect(names(kpis['linkedPrs']!).filter((name) => /token/i.test(name))).toEqual([]);
  });

  it('is not vacuous: the walk does find a token field where one belongs, and in a PR shape that was given one', () => {
    // a session lists its own tokens
    const records = jsonOf(RecordsResponse);
    expect(names(records.properties!['sessions']!).some((name) => /token/i.test(name))).toBe(true);
    // and a PR shape with a tokens field would be caught
    expect(tokenFields(PullRequest.extend({ tokens: z.number() }))).toEqual(['tokens']);
    expect(
      tokenFields(PullRequest.extend({ linked: z.object({ inputTokens: z.number() }) })),
    ).toEqual(['inputTokens']);
  });
});
