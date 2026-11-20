# Writing an experiment script

Read this before you write `scripts/experiments/e<n>-<name>.ts`. The lib in this folder is the contract: scripts read, report and stop, and the guards here (not good intentions) keep them read-only and metadata-only. `test/experiments` proves it, so a script that breaks a rule fails the harness.

## Shape of a script

```ts
import { defineExperiment, runIfMain } from './lib/cli.ts';
import { safeText } from './lib/redact.ts';
import { FieldInventory } from './lib/shape.ts';

export const experiment = defineExperiment({
  meta: {
    id: 'E1',
    script: 'scripts/experiments/e1-claude.ts',
    title: '…',
    question: '…', // TECH's question, one sentence
    criteria: [{ id: 'reconcile-three-sessions', text: '…' }], // TECH's pass criteria, split so each can be pass, fail or not-run
    reads: ['…'], // exactly what is read, with default paths
    prints: ['…'],
    writes: ['docs/implementation/experiments/E1.md (the findings)'],
    network: [], // hostnames, or '127.0.0.1:6767'
    spawns: [], // program names
    example: 'node scripts/experiments/e1-claude.ts --oracle <file>', // optional
    selftest: [/* see below */],
  },
  async run(ctx) {
    const root = ctx.willRead(
      'Claude Code transcripts',
      ctx.args.get('claude-root') ?? `${ctx.home}/.claude/projects`,
    );
    for (const file of ctx.fs.walk(root, { match: /\.jsonl$/ }).files) {
      for (const line of ctx.fs.lines(file)) {
        /* parse in memory; count; never print */
      }
    }
    ctx.findings.criterion('reconcile-three-sessions', 'pass', safeText`3 of 3 sessions match`);
    ctx.findings.fact('Field list', 'fields seen', 42);
  },
});

runIfMain(import.meta, experiment); // runs only when the file is started directly
```

The harness imports `experiment` by that name. Import only from `./lib/*.ts` (relative to `scripts/experiments/`), plus the Node modules listed in `test/experiments/static.test.ts`.

## What you may do, and how

