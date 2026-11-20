// A stand-in for `ccusage` for the self-test: answers the two calls E1 makes and nothing else. It talks by standard
// output only, and its report is the oracle file next to it. DRAFT-documented-shape, see README.md.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2).join(' ');

if (args === '--version') {
  process.stdout.write('ccusage 20.0.48\n');
} else if (args === 'claude session --json --offline') {
  process.stdout.write(readFileSync(join(import.meta.dirname, 'oracle.json'), 'utf8'));
} else {
  process.stderr.write(
    'fake-ccusage: only `--version` and `claude session --json --offline` are answered\n',
  );
  process.exitCode = 2;
}
