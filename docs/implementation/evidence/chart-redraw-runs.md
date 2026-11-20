# Historical chart redraw decision

The earlier headless assessment used a synthetic year and measured warm pointer, keyboard, and full-relayout work independently. This summary preserves the accepted limit and scope of the exception. It provides no timing evidence for this release candidate.

## Recorded exception: a known limit of the test browser

The owner chose to keep the 16 ms ceiling. The exception covers only the full-relayout class in the headless Playwright environment (single process, software drawing), where a single resize sample exceeded the ceiling. The typical redraw is 3 to 5 ms in that historical workload.

A measurement with a sample above 16 ms is still labelled OVER the ceiling. Pointer and keyboard work remain subject to the same threshold. Native-browser timing was not measured.
