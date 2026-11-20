# Budget bench results

Historical run with `BENCH_RECORD=1 pnpm bench`.

TECH › Performance on the year world (150000 events, 6000 sessions, 2000 PRs)

```
Obligation                                   TECH budget                                                                 Measured                         n   Result
-------------------------------------------  --------------------------------------------------------------------------  -------------------------------  --  ---------
Overview interactive after navigation        ≤ 1.0 s p95 for `/api/overview` + `/api/series`                             569 ms p95                       45  pass
Filter change                                ≤ 300 ms p95 server time                                                    62.7 ms p95                      45  pass
Usage tree group expansion                   ≤ 300 ms for 15 roots                                                       40.3 ms p95                      72  pass
Incremental refresh with no new data         ≤ 3 s                                                                       161 ms slowest scan + recompute  3   pass
Claude hook overhead per status-line update  ≤ 100 ms p95 added to the owner's own status line (Node start-up included)  28.8 ms p95                      20  pass
First full import                            Progress shown per source; UI stays responsive                              -                                -   NOT TIMED
UI rendering                                 Chart redraw ≤ 16 ms per frame at 365 buckets                               -                                -   NOT TIMED
```

Cannot be timed here:

- First full import: TECH sets no time, only "progress per source, UI responsive": timed in a real browser by `pnpm bench:browser` (test/bench/BROWSER-RESULTS.md), and verified by hand on the owner’s data (E1/E2)
- UI rendering: a frame time needs a real browser, not a Vitest bench: timed by `pnpm bench:browser` (test/bench/BROWSER-RESULTS.md)
