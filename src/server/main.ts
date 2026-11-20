import { AlreadyRunningError, PortInUseError, boot } from './boot.ts';
import { ConfigError, loadConfig } from './lib/config.ts';
import { alreadyRunningMessage } from './lib/instance.ts';
import { liveBootDeps } from './live.ts';

// `pnpm start`: the local server. It binds 127.0.0.1 only (the port is AGENT_PRODUCTIVITY_PORT, default 4317). It reads this Mac's Codex and
// Claude Code history by itself (no folder picker): `local` below is what makes the two real adapters and discovery exist.

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
}

try {
  const server = await boot(config, liveBootDeps());
  if (server.mode === 'already_running') {
    // Another copy holds this data folder and this process's own port is a different, free one: it only points to the running copy.
    console.log(
      `Agent Productivity HQ is already running. This copy answers at ${server.url} only to say so; open that address for where it is.`,
    );
  } else if (server.recovery) {
    console.log(
      `Agent Productivity HQ started at ${server.url}, but it can’t use its database. Open the address for what to do.\n` +
        `${server.recovery.detail}\nThe file was not changed: ${server.recovery.dbPath}`,
    );
  } else {
    console.log(`Agent Productivity HQ is running at ${server.url}`);
  }

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) process.exit(1); // a second signal means "now"
    stopping = true;
    console.log(`\n${signal} received: stopping.`);
    void server.shutdown().then(() => process.exit(0));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
} catch (error) {
  if (error instanceof AlreadyRunningError) {
    // Not a failure: the app is up. Exit 0 so `pnpm start && …` still carries on.
    console.log(
      alreadyRunningMessage(error.port === null ? null : { port: error.port }, error.lockPath),
    );
    process.exit(0);
  }
  console.error(
    error instanceof PortInUseError
      ? error.message
      : `Could not start: ${(error as Error).message}`,
  );
  process.exit(1);
}
