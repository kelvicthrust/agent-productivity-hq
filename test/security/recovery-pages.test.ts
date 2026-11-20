import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  alreadyRunningPage,
  databaseRecoveryPage,
  diskFullPage,
  NOTHING_CHANGED,
  shellQuote,
  type DatabaseRecoveryReason,
} from '../../src/server/http/recovery/index.ts';
import { recoveryPage } from '../../src/server/http/recovery.ts';
import { ROOT } from './techTable.ts';

// The three recovery pages (TECH › Failure modes: DB corrupt or migration fails, second instance, disk full). Each is a pure
// function from facts to HTML. Each says nothing was deleted or changed, says what the owner can do, escapes what it is given, and
// the module that renders it cannot delete, move or rewrite anything because it imports nothing that could.

const HOSTILE = `/Users/o'brien/<img src=x onerror=alert(1)>/"data" & $HOME/agent-productivity.db`;
const REASONS: DatabaseRecoveryReason[] = [
  'corrupt',
  'migration_failed',
  'newer_schema',
  'unreadable',
];

const pages: [string, string, string][] = [
  ...REASONS.map((reason): [string, string, string] => [
    `database (${reason})`,
    databaseRecoveryPage({
      reason,
      dbPath: HOSTILE,
      detail: '<b>damaged</b>',
      migrationFile: '002_<x>.sql',
    }),
    'Move it aside and start fresh',
  ]),
  [
    'already running',
    alreadyRunningPage({ url: 'http://127.0.0.1:4317', lockPath: HOSTILE, pid: 4242 }),
    'What you can do',
  ],
  [
    'not enough disk space',
    diskFullPage({ dataDir: HOSTILE, detail: 'ENOSPC <b>' }),
    'Free some space and start again',
  ],
];

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/g, ' ')
    .replace(/\s+/g, ' ');

describe.each(pages)('the %s page', (_name, html, stepsHeading) => {
  it('is a whole page: language, title, one main landmark, one h1, an ordered list of steps', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toMatch(/<title>Agent Productivity HQ · [^<]+<\/title>/);
    expect(html.match(/<main>/g)).toHaveLength(1);
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html).toContain(`<h2>${stepsHeading}</h2>`);
    expect(html).toMatch(/<ol>[\s\S]*<li>[\s\S]*<\/ol>/);
  });

  it('brands the page above the recovery instructions without loading app assets', () => {
    expect(html).toMatch(/<header><p>Agent Productivity HQ<\/p><\/header>\s*<main>/);
  });

  it('says nothing was deleted or changed', () => {
    expect(NOTHING_CHANGED).toBe('Nothing was deleted or changed.');
    expect(html).toContain(`<strong>${NOTHING_CHANGED}</strong>`);
  });

  it('runs no script and loads nothing: only text tags and one style block, so the app’s CSP allows it', () => {
    const tags = [...html.matchAll(/<([a-z][a-z0-9]*)((?:\s[^>]*)?)>/gi)];
    const allowed = [
      'html',
      'head',
      'meta',
      'title',
      'style',
      'body',
      'header',
      'main',
      'h1',
      'h2',
      'p',
    ];
    allowed.push('strong', 'code', 'pre', 'ol', 'li');
    expect(tags.map((t) => t[1]!).filter((name) => !allowed.includes(name))).toEqual([]);
    const withAttributes = tags.filter((t) => t[2]!.trim() !== '').map((t) => t[1]);
    expect(withAttributes.sort()).toEqual(['html', 'meta', 'meta']);
  });

  it('escapes every value it is given', () => {
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<x>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('what the owner can do', () => {
  it('the database page tells the owner to move the file aside, with a command that survives odd paths', () => {
    const html = databaseRecoveryPage({ reason: 'corrupt', dbPath: HOSTILE, detail: 'damaged' });
    expect(html).toContain(
      `<code>mv ${shellQuote(HOSTILE).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)} `,
    );
    expect(shellQuote(`a'b c`)).toBe(`'a'\\''b c'`);
    expect(text(html)).toContain('-wal and -shm');
    // The names are code that does not break across lines (a browser may break after the hyphen otherwise).
    expect(html).toContain('<code>-wal</code> and <code>-shm</code>');
  });

  it('says what the page the server showed before these pages existed said, and the server now shows it', () => {
    const info = {
      reason: 'corrupt',
      dbPath: '/data/agent-productivity.db',
      detail: 'SQLite reports the file is damaged.',
    } as const;
    const now = text(databaseRecoveryPage(info));
    for (const phrase of [
      'The saved history can’t be read',
      'Agent Productivity HQ started, but it can’t use its database',
      'Nothing was deleted or changed.',
      'SQLite reports the file is damaged.',
      'The database file: /data/agent-productivity.db',
      'Move it aside and start fresh',
      'press Control-C in the terminal that started it',
      'creates a new database and re-imports history from whatever logs still exist',
    ]) {
      expect(now, `database page: ${phrase}`).toContain(phrase);
    }
    // The server's page for a database reason is this renderer, and for a full disk it is the not-enough-disk one.
    expect(recoveryPage(info)).toBe(databaseRecoveryPage(info));
    expect(
      recoveryPage({ reason: 'disk_full', dbPath: '/data/agent-productivity.db', detail: 'Full.' }),
    ).toBe(diskFullPage({ dataDir: '/data', detail: 'Full.' }));
  });

  it('the already-running page points to the running copy without asking the owner to remove its lock', () => {
    const html = alreadyRunningPage({
      url: 'http://127.0.0.1:4317',
      lockPath: '/data/agent-productivity.lock',
    });
    expect(text(html)).toContain('Open the running copy at http://127.0.0.1:4317');
    expect(text(html)).toContain('still starting or shutting down');
    expect(html).not.toContain('<code>rm ');
  });

  it('the disk-full page says to free space and start again, and that what was imported is kept', () => {
    const t = text(diskFullPage({ dataDir: '/data' }));
    expect(t).toContain('Free some space');
    expect(t).toContain('What was already imported is kept');
    expect(t).toContain('The data folder: /data');
  });
});

describe('the pages cannot delete, move or rewrite anything', () => {
  const dir = join(ROOT, 'src/server/http/recovery');
  const files = readdirSync(dir).filter((name) => name.endsWith('.ts'));
  it('has the layout and the three pages', () => {
    expect(files.sort()).toEqual([
      'alreadyRunning.ts',
      'database.ts',
      'diskFull.ts',
      'index.ts',
      'layout.ts',
    ]);
  });
  it.each(files)('%s imports only its siblings, and calls nothing that touches a file', (name) => {
    const source = readFileSync(join(dir, name), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const specifiers = [...source.matchAll(/(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g)].map(
      (m) => m[1]!,
    );
    expect(specifiers.filter((s) => !s.startsWith('./'))).toEqual([]);
    expect(source).not.toMatch(
      /\b(unlink|unlinkSync|rm|rmSync|rmdir|rename|renameSync|writeFile|writeFileSync|appendFile|truncate|copyFile|cp|mkdir|chmod|createWriteStream|openSync|fetch)\s*\(|\bprocess\.|child_process/,
    );
  });
});
