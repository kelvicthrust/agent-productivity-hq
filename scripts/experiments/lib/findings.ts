import { mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { identifierOrMarker, isIdentifier, marker } from './redact.ts';
import { writeFileNoFollow } from './safefile.ts';
import { assertNoSecrets } from './secrets.ts';
import type {
  ExperimentMeta,
  Fact,
  FindingsCriterion,
  FindingsDoc,
  FindingsFact,
  FindingsSink,
  RunTrace,
  Verdict,
} from './types.ts';

// The findings file (docs/implementation/experiments/E#.md) holds metadata only: field names, counts, versions, gaps in
// time, pass or fail. The builder takes numbers, booleans and identifier-shaped strings; anything else becomes a marker,
// and the finished text is checked for token-shaped values before a byte is written.

const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._:()/,%+-]{0,79}$/;
const MAX_TEXT = 300;

function cleanText(text: string): string {
  // Printable ASCII and a few typographic marks only; control characters and newlines cannot smuggle structure.
  return text
    .replace(/[^\x20-\x7e·—–’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}

function cleanFact(value: Fact): Fact {
  if (typeof value === 'number') return Number.isFinite(value) ? value : -1;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return identifierOrMarker(value);
  if (value.length > 0 && typeof value[0] === 'number')
    return (value as number[]).slice(0, 200).map((n) => (Number.isFinite(n) ? n : -1));
  return (value as string[]).slice(0, 200).map((s) => identifierOrMarker(s));
}

export class FindingsBuilder implements FindingsSink {
  readonly #meta: ExperimentMeta;
  readonly #now: () => number;
  readonly #criteria = new Map<string, FindingsCriterion>();
  readonly #facts: FindingsFact[] = [];
  readonly #notes: string[] = [];
  readonly #tools: Record<string, string> = {};

  constructor(meta: ExperimentMeta, now: () => number) {
    this.#meta = meta;
    this.#now = now;
  }

  tool(name: string, version: string): void {
    if (!isIdentifier(name)) throw new TypeError('tool name must be an identifier');
    this.#tools[name] = identifierOrMarker(version);
  }

  criterion(id: string, verdict: Verdict, detail?: string): void {
    const known = this.#meta.criteria.find((c) => c.id === id);
    if (!known) throw new Error(`Unknown criterion "${id}" for ${this.#meta.id}`);
    this.#criteria.set(id, {
      id,
      text: known.text,
      verdict,
      ...(detail ? { detail: cleanText(detail) } : {}),
    });
  }

  fact(section: string, label: string, value: Fact): void {
    if (!LABEL.test(section) || !LABEL.test(label))
      throw new TypeError(
        `Fact section and label must be short plain text (got "${marker(section)}", "${marker(label)}")`,
      );
    this.#facts.push({ section, label, value: cleanFact(value) });
  }

  note(text: string): void {
    this.#notes.push(cleanText(text));
  }

  build(trace: RunTrace): FindingsDoc {
    const criteria = this.#meta.criteria.map(
      (c): FindingsCriterion =>
        this.#criteria.get(c.id) ?? {
          id: c.id,
          text: c.text,
          verdict: 'not-run',
          detail: 'Not evaluated in this run.',
        },
    );
    const overall: Verdict = criteria.some((c) => c.verdict === 'fail')
      ? 'fail'
      : criteria.some((c) => c.verdict === 'pass')
        ? 'pass'
        : 'not-run';
    return {
      id: this.#meta.id,
      title: this.#meta.title,
      ranAt: new Date(this.#now()).toISOString(),
      overall,
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        tools: { ...this.#tools },
      },
      criteria,
      facts: [...this.#facts],
      notes: [...this.#notes],
      trace,
    };
  }
}

const WORD: Record<Verdict, string> = { pass: 'PASS', fail: 'FAIL', 'not-run': 'NOT RUN' };
export const verdictWord = (v: Verdict): string => WORD[v];

const list = (items: string[]): string => (items.length > 0 ? items.join(', ') : 'none');

function renderValue(value: Fact): string {
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : 'none';
  return String(value);
}

/** Markdown with lists only (no tables), so Prettier leaves it exactly as written. */
export function renderFindings(doc: FindingsDoc): string {
  const lines: string[] = [];
  const out = (line = '') => lines.push(line);
  out(`# ${doc.id} · ${doc.title}`);
  out();
  out(
    '<!-- Metadata only: field names, counts, versions, time gaps and pass or fail. No message text, token or credential is recorded. -->',
  );
  out();
  const notRun = doc.criteria.filter((c) => c.verdict === 'not-run').length;
  out(
    `- Result: **${WORD[doc.overall]}**${notRun > 0 ? ` (${notRun} of ${doc.criteria.length} criteria not run)` : ''}`,
  );
  out(`- Ran at: ${doc.ranAt}`);
  out(
    `- Environment: Node ${doc.environment.node} · ${doc.environment.platform} · ${doc.environment.arch}`,
  );
  const tools = Object.entries(doc.environment.tools).map(
    ([name, version]) => `${name} ${version}`,
  );
  out(`- Tools: ${list(tools)}`);
  out();
  out('## Criteria');
  out();
  for (const c of doc.criteria)
    out(`- **${WORD[c.verdict]}** \`${c.id}\` — ${c.text}${c.detail ? ` ${c.detail}` : ''}`);
  const sections = [...new Set(doc.facts.map((f) => f.section))];
  for (const section of sections) {
    out();
    out(`## ${section}`);
    out();
    for (const f of doc.facts.filter((x) => x.section === section))
      out(`- ${f.label}: ${renderValue(f.value)}`);
  }
  if (doc.notes.length > 0) {
    out();
    out('## Notes');
    out();
    for (const n of doc.notes) out(`- ${n}`);
  }
  out();
  out('## What this run touched');
  out();
  out(`- Files read: ${doc.trace.filesRead} (${doc.trace.bytesRead} bytes)`);
  out(`- Programs started: ${list(doc.trace.programsStarted)}`);
  out(`- Hosts contacted: ${list(doc.trace.hostsContacted)}`);
  out(`- Temporary folders created: ${doc.trace.workspaceFolders}`);
  out();
  return lines.join('\n');
}

/** Writes `<dir>/<id>.md`, refusing any text that looks like a token or credential. */
export function writeFindings(doc: FindingsDoc, path: string): string {
  if (basename(path) !== `${doc.id}.md`)
    throw new Error(`The findings file must be named ${doc.id}.md`);
  const text = renderFindings(doc);
  assertNoSecrets(text, 'write the findings file');
  mkdirSync(dirname(path), { recursive: true });
  writeFileNoFollow(path, text, 0o644);
  return path;
}

/** Writes the structured result next to the findings (used by the selftest). */
export function writeResultJson(doc: FindingsDoc, path: string): string {
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  assertNoSecrets(text, 'write the result file');
  mkdirSync(dirname(path), { recursive: true });
  writeFileNoFollow(path, text, 0o644);
  return path;
}
