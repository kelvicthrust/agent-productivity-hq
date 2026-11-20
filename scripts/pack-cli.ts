import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { packDashboard } from './package-dashboard.ts';

if (process.argv.length > 2) throw new Error('Usage: pnpm pack:cli');
const root = resolve(import.meta.dirname, '..');
const archive = packDashboard('cli');
const archiveName = basename(archive);
const output = dirname(archive);
const version = /^kelvicthrust-agent-productivity-hq-(.+)\.tgz$/.exec(archiveName)?.[1];
if (!version) throw new Error(`Unexpected CLI archive name: ${archiveName}`);

const kitName = `agent-productivity-hq-skills-${version}.tar.gz`;
const kit = join(output, kitName);
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const archiveChecksum = `${digest(archive)}  ${archiveName}\n`;

const scratch = mkdtempSync(join(tmpdir(), 'agent-productivity-hq-skill-'));
try {
  const skill = join(scratch, 'agent-productivity-hq');
  mkdirSync(skill);
  for (const file of ['SKILL.md', 'LICENSE'])
    copyFileSync(join(root, 'skills/agent-productivity-hq', file), join(skill, file));
  copyFileSync(
    join(root, 'scripts/install-agent-productivity-hq-skill.sh'),
    join(scratch, 'install-agent-productivity-hq-skill.sh'),
  );
  writeFileSync(join(scratch, 'CLI-SHA256SUM'), archiveChecksum);
  writeFileSync(
    join(skill, 'private-rc.md'),
    [
      '# Open the private release candidate',
      '',
      'Run this on Apple Silicon macOS with Node 22.x (22.16.0+) or any stable 24.0.0+.',
      '',
      '```sh',
      `npx --offline --yes --package="$HOME/Library/Application Support/Agent Productivity Beta/${archiveName}" agent-productivity-hq`,
      '```',
      '',
      'Append `stop` only for an explicit request to stop the dashboard.',
      'If the archive is missing, ask the user to run the private release candidate skill installer again.',
      '',
    ].join('\n'),
  );
  execFileSync('tar', [
    '-czf',
    kit,
    '-C',
    scratch,
    'agent-productivity-hq',
    'install-agent-productivity-hq-skill.sh',
    'CLI-SHA256SUM',
  ]);
  writeFileSync(join(output, 'SHA256SUMS'), `${archiveChecksum}${digest(kit)}  ${kitName}\n`);
  console.log(kitName);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
