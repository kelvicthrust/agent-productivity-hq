# Browser measurements

Historical run with `pnpm bench:browser -- --record` (`node scripts/measure-browser.ts --record`).

Environment: Playwright headless shell with software rendering.

The two rows of TECH › Performance that `pnpm bench` lists as not timed (a Vitest bench has no browser). This is a measurement, not a gate: a number over its budget is reported here, never hidden.

### UI rendering: chart redraw at 366 buckets (TECH budget: ≤ 16 ms per frame)

Trends, 12 months by day (366 daily buckets), the year world, 1280 × 900. WORK is the time from the event to React's commit plus a forced style and layout; PAINT is the time to the next paint and always includes the wait for the next frame.

| Redraw                                                        | n   | p50     | p95     | max     |
| ------------------------------------------------------------- | --- | ------- | ------- | ------- |
| Pointer over a bucket: work                                   | 200 | 1.0 ms  | 1.1 ms  | 1.2 ms  |
| Pointer over a bucket: to next paint                          | 200 | 16.7 ms | 18.2 ms | 18.9 ms |
| Keyboard cursor moves: work                                   | 200 | 1.1 ms  | 1.2 ms  | 1.3 ms  |
| Keyboard cursor moves: to next paint                          | 200 | 16.7 ms | 17.9 ms | 18.6 ms |
| Container resized, every bucket laid out again: work          | 40  | 3.5 ms  | 3.7 ms  | 4.1 ms  |
| Container resized, every bucket laid out again: to next paint | 40  | 16.6 ms | 18.2 ms | 18.7 ms |
| Cold draw: series answer to bars in the DOM                   | 5   | 20.9 ms | 21.8 ms | 21.8 ms |
| Cold draw: series answer to bars painted                      | 5   | 26.1 ms | 28.1 ms | 28.1 ms |

Frame cadence (interval between frames; 16.7 ms is a 60 Hz frame):

| Frames                                      | n   | p50     | p95     | max     |
| ------------------------------------------- | --- | ------- | ------- | ------- |
| Idle, nothing changing                      | 120 | 16.7 ms | 16.7 ms | 16.8 ms |
| Pointer moved to another bucket every frame | 180 | 16.7 ms | 16.7 ms | 16.8 ms |

Sweep frames longer than 25 ms (a visibly missed frame): 0 of 180.
Redraws where nothing in the page changed within 250 ms (left out above): pointer 0, keyboard 0.

Against the budget: pointer work p95 within 16 ms, keyboard work p95 within 16 ms, full relayout work p95 within 16 ms.

### First full import: the page stays responsive (TECH: progress shown per source; UI stays responsive)

The real Codex and Claude Code importers read 600 invented files (600,000 lines) through the real runner in 3.2 s, storing 599,100 usage events and 600 sessions, while the page was open on Sources & repos.

| In the page during the import                 | n   | p50     | p95     | max     |
| --------------------------------------------- | --- | ------- | ------- | ------- |
| Frame interval                                | 163 | 16.7 ms | 16.7 ms | 33.3 ms |
| Key press to next paint (10 real Tab presses) | 10  | 6.4 ms  | 16.3 ms | 16.3 ms |

Frames longer than 50 ms: 0 of 163. Long tasks (main thread blocked over 50 ms): 0. Input events the browser timed at 16 ms or more: 8, slowest 24.0 ms.

Progress sentence: 3 changes seen, the longest gap between two 1.0 s, first “Importing 47 of 300 files”, last “Importing 252 of 300 files”.

| In the server process during the import                      | n   | p50    | p95 / p99     | max     |
| ------------------------------------------------------------ | --- | ------ | ------------- | ------- |
| Event-loop delay (5 ms sampling)                             |     | 5.9 ms | 14.9 ms (p99) | 26.7 ms |
| A request due every 50 ms (GET /api/health): due to answered | 50  | 1.1 ms | 9.4 ms        | 18.7 ms |

No stall of the event loop of 100 ms or more.

## What the first run found, and what changed

The first run of the import measurement (600 invented files, 600,000 lines) found the server’s event loop held for 140 ms, 195 ms and 299 ms at 2.8 s, 5.0 s and 7.4 s of an 8.5 s import (the longest stall was 305 to 311 ms in three runs, and a request due every 50 ms waited up to 254 ms), each longer than the last as events were stored. A CPU profile of the run showed two causes, both a pass over every stored event:

1. Every NEW Codex rollout asked for the events it had brought in before (`WHERE source_file_id = ?`), and no index covers that column, so each rollout scanned the whole table. A rollout never seen before has brought in nothing, so it no longer asks (`src/server/collectors/codex/index.ts`, held by `test/integration/import/first-read.test.ts`). The same import then took 3.2 to 4.6 s in four runs, against 7.7 to 9.1 s in the three before.
2. Every `GET /api/sources` (the page polls it every one to two seconds while an import runs) counted sessions by adding up the Usage groups over all time, which joins every event: 213 ms at about 300,000 events and 340 ms at 600,000. It now counts the sessions that have an event through the session index (`readSessionCounts`, held by `test/db/session-counts.test.ts`, which gives the same numbers as the groups).

After both, the table above is what was measured: no stall of 100 ms or more.

## Limits

- Playwright’s headless shell in one process with software rendering (`--single-process --in-process-gpu`), on a computer that also ran this script and, where the owner’s checks run, other agents: the numbers are an upper-bound sample of the product, not a profile of Safari or Chrome with a GPU.
- The server and the page are joined by request interception on a made-up origin (no socket). The server code runs in this script’s own Node process, so its event-loop numbers include the browser driver; a `pnpm start` process has the event loop to itself.
- The import is of INVENTED files made by this script, in the documented shapes. How long the owner’s own history takes, and how it feels, is the manual check on the owner’s data that TECH names (E1/E2); this measurement does not replace it.
- A frame time here is measured in the page with the browser’s own clock. It is not the React profiler: the production build has no profiler, so a render is measured by its effect (the commit and a forced layout).
