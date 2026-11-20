import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'vite';

// Shared by the scripts that load the built app (preview:seed, capture-fidelity): build it if it is missing or older than
// what it is built from. Runs under Node's built-in TypeScript support: erasable syntax, explicit .ts import extensions.

/** True when the built SPA is missing or any file it is built from is newer than it. */
export function needsBuild(root: string): boolean {
  const index = join(root, 'dist/client/index.html');
  if (!existsSync(index)) return true;
  const built = statSync(index).mtimeMs;
  const newest = (path: string): number => {
    if (!existsSync(path)) return 0;
    const stat = statSync(path);
    if (!stat.isDirectory()) return stat.mtimeMs;
    return Math.max(0, ...readdirSync(path).map((name) => newest(join(path, name))));
  };
  return [
    'src/client',
    'src/shared',
    'index.html',
    'vite.config.ts',
    'package.json',
    'pnpm-lock.yaml',
  ].some((rel) => newest(join(root, rel)) > built);
}

/** Builds dist/client when it is stale. A preview is a production build, whatever NODE_ENV the shell exported. */
export async function ensureBuilt(root: string, say: (message: string) => void): Promise<void> {
  if (!needsBuild(root)) return;
  say('Building the app (dist/client is missing or out of date)…');
  process.env['NODE_ENV'] = 'production';
  await build({ root, logLevel: 'warn' });
}
