import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../server/helpers.ts';
import { history, startMachine } from './helpers.ts';

// `pnpm bench` (C10, TECH › Performance): an incremental refresh with no new data takes at most 3 seconds, on a machine that holds a
// real year of history: here more than 2,000 small files for EACH provider. Only the refresh with nothing new is timed; the first
// import is the setup (it is reported, not asserted). The timed refresh is the whole run as the Refresh button starts it:
// discovery, both adapters (one listing and one stat per file, no read), and retention.
//
// The files are generated, small and INVENTED: no real transcript is read and nothing leaves this machine.

const BUDGET_MS = 3000;
const PER_PROVIDER = 2200;
const PROJECTS = 40;

const hex = (n: number, width: number) => n.toString(16).padStart(width, '0');
const uuid = (n: number) => `${hex(n, 8)}-aaaa-4aaa-8aaa-${hex(n, 12)}`;

/** One Claude Code transcript: a prompt and two assistant messages with usage. */
function claudeTranscript(n: number): string {
  const id = uuid(n);
  const day = String(1 + (n % 28)).padStart(2, '0');
  const base = { sessionId: id, cwd: `/bench/project-${n % PROJECTS}`, version: '2.0.0' };
  return [
    {
      ...base,
      type: 'user',
      timestamp: `2026-10-${day}T08:00:00.000Z`,
      message: { role: 'user', content: 'x' },
    },
    ...[1, 2].map((turn) => ({
      ...base,
      type: 'assistant',
      timestamp: `2026-10-${day}T08:00:0${turn}.000Z`,
      requestId: `req_${n}_${turn}`,
      message: {
        id: `msg_${n}_${turn}`,
        model: 'claude-sonnet-4-5',
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 300,
          output_tokens: 40 * turn,
        },
      },
    })),
  ]
    .map((line) => JSON.stringify(line))
    .join('\n')
    .concat('\n');
}

/** One Codex rollout: its meta line and two cumulative token counts. */
function codexRollout(n: number): { path: string; text: string } {
  const id = uuid(n + 1_000_000);
  const day = String(1 + (n % 28)).padStart(2, '0');
  const stamp = `2026-10-${day}T09:00:00.000Z`;
  const count = (turn: number) => ({
    timestamp: `2026-10-${day}T09:00:0${turn}.000Z`,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 1000 * turn,
          cached_input_tokens: 600 * turn,
          output_tokens: 100 * turn,
          reasoning_output_tokens: 20 * turn,
          total_tokens: 1100 * turn,
        },
      },
    },
  });
  const lines = [
    {
      timestamp: stamp,
      type: 'session_meta',
      payload: { id, timestamp: stamp, cwd: `/bench/project-${n % PROJECTS}`, source: 'cli' },
    },
    {
      timestamp: `2026-10-${day}T09:00:00.500Z`,
      type: 'turn_context',
      payload: { model: 'gpt-5-codex' },
    },
    count(1),
    count(2),
  ];
  return {
    path: join('sessions', '2026', '10', day, `rollout-2026-10-${day}T09-00-00-${id}.jsonl`),
    text: lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
  };
}

function generate(home: string): void {
  for (let n = 0; n < PER_PROVIDER; n++) {
    const project = join(home, '.claude/projects', `-bench-project-${n % PROJECTS}`);
    if (n < PROJECTS) mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${uuid(n)}.jsonl`), claudeTranscript(n));

    const rollout = codexRollout(n);
    const target = join(home, '.codex', rollout.path);
    if (n < 28) mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, rollout.text);
  }
}

describe('a refresh with no new data (C10)', () => {
  it(`takes at most ${BUDGET_MS} ms with ${PER_PROVIDER} files for each of Codex and Claude Code`, async () => {
    const home = tempDir();
    generate(home);
    const m = startMachine({ home, dbPath: join(tempDir(), 'agent-productivity.db') });

    const importStart = performance.now();
    const first = await m.refresh();
    const importMs = performance.now() - importStart;
    expect(first.state).toBe('succeeded');
    expect(first.sources['codex']).toMatchObject({ state: 'succeeded', imported: PER_PROVIDER });
    expect(first.sources['claude']).toMatchObject({ state: 'succeeded', imported: PER_PROVIDER });
    const stored = history(m.db);

    // The slowest of three, so one lucky run cannot pass for the rule.
    const timings: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      m.tick(15 * 60_000);
      const started = performance.now();
      const run = await m.refresh();
      timings.push(performance.now() - started);
      expect(run.state).toBe('succeeded');
      expect(run.sources['codex']).toMatchObject({ imported: 0, duplicatesSkipped: 0 });
      expect(run.sources['claude']).toMatchObject({ imported: 0, duplicatesSkipped: 0 });
    }
    const slowest = Math.max(...timings);
    console.info(
      `no-new-data refresh, ${2 * PER_PROVIDER} files: ${timings.map((ms) => `${Math.round(ms)} ms`).join(', ')} (first import ${Math.round(importMs)} ms)`,
    );

    // Nothing was read and nothing was written: the file rows still carry the first import's `last_read_at`.
    expect(history(m.db)).toEqual(stored);
    expect(stored.files).toHaveLength(2 * PER_PROVIDER);
    expect(slowest).toBeLessThanOrEqual(BUDGET_MS);
    m.close();
  });
});
