// A stand-in for the GitHub CLI in the E6 self-test. Talks by standard output and exit code only: no network, no files.
// Started by the script with `--bin gh=<this file>`. FAKE_GH_SCENARIO=signed-out makes `gh auth token` fail.
const [command, subcommand] = process.argv.slice(2);

if (command === '--version') {
  process.stdout.write(
    'gh version 0.0.0 (fixture)\nhttps://github.com/cli/cli/releases/tag/v0.0.0\n',
  );
} else if (command === 'auth' && subcommand === 'token') {
  if (process.env['FAKE_GH_SCENARIO'] === 'signed-out') {
    process.stderr.write(
      'You are not logged into any GitHub hosts. To log in, run: gh auth login\n',
    );
    process.exitCode = 1;
  } else {
    // Deliberately not token-shaped (test/experiments/lib/secrets.ts), but unmistakable if it ever leaks.
    process.stdout.write('SENTINEL_TOKEN_gh01\n');
  }
} else {
  process.stderr.write('unknown command\n');
  process.exitCode = 1;
}
