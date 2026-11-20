import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { packDashboard } from './package-dashboard.ts';

if (process.argv.length > 2) throw new Error('Usage: pnpm pack:cli');
const archive = packDashboard('cli');
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(join(dirname(archive), 'SHA256SUMS'), `${digest}  ${basename(archive)}\n`);
