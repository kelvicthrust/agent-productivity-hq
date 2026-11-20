import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { watchMutations } from '../../src/server/integrations/claudeHooks/fsguard.ts';
import { BACKUP_SUFFIX } from '../../src/server/integrations/claudeHooks/paths.ts';
import { USER_SETTINGS, asText, read, rig } from './helpers.ts';

// The instants between the last look at a file and the step that uses it (the only window the design leaves; write.ts says so), and the
// rule that nothing outside fsguard.ts changes the file system at all.

const original = asText(USER_SETTINGS);

describe('the instant before a step', () => {
  it('a file that appears where a new settings file is about to be linked is never replaced: the change starts over from it', async () => {
    const r = rig();
    const mine = asText({ mine: true });
    let planted = false;
    const stop = watchMutations((step, phase) => {
      if (phase === 'before' && step.op === 'link' && !planted) {
        planted = true;
        writeFileSync(step.to!, mine);
      }
    });
    try {
      await r.hooks.set(true);
    } finally {
      stop();
    }
    expect(planted).toBe(true);
    // The owner's file was read again and edited: everything of theirs is there, with HQ's entries added.
    expect(JSON.parse(read(r.settings))).toMatchObject({ mine: true });
    expect(read(r.settings)).toContain('agent-productivity-hq-hook');
  });

  it('a staged file swapped after it was checked and before the rename is noticed afterwards and named, never reported as a success', async () => {
    const r = rig({ settings: original });
    const attacker = asText({ attacker: true });
    let swapped = false;
    const stop = watchMutations((step, phase) => {
      if (phase !== 'before' || step.op !== 'rename' || swapped) return;
      if (!step.to!.endsWith('settings.json')) return;
      swapped = true;
      writeFileSync(`${step.path}.x`, attacker, { mode: 0o600 });
      renameSync(`${step.path}.x`, step.path);
    });
    let failure: unknown;
    try {
      await r.hooks.set(true);
    } catch (error) {
      failure = error;
    } finally {
      stop();
    }
    expect(swapped).toBe(true);
    expect(failure).toMatchObject({ failure: 'rollback_failed' });
    // HQ did not claim to have installed anything, and the owner's copy of the original is kept.
    expect(readFileSync(`${r.settings}${BACKUP_SUFFIX}`, 'utf8')).toBe(original);
  });
});

describe('nothing outside fsguard.ts changes the file system', () => {
  const folder = join(import.meta.dirname, '../../src/server/integrations/claudeHooks');
  const MUTATORS =
    /\b(renameSync|linkSync|unlinkSync|rmSync|rmdirSync|chmodSync|fchmodSync|chownSync|fchownSync|writeFileSync|appendFileSync|truncateSync|ftruncateSync|copyFileSync|cpSync|mkdirSync|writeSync|symlinkSync|utimesSync|futimesSync|createWriteStream|mkdtempSync|ensureDir|ensureFile|hardenFiles)\b/;
  it('the other modules neither import nor call a function that creates, writes, renames, links, removes or changes the mode of anything', () => {
    for (const name of readdirSync(folder)) {
      if (!name.endsWith('.ts') || name === 'fsguard.ts') continue;
      const text = readFileSync(join(folder, name), 'utf8');
      // (comments are allowed to name the functions: only code is checked)
      const code = text
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      expect(
        code.match(MUTATORS)?.[0],
        `${name} calls ${code.match(MUTATORS)?.[0]}`,
      ).toBeUndefined();
    }
  });

  it('the only write-capable open outside it is the registry neutraliser, which checks the opened file before it changes it', () => {
    const found: string[] = [];
    for (const name of readdirSync(folder)) {
      if (!name.endsWith('.ts') || name === 'fsguard.ts') continue;
      const text = readFileSync(join(folder, name), 'utf8');
      for (const line of text.split('\n'))
        if (/openSync\(/.test(line) && /O_RDWR|O_WRONLY|O_CREAT|'w|'a/.test(line))
          found.push(`${name}: ${line.trim()}`);
    }
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('ownFiles.ts');
  });
});
