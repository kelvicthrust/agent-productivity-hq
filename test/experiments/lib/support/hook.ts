import { runHookIfMain } from '../../../../scripts/experiments/lib/cli.ts';

// A hook the way E8 writes one: reads stdin, records a sample inside the workspace it was given, prints nothing.
runHookIfMain(import.meta, ({ stdin, workspace, args }) => {
  if (args.has('boom')) throw new Error('hook failure SENTINEL_HOOK_1');
  workspace().append('samples.jsonl', `${JSON.stringify({ bytes: stdin.length })}\n`);
});
