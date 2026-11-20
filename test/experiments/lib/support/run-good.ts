import { runIfMain } from '../../../../scripts/experiments/lib/cli.ts';
import { experiment } from './good.ts';

runIfMain(import.meta, experiment);
