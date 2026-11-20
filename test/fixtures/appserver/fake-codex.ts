// A stand-in for `codex app-server` in the E4 self-test and the live launcher test. Talks JSON-RPC over stdin and stdout only: no
// network, no files besides the scenario it is told to read. Started with `--bin codex=<this file>` (or as `node <this file>
// app-server`). The scenario format, and what each entry does, is in ./scenario.ts.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createScenarioServer, type Scenario } from './scenario.ts';

if (process.argv[2] !== 'app-server') {
  process.stderr.write('usage: codex app-server\n');
  process.exit(2);
}

const server = createScenarioServer(
  JSON.parse(readFileSync(process.env['FAKE_CODEX_SCENARIO'] ?? '', 'utf8')) as Scenario,
);

createInterface({ input: process.stdin }).on('line', (line) => {
  const step = server.handle(line);
  for (const out of step.lines) process.stdout.write(`${out}\n`);
  // Ends after the lines above are flushed, so a crash scenario still delivers what came before it.
  if (step.exit) process.stdout.write('', () => process.exit(0));
});
