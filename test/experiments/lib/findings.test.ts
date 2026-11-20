import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import * as prettier from 'prettier';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FindingsBuilder,
  renderFindings,
  writeFindings,
  writeResultJson,
} from '../../../scripts/experiments/lib/findings.ts';
import { UnsafeFileError } from '../../../scripts/experiments/lib/safefile.ts';
import { LeakError } from '../../../scripts/experiments/lib/secrets.ts';
import type { RunTrace } from '../../../scripts/experiments/lib/types.ts';
import { cleanupTmp, makeTmp } from '../harness.ts';
import { experiment } from './support/good.ts';

afterAll(cleanupTmp);

const TRACE: RunTrace = {
  filesRead: 3,
  bytesRead: 120,
  programsStarted: ['gh'],
  hostsContacted: [],
  workspaceFolders: 0,
};
const builder = () =>
  new FindingsBuilder(experiment.meta, () => Date.parse('2026-11-08T12:00:00Z'));

// Some of these tests create a file with an explicit mode (0644, 0640) and read the mode back, so they need the usual umask: a shell
// with umask 077 would mask the group and other bits and the file would read back as 0600. The assertions are unchanged; only the
// process umask is fixed while this file runs (the same save-and-restore test/server/boot.test.ts uses).
let previousUmask = 0;
beforeAll(() => {
  previousUmask = process.umask(0o022);
});
afterAll(() => {
  process.umask(previousUmask);
});

describe('FindingsBuilder', () => {
  it('reports every criterion, with not-run for any the script did not set', () => {
    const b = builder();
    b.criterion('reads-lines', 'pass', '5 lines');
    const doc = b.build(TRACE);
    expect(doc.criteria.map((c) => [c.id, c.verdict])).toEqual([
      ['reads-lines', 'pass'],
      ['program-ran', 'not-run'],
      ['host-answered', 'not-run'],
    ]);
    expect(doc.overall).toBe('pass');
    expect(doc.ranAt).toBe('2026-11-08T12:00:00.000Z');
  });

  it('is fail if any criterion failed, and not-run only when none passed', () => {
    const failing = builder();
    failing.criterion('reads-lines', 'pass');
    failing.criterion('program-ran', 'fail');
    expect(failing.build(TRACE).overall).toBe('fail');
    expect(builder().build(TRACE).overall).toBe('not-run');
  });

  it('rejects a criterion the script did not declare', () => {
    expect(() => builder().criterion('made-up', 'pass')).toThrow(/Unknown criterion/);
  });

  it('keeps only metadata in facts: other strings become markers, numbers are finite', () => {
    const b = builder();
    b.fact('Facts', 'version', '2.1.0');
    b.fact('Facts', 'title', 'SENTINEL_TITLE with words');
    b.fact('Facts', 'ratio', Number.POSITIVE_INFINITY);
    b.fact('Facts', 'fields', ['a', 'SENTINEL list with spaces']);
    b.tool('claude', '2.1.0 (Claude Code)');
    const doc = b.build(TRACE);
    expect(doc.facts.map((f) => f.value)).toEqual([
      '2.1.0',
      '[string:25]',
      -1,
      ['a', '[string:25]'],
    ]);
    expect(doc.environment.tools['claude']).toBe('[string:19]');
    expect(JSON.stringify(doc)).not.toContain('SENTINEL');
  });

  it('accepts only plain short labels', () => {
    const b = builder();
    expect(() => b.fact('Facts', 'a label\nwith a newline', 1)).toThrow(TypeError);
    expect(() => b.fact('x'.repeat(100), 'ok', 1)).toThrow(TypeError);
  });

  it('flattens detail text to one safe line', () => {
    const b = builder();
    b.criterion('reads-lines', 'pass', 'line one\nline two\u0000 and “quotes”');
    expect(b.build(TRACE).criteria[0]?.detail).toBe('line one line two and quotes');
  });
});