- **Read** with `ctx.fs` only, after `ctx.willRead(label, path)` has announced the folder. `willRead` prints `Will read: …` and allows reads below that path; anything else throws. There is no write method. `ctx.fs.lines()` streams big JSONL files; `readMaybeCompressed` handles `.zst` and throws `DecoderMissingError` if Node has no zstd decoder, which you report as a fact and a `not-run` criterion (the self-test can force this with `EXPERIMENTS_FORCE_NO_ZSTD=1` in a case's `env`).
- **Start a program** with `ctx.spawn(program, args)` or `ctx.session(program, args)` (line-by-line, for JSON-RPC over stdio). The program must be in `meta.spawns`. No shell is ever used, so pass arguments as an array. `--bin name=path` swaps in another program (a `.ts`/`.js` path runs under Node), which is how the self-test uses a fake `codex` or `gh` kept in your fixture folder. A program that is missing gives `found: false`: report `not-run`, do not crash.
- **Contact a host** with `ctx.fetch(url, init)`: HTTPS only, hostnames in `meta.network` only. `--net-fixture <file>` answers from a file (`{"requests":[{"method","url","bodyIncludes?","once?","response":{"status","json"|"text","headers?"}}]}`) and opens no connection. Anything that uses its own sockets (the Paseo SDK) must take the transport as an injectable and have a fixture-backed fake for the self-test.
- **Write** nothing yourself. The findings file is written by the lib. E8 alone may create a temporary folder with `ctx.workspace.create('crew-e8')` and write only inside it; the hook process reopens it with `openTempWorkspace(dir)` from `./lib/workspace.ts`. Both the findings and the workspace go through `lib/safefile.ts`, which refuses a symbolic link, a hard link or anything but a regular file at the name it writes. Never copy settings or credentials into the workspace: a seed file may only lend the short list of plain preferences in `plainSeed` (E8), and the sentinel test scans every file a case writes below its temp folder.
- **Hook (E8 only).** The status-line hook runs inside Claude Code, not through the CLI. Put `runHookIfMain(import.meta, ({ stdin, workspace, args }) => { … })` (from `./lib/cli.ts`) above `runIfMain`: when the file is started with `--hook --dir <workspace>`, it reads standard input (at most 1 MB), calls your handler, prints nothing and always exits 0. `workspace()` opens only a folder an experiment script created under the temp folder (`ctx.workspace.create`), and `append` is the only way it writes. Record field names, numbers and hashed ids from the input, never text, paths or credentials. `runIfMain` does nothing when `--hook` is present.
- **Print** with `ctx.out.line(text)` only. It throws on token-shaped text. Never print a line, title, prompt, path, token or any value from the data you read: print counts, field names, versions and verdicts.
- **Report** with `ctx.findings`: `criterion(id, verdict, detail?)`, `fact(section, label, value)` (numbers, booleans, identifier-shaped strings or arrays of them; anything else becomes a marker), `note(text)`, `tool(name, version)`. Build detail and note text with the `safeText` tag so any string you interpolate is checked. A criterion you do not set is reported as `not-run`. `FieldInventory` (`./lib/shape.ts`) gives the field list of many records with no values, and folds data-like keys into `*`.

## Rules the harness enforces

1. No `node:fs`, `node:child_process`, `node:net`, `node:http(s)`, `fetch(` or `eval` in a script file, and no write-style call names. The lib owns all of that.
2. Every source you read is announced first, and `meta.reads` says the same thing in words. The self-test checks that every program started is in `meta.spawns` and every host contacted is in `meta.network`.
3. The first self-test case is a world in which every criterion has an expected verdict (all of them named). Add cases for each failure mode TECH names (a one-token mismatch, a missing parent, a missing decoder, unreadable lines, a missing tool). Mix of `pass`, `fail` and `not-run` across cases.
4. Exit codes: 0 no criterion failed, 1 at least one failed, 2 the script stopped (bad flags, a read outside the announced folders, a leak).
5. Fixtures (below) never trip the sentinel test: no `SENTINEL_` string may appear in stdout, stderr, the findings file or the result JSON.

## Fixtures

Each fixture folder under `test/fixtures/` (`claude`, `codex`, `paseo`, `appserver`, `github`, `statusline`) must:

- carry a `README.md` that says `DRAFT-documented-shape` and names the TECH or `docs/tech/` section each file's shape comes from, and says that real values replace the invented ones once the experiment confirms the field list;
- hold invented values only: no real prompt, response, path outside the repo (no `/Users/…` or `/home/…`), or credential, and **no token-shaped value at all** (no `ghp_…`, `sk-…`, JWTs, `Bearer …`): use `SENTINEL_TOKEN_x`, which is deliberately not token-shaped. The secret scan also flags the keys `access_token`, `refresh_token` and `id_token` followed by a value of 12 or more token characters, so `"access_token": "SENTINEL_TOKEN_x"` is refused; a fixture that needs such a key writes `<SENTINEL_TOKEN_x>` or leaves the key out;
- contain `SENTINEL_<WORD>_<hex>` strings wherever real data would hold message text, titles, prompts, branch names, PR bodies or secrets, so the sentinel test can prove your script never prints them;
- stay small: hand-written, each file under 64 KB and the folder under 512 KB.

Fake programs for the self-test (`fake-codex.ts`, `fake-gh.ts`) live in the matching fixture folder and talk by stdout and stdin only.

## Run it

```sh
pnpm exec vitest run test/experiments/selftest.test.ts -t 'E1'
pnpm exec vitest run test/experiments/sentinel.test.ts -t 'E1'
pnpm typecheck
node scripts/experiments/e1-claude.ts --help
```

Do not edit `scripts/experiments/lib/`, `test/experiments/` or `docs/implementation/experiments/README.md`: they are the captain's. If the contract is missing something you need, say so in your return and work within it. The runbook is generated from your `meta` by the captain.
