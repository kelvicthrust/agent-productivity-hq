import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// TECH.md › Non-functional architecture › Security and privacy, read from the file itself, so a row added there with no test here
// fails test/security/security.test.ts instead of going unnoticed.

export const ROOT = join(import.meta.dirname, '../..');

/** One table row: the first column, then the rest in order (the Security table's are mechanism, boundary, verification). */
export interface TechRow {
  risk: string;
  mechanism: string;
  boundary: string;
  verification: string;
}

/**
 * The rows of the obligation table under "### <heading>" in TECH.md (header and divider rows left out).
 *
 * Only the FIRST table is read: it ends at the first line that is not a table row, and at any heading of any level. A section can
 * go on with prose, an "####" subsection and tables of its own that only support the obligations (TECH's Performance section keeps
 * the retained chart measurements in one); those rows are observations, not obligations, and reading them as rows made the
 * required benchmark suite fail on rows it was never meant to time. A relative `file` is read from the project root.
 */
export function techTable(heading: string, file = 'TECH.md'): TechRow[] {
  const lines = readFileSync(resolve(ROOT, file), 'utf8').split('\n');
  const start = lines.findIndex((line) => line.trim() === `### ${heading}`);
  if (start < 0) throw new Error(`${file} has no "### ${heading}" section.`);
  const rows: TechRow[] = [];
  let seenHeader = false;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6} /.test(line)) break; // the next heading of any level ends the section's own table
    if (!line.startsWith('|')) {
      if (seenHeader) break; // the table has started and this line is not part of it: any later table is not an obligation
      continue;
    }
    if (!seenHeader) {
      seenHeader = true; // the first table line is the column names
      continue;
    }
    // Cells split on " | ": a pipe inside backticks (none today) would need escaping in the source.
    const cells = line
      .replace(/^\|\s*/, '')
      .replace(/\s*\|\s*$/, '')
      .split(/\s+\|\s+/);
    if (cells.length < 4 || /^-+$/.test(cells[0]!)) continue;
    rows.push({
      risk: cells[0]!,
      mechanism: cells[1]!,
      boundary: cells[2]!,
      verification: cells[3]!,
    });
  }
  return rows;
}

/** The CSP the table names: the text between backticks after "CSP". */
export function techCsp(): string {
  const xss = techTable('Security and privacy').find((row) => row.risk === 'XSS');
  const csp = /CSP `([^`]+)`/.exec(xss?.mechanism ?? '')?.[1];
  if (!csp) throw new Error('TECH.md names no CSP in the XSS row.');
  return csp;
}