describe('the findings file', () => {
  const doc = (() => {
    const b = builder();
    b.criterion('reads-lines', 'pass', safeDetail());
    b.criterion('program-ran', 'fail', 'exit 1');
    b.fact('Field list', 'fields', ['message.usage', 'type']);
    b.fact('Field list', 'lines', 12);
    b.note('One note.');
    b.tool('gh', '2.80.0');
    return b.build(TRACE);
  })();

  function safeDetail(): string {
    return '12 lines, 0 unreadable';
  }

  it('renders lists only, with every section a reader needs', () => {
    const text = renderFindings(doc);
    expect(text).toContain('# E1 · Support experiment');
    expect(text).toContain('- Result: **FAIL** (1 of 3 criteria not run)');
    expect(text).toContain(
      '- **PASS** `reads-lines` — It reads at least one line. 12 lines, 0 unreadable',
    );
    expect(text).toContain('- **FAIL** `program-ran`');
    expect(text).toContain('- **NOT RUN** `host-answered`');
    expect(text).toContain('## Field list\n\n- fields: message.usage, type\n- lines: 12');
    expect(text).toContain('- Programs started: gh');
    expect(text).toContain('- Hosts contacted: none');
    expect(text).toContain('Metadata only');
    expect(text).not.toMatch(/^\|/m);
  });

  it('is already formatted the way Prettier would write it, so format:check stays green after an owner run', async () => {
    const text = renderFindings(doc);
    const config =
      (await prettier.resolveConfig(
        join(process.cwd(), 'docs/implementation/experiments/E1.md'),
      )) ?? {};
    expect(await prettier.format(text, { ...config, parser: 'markdown' })).toBe(text);
  });

  it('writes exactly <id>.md, and refuses another name', () => {
    const dir = makeTmp();
    expect(() => writeFindings(doc, join(dir, 'notes.md'))).toThrow(/must be named E1\.md/);
    expect(readdirSync(dir)).toEqual([]);
    const path = writeFindings(doc, join(dir, 'nested', 'E1.md'));
    expect(readFileSync(path, 'utf8')).toBe(renderFindings(doc));
    writeResultJson(doc, join(dir, 'result.json'));
    expect(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')).id).toBe('E1');
  });

  it('refuses to write through a symlink or a hard link at the findings name, and leaves the other file alone', () => {
    const dir = makeTmp();
    const outside = join(dir, 'outside.txt');
    writeFileSync(outside, 'precious\n');
    const folder = join(dir, 'out');
    mkdirSync(folder);
    symlinkSync(outside, join(folder, 'E1.md'));
    expect(() => writeFindings(doc, join(folder, 'E1.md'))).toThrow(UnsafeFileError);
    symlinkSync(outside, join(folder, 'result.json'));
    expect(() => writeResultJson(doc, join(folder, 'result.json'))).toThrow(UnsafeFileError);
    const hard = join(dir, 'hard');
    mkdirSync(hard);
    linkSync(outside, join(hard, 'E1.md'));
    expect(() => writeFindings(doc, join(hard, 'E1.md'))).toThrow(/hard link/);
    const dangling = join(dir, 'dangling');
    mkdirSync(dangling);
    symlinkSync(join(dir, 'never-created.txt'), join(dangling, 'E1.md'));
    expect(() => writeFindings(doc, join(dangling, 'E1.md'))).toThrow(UnsafeFileError);
    expect(readFileSync(outside, 'utf8')).toBe('precious\n');
    expect(existsSync(join(dir, 'never-created.txt'))).toBe(false);
  });

  it('replaces an existing findings file in place and keeps mode 0644 for a new one', () => {
    const dir = makeTmp();
    writeFileSync(join(dir, 'E1.md'), 'old run\n');
    writeFindings(doc, join(dir, 'E1.md'));
    expect(readFileSync(join(dir, 'E1.md'), 'utf8')).toBe(renderFindings(doc));
    const fresh = writeFindings(doc, join(dir, 'new', 'E1.md'));
    expect(statSync(fresh).mode & 0o777).toBe(0o644);
  });

  it('refuses to write a token-shaped value anywhere in the file, and writes nothing', () => {
    const dir = makeTmp();
    for (const bad of [`value ghp_${'A'.repeat(36)}`, 'Bearer abcdefghijklmnop']) {
      const b = builder();
      b.note(bad);
      expect(() => writeFindings(b.build(TRACE), join(dir, 'E1.md'))).toThrow(LeakError);
    }
    expect(existsSync(join(dir, 'E1.md'))).toBe(false);
  });
});
