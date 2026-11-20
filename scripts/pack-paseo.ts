import { packDashboard } from './package-dashboard.ts';

if (process.argv.length > 2) throw new Error('Usage: pnpm pack:paseo');
packDashboard('paseo');
