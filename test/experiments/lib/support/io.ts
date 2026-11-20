import type { Io } from '../../../../scripts/experiments/lib/cli.ts';

/** An Io that records output, for running an experiment in-process. */
export function captureIo(
  env: Record<string, string | undefined> = {},
): Io & { out: string[]; err: string[]; stdoutText(): string; stderrText(): string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    env,
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
    stdoutText: () => out.join(''),
    stderrText: () => err.join(''),
  };
}
