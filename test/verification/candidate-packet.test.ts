import { describe, expect, it } from 'vitest';
import {
  PACKET_TABLE_HEADING,
  cells,
  WORD_LIMIT,
  indexFiles,
  packetProblems,
  packetRows,
  pathTokens,
  read,
  resolves,
  techVerificationRows,
} from './lib.ts';

// G10_4: the candidate packet names every requirement row of TECH's verification plan with evidence and a status or a reason. The
// packet is a hand-written index, so nothing else stops a row being dropped, a file being renamed under it, or a new row being added
// to the plan with no answer. This reads both documents and the file tree and says what is wrong; the negative controls run the same
// check on copies with one fault put in and expect that fault, so the check cannot quietly pass everything.

const tech = read('TECH.md');
const packet = read('docs/archive/implementation/candidate-handoff.md');
const index = indexFiles();
const problems = (override: { tech?: string; packet?: string } = {}): string[] =>
  packetProblems({ tech: override.tech ?? tech, packet: override.packet ?? packet, index });

describe('the candidate packet answers every row of TECH’s verification plan', () => {
  it('finds the plan’s rows and the packet’s rows (so an empty parse cannot pass)', () => {
    expect(techVerificationRows(tech).length).toBeGreaterThanOrEqual(41);
    expect(packetRows(packet).length).toBeGreaterThanOrEqual(41);
    expect(techVerificationRows(tech)[0]).toMatchObject({ req: 'P-01, P-02' });
  });

  it('names every row with evidence that exists and a status', () => {
    expect(problems()).toEqual([]);
  });

  it('keeps the packet to a compact index', () => {
    expect(packet.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(WORD_LIMIT);
  });

  describe('negative controls: each fault put in on purpose is found', () => {
    // The table is aligned by Prettier, so a row is found by its first cell, and a changed row is written back in one line.
    const lineOf = (req: string): string => {
      const line = packet.split('\n').find((l) => l.startsWith('|') && cells(l)[0] === req);
      if (!line) throw new Error(`the packet has no row for ${req}`);
      return line;
    };
    const changeRow = (req: string, change: (row: string[]) => string[]): string =>
      packet.replace(lineOf(req), `| ${change(cells(lineOf(req))).join(' | ')} |`);

    it('a row dropped from the packet', () => {
      expect(problems({ packet: packet.replace(`${lineOf('P-29')}\n`, '') })).toEqual([
        `no row for TECH's "P-29"`,
      ]);
    });

    it('a row added to TECH’s plan that the packet does not answer', () => {
      const grown = tech.replace('| Stack |', '| Invented requirement |  | Unit |\n| Stack |');
      expect(problems({ tech: grown })).toEqual([`no row for TECH's "Invented requirement"`]);
    });

    it('a row with no status', () => {
      const looksFine = changeRow('P-11', ([req, evidence]) => [req!, evidence!, 'Looks fine.']);
      expect(problems({ packet: looksFine })).toEqual([
        '"P-11" gives no status (passed, not-run, owner-run, unverified ...)',
      ]);
    });

    it('a row claiming an assessment passed', () => {
      const claimed = changeRow('P-11', ([req, evidence]) => [req!, evidence!, 'Passed.']);
      expect(problems({ packet: claimed })).toEqual([
        '"P-11" is claimed as assessed in the historical packet',
      ]);
    });

    it('a row whose evidence names a file that does not exist', () => {
      const broken = changeRow('P-10', ([req, , status]) => [
        req!,
        '`test/domain/gone.test.ts`',
        status!,
      ]);
      expect(problems({ packet: broken })).toEqual([
        '"P-10" names `test/domain/gone.test.ts`, which does not exist',
      ]);
    });

    it('a row with no evidence at all', () => {
      const bare = changeRow('P-13', ([req, , status]) => [req!, 'nothing', status!]);
      expect(problems({ packet: bare })).toEqual(['"P-13" names no file or folder as evidence']);
    });

    it('a packet over the word limit', () => {
      const bloated = `${packet}\n${'word '.repeat(WORD_LIMIT)}`;
      expect(problems({ packet: bloated }).join('\n')).toMatch(/over the 3000 limit/);
    });

    it('a packet that forgets the Node version, not-run list or scope limits', () => {
      const forgetful = packet
        .replaceAll('26.3.1', 'unknown')
        .replaceAll('not-run', 'untested')
        .replaceAll('Historical candidate', 'Candidate')
        .replaceAll('No current runtime assessment', 'Assessment');
      const found = problems({ packet: forgetful }).join('\n');
      expect(found).toMatch(/Node version 26\.3\.1/);
      expect(found).toMatch(/nothing as not-run/);
      expect(found).toMatch(/does not identify its historical scope/);
      expect(found).toMatch(/does not state the limit on current runtime assessment/);
    });

    it('a packet that omits an experiment', () => {
      const found = problems({ packet: packet.replace(/\bE5\b/g, 'E-five') }).join('\n');
      expect(found).toMatch(/does not account for the E5 experiment/);
    });
  });

  describe('how a name is found', () => {
    it('reads folders, bare file names, globs and docs paths, and refuses a name that is nowhere', () => {
      expect(resolves('test/collectors/claude', index)).toBe(true);
      expect(resolves('a11y.spec.ts', index)).toBe(true);
      expect(resolves('test/collectors/*/rules.test.ts', index)).toBe(true);
      expect(resolves('evidence/m10/README.md', index)).toBe(true);
      expect(resolves('evidence/m10/nothing.md', index)).toBe(false);
      expect(resolves('execution-record.md', index)).toBe(true);
      expect(resolves('docs/archive/implementation/execution-record.md', index)).toBe(true);
      expect(resolves('test/nowhere/at-all.test.ts', index)).toBe(false);
      expect(resolves('nothing.test.ts', index)).toBe(false);
    });

    it('takes only file-like names from a cell', () => {
      expect(
        pathTokens('`pnpm tokens:check`, `test/tokens`, `e2e.spec.ts`, `012345abcdef`'),
      ).toEqual(['test/tokens', 'e2e.spec.ts']);
    });
  });

  it('keeps the table where the parser looks for it', () => {
    expect(packet).toContain(PACKET_TABLE_HEADING);
  });
});
