import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AppServerProcess,
  LaunchAppServer,
  NextLine,
} from '../../../src/server/collectors/chatgpt/ports.ts';
import { createScenarioServer, type Scenario } from '../../fixtures/appserver/scenario.ts';

// A scripted `codex app-server` that starts nothing: the port the collector, the sign-in and the routes are given in every test. It
// answers from a scenario (test/fixtures/appserver/*.json, interpreted by the same code as the stand-in child process) and records
// what the client did, so a test can say what was sent, in what order, how long the client was willing to wait, and whether the
// child was killed.
//
// Time is virtual. A child that has nothing to say answers `nextLine` with a timeout AT ONCE (the client "waited" the time it asked
// for, and the test records how long that was); with `hold` it waits until the test writes a line or the child is killed, which is
// how a browser sign-in that is still pending is told.

const FIXTURES = join(import.meta.dirname, '../../fixtures/appserver');

/** A scenario from test/fixtures/appserver, by file name without `.json`. */
export function loadScenario(name: string): Scenario {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as Scenario;
}

/** A scenario with some methods replaced. */
export function withMethods(base: Scenario, methods: Scenario['methods']): Scenario {
  return { ...base, methods: { ...base.methods, ...methods } };
}

export interface Received {
  id?: number | string;
  method?: string;
  params?: unknown;
}

export interface ScriptedChild extends AppServerProcess {
  /** Every line the client wrote, parsed, in order (requests and notifications). */
  readonly received: Received[];
  /** The `timeoutMs` of every `nextLine` call: how long the client was willing to wait each time. */
  readonly waits: number[];
  readonly killed: boolean;
  /** The child writes a line, as if the app-server sent it. */
  emit(message: unknown): void;
  /** The methods the client called, in order. */
  methods(): string[];
}

export interface Scripted {
  launch: LaunchAppServer;
  /** Every child started, in order. */
  readonly children: ScriptedChild[];
  /** How many times the client tried to start the program. */
  readonly launches: () => number;
}

export interface ScriptedOptions {
  /** nextLine waits for a line instead of timing out at once. */
  hold?: boolean;
  /** Starting the program fails with this system error code (a broken install), instead of starting. */
  failWith?: string;
}

/** `scenario: null` is a machine with no `codex`: the launcher answers null. */
export function scriptedAppServer(
  scenario: Scenario | null,
  options: ScriptedOptions = {},
): Scripted {
  const children: ScriptedChild[] = [];
  let launches = 0;

  const launch: LaunchAppServer = async () => {
    launches += 1;
    if (options.failWith !== undefined) {
      throw Object.assign(new Error('spawn failed'), { code: options.failWith });
    }
    if (scenario === null) return null;
    const server = createScenarioServer(scenario);
    const queue: string[] = [];
    let ended = false;
    let killed = false;
    let wake: (() => void) | null = null;
    const poke = (): void => {
      const waiting = wake;
      wake = null;
      waiting?.();
    };
    const received: Received[] = [];
    const waits: number[] = [];

    const child: ScriptedChild = {
      received,
      waits,
      get killed() {
        return killed;
      },
      send(line) {
        if (killed) return;
        received.push(JSON.parse(line) as Received);
        const step = server.handle(line);
        queue.push(...step.lines);
        if (step.exit) ended = true;
        poke();
      },
      async nextLine(timeoutMs): Promise<NextLine> {
        waits.push(timeoutMs);
        for (;;) {
          const line = queue.shift();
          if (line !== undefined) return { kind: 'line', line };
          if (ended || killed) return { kind: 'closed' };
          if (!options.hold) return { kind: 'timeout' };
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
      kill() {
        killed = true;
        poke();
      },
      emit(message) {
        queue.push(JSON.stringify(message));
        poke();
      },
      methods: () => received.flatMap((message) => (message.method ? [message.method] : [])),
    };
    children.push(child);
    return child;
  };

  return { launch, children, launches: () => launches };
}
