import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AdapterContext } from '../../../src/server/collectors/types.ts';
import { memoryDb, memoryLogger } from '../../server/helpers.ts';
import { fails, gate, holds, partial, scriptedAdapter, skips, succeeds } from './scripted.ts';

const ROOT = join(import.meta.dirname, '../../..');

const context = (): AdapterContext => ({
  db: memoryDb(),
  now: () => 0,
  logger: memoryLogger().logger,
  progress: () => {},
});

describe('scripted adapters', () => {
  it('play their steps in order, and the last one repeats', async () => {
    const adapter = scriptedAdapter('codex', [fails(), succeeds({ imported: 1 })]);
    expect((await adapter.refresh(context())).result).toBe('failed');
    expect(await adapter.refresh(context())).toMatchObject({ result: 'succeeded', imported: 1 });
    expect((await adapter.refresh(context())).result).toBe('succeeded');
    expect(adapter.calls).toBe(3);
    expect(adapter.id).toBe('codex');
  });

  it('build the four kinds of report a source can end with', async () => {
    const adapter = scriptedAdapter('paseo', [
      partial(),
      skips('Not running.'),
      fails({ errorCode: 'x' }),
    ]);
    expect(await adapter.refresh(context())).toMatchObject({ result: 'partial', unreadable: 1 });
    expect(await adapter.refresh(context())).toEqual({
      result: 'skipped',
      message: 'Not running.',
    });
    expect(await adapter.refresh(context())).toMatchObject({ result: 'failed', errorCode: 'x' });
  });

  it('reject when the step is an Error, as a broken adapter would', async () => {
    const adapter = scriptedAdapter('claude', [new Error('broke')]);
    await expect(adapter.refresh(context())).rejects.toThrow('broke');
  });

  it('hold a step until its gate opens, and say when they were called', async () => {
    const opened = gate();
    const adapter = scriptedAdapter('github', [holds(opened, succeeds())]);
    let settled = false;
    const attempt = adapter.refresh(context()).then((report) => {
      settled = true;
      return report;
    });
    await adapter.called();
    await Promise.resolve();
    expect(settled).toBe(false);
    opened.release();
    expect((await attempt).result).toBe('succeeded');
    await expect(adapter.called(1)).resolves.toBeUndefined();
  });

  it('refuse an empty script, which would have nothing to play', () => {
    expect(() => scriptedAdapter('codex', [])).toThrow(/at least one step/);
  });
});

/** Every .ts and .tsx file under `dir`. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe('the product never imports test fixtures', () => {
  it('has no import of test/ or the scripted adapters anywhere under src/', () => {
    const offenders = sourceFiles(join(ROOT, 'src')).filter((file) =>
      /from\s+['"][^'"]*(scripted-adapters|\/test\/|test\/fixtures)[^'"]*['"]/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
