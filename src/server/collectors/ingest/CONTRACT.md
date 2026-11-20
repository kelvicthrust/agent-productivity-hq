# Local-history adapters: the shared contract

Written by the M5 captain before the Codex and Claude Code adapters. Both follow it, so the two behave the same where their
formats do not differ and `discovery.ts` / the runner can treat them alike. TECH.md and `docs/tech/data-and-sources.md` stay the
authority for what the formats mean; this file says how an adapter is shaped. Import from `./ingest/index.ts` (or
`../ingest/index.ts`); the SQL is in `src/server/db/queries/ingest.ts` and `usage.ts` (`upsertSession`).

## Shape

```ts
// src/server/collectors/claude/index.ts
export function createClaudeAdapter(options: {
  configDirs: () => readonly string[];
}): SourceAdapter; // id 'claude'
// src/server/collectors/codex/index.ts
export function createCodexAdapter(options: { homes: () => readonly string[] }): SourceAdapter; // id 'codex'
```

The adapter is given the folders to look in and never reads environment variables or `os.homedir()` itself: `discovery.ts` (A20)
resolves `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and the defaults and passes them in; tests pass fixture folders. A Claude config dir
holds `projects/`; a Codex home holds `sessions/` and `archived_sessions/`. The functions are called at the start of every attempt,
so a changed override is seen without a restart.

## One attempt (`refresh(context)`)

1. **Roots.** `listFiles(root, accept)` for each root of each config dir or home. `state` is `ok`, `notfound` or `denied`/`failed`.
   - Every root `notfound`, and nothing tracked in `source_file` for this source: return `notFoundReport(source)` (a skip; nothing is recorded).
   - Every root that exists is `denied`: return `deniedReport(source, location, { code })`. Any other root error: `failedReport`.
     The runner records a failed attempt; earlier events, sessions and file rows are untouched (P-07).
   - At least one root `ok` and another `denied`: carry on and count the denied root in `inaccessible` (the result is `partial`).
   - Roots `ok` but no matching file, and files tracked before (their logs were deleted): succeed with nothing to read. History stays (P-29).
   - Roots `ok` but no matching file and nothing tracked before (an empty `projects/`, `sessions/` with no rollout): `notFoundReport`, the same as no folder (Found means a readable transcript or rollout exists).
   - **Where a denial is decided.** A folder that cannot be listed (`chmod 000` on `projects/`, `sessions/` or the home or config dir above it) is a failed attempt with status `denied`. A file that cannot be opened inside a readable folder is counted as unreadable and the result is `partial`: the other files are still imported. Tests that need "a failed source" deny the folder.
2. **Per file**, in path order: `planRead(getSourceFile(db, path), file)` (`listSourceFiles` once up front is cheaper than one query per file).
   `skip` costs a stat and nothing else; that is the no-new-data refresh (C10, 3 s). Call `context.progress({ done, total })` with
   `done: 0` once the number of files to read is known and after every file; say nothing when there is nothing to read.
3. **Read** with `new LineReader(fileChunks(path, from), { from })` (or a decompression stream for `.zst`, always `from: 0`; its
   offsets are not file offsets). Parse with `parseJsonLine`; a line that is not an object, or lacks a field it needs
   (`tokenCount`, `parseTimestamp`, `asString`), adds to `unreadableLines` and is otherwise ignored. **Never** keep, log or put in
   an error a line's text, a parser's message, a prompt, a response or a token. Add `reader.overlong` to the unreadable count.
4. **Commit** once per file: `commitFile(db, { …, from, endOffset: reader.endOffset, unreadableLines }, (fileId) => { … })`. Inside the
   callback (one transaction, no nested transaction): `upsertSession`, then events through one `createEventWriter(db)`. A thrown
   error rolls the file back; the next refresh reads it again from the same place.
   A file that cannot be opened: `markFile(db, { state: 'unreadable', … })` (EACCES, EPERM, EIO …, retried every refresh) or `'unsupported'`
   (a format or encoding this adapter does not read, skipped until the file changes); then carry on with the next file.
5. **Report**: `finishReport({ source, db, tally, location, inaccessible, adapterVersion })` gives `succeeded` or `partial` with
   `imported` (new sessions), `duplicatesSkipped` (events seen again), `unreadable`, `unsupported` and `oldestEventAt`.
   Use `findSessionId(db, provider, id)` before `upsertSession` to count a new session, and `tally.addEvent(write)` for each event.
   Anything thrown outside a file (the runner turns it into a generic failure) is better caught and turned into `failedReport(source, location, code)`
   with `classifyFsError(error).code`.

## Rules that are easy to get wrong

- **Dedupe.** `createEventWriter(db, options).write(event, mode)`, with the counting rules of ccusage written down in
  `docs/implementation/ccusage-rules.md`. Codex uses `'keep'` (the first stays); its key carries the session id, the event's time, model
  and figures, or a compaction request's response id, and each file's events that are no longer in what it holds are removed in the same
  transaction (`retainFileEvents`). Claude uses `'survivor'`: one copy of a message counts, a main-thread copy before a sidechain one,
  then the larger total, then the file that sorts first by path, and the event belongs to the surviving copy's file. Read order never
  changes a session's total. `test/collectors/both.test.ts` runs both adapters on one database against the oracles.
- **A new counting rule re-reads what is stored.** An adapter's version is stored with its source; when it differs from the running
  one, every file still there is read again (Claude from the start) and its events go through the current rules, so history imported
  under an older rule is corrected, and the events of a log that was since deleted stay.
- **A changed Codex file is read again from byte 0**: its deltas depend on the previous cumulative snapshot, which is not stored.
  `'keep'` makes that cheap and exact. Claude lines are independent, so it reads from the stored offset.
- **Session start**: `sessionStart(sourceStart, firstUsage)` gives `startedAt` and `startedBasis`; `upsertSession` only ever moves it earlier.
- **Repo**: one `createRepoResolver()` per attempt; `resolve(cwd, hintUrl)` → `{ repoId, basis }` goes to `upsertSession`.
  A directory that no longer exists resolves to nothing and the session keeps its stored repo.
- **Token categories are never re-added or converted.** Codex: `input` includes cached, `output` includes reasoning, total = input + output.
  Claude: four separate categories, total = their sum. `providerTotal` is the provider's own rule.
- **Memory**: the reader holds one line; keep per-file state small (a map of keys → latest event for one file is fine; a list of every line is not).
- **Yield**: the reader yields every 500 lines by itself. Do not add a second schedule.
- **No SQL outside `src/server/db`.** A test greps `src/server` for `node:sqlite`, `.prepare(`, `.exec(` and SQL keywords, so a RegExp `.exec(` trips it too: use `string.match(regex)`.
- **Time**: use `context.now()` for `lastReadAt`, never `Date.now()` (a fixed clock reaches tests and the preview).

## Tests and fixtures

- Adapter tests live under `test/collectors/<provider>/` and run on fixture folders under `test/fixtures/<provider>/` (temp copies when a
  test writes or changes permissions). They never read this machine's real folders and never use the network.
- Fixtures stay **invented**, keep their `DRAFT-documented-shape` labels, hold no token-shaped value (use `SENTINEL_TOKEN_x`), and edits
  to existing files are additive: `pnpm experiments:selftest` reads the same files and its oracles (`oracle*.json`) must still agree.
- A real E1 or E2 finding is not claimed here. The oracle files are from invented data; say so in the tests' comments.
