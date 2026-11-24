# Agent Productivity HQ — Design brief

Revision **D9** · the owner's choice of "Cozy Logbook, Refined" with sparklines, 2026-11-18, made through an Impeccable redesign round on the shipped D8 screens · Status: **D3 screens approved for technical handoff (historical review); D4 changes approved as design (historical review) with rendered checks deferred to Verification; D5 to D8 are not yet reviewed by the owner**. Revision history for D2 to D8 (the "in one line" summaries, repair passes and owner input) is in [docs/archive/design/history.md](docs/archive/design/history.md); the current brief follows.

**D9 in one line:** the dashboard's look is refined, not restructured. Nunito becomes the self-hosted display font; a selected segment and the Evidence link badge use the grape tint; Merged PRs and each provider's local tokens KPI gain a 12-week sparkline; the filter bar becomes one title-first row with a "Filters · n" popover; the KPI crew cluster is three buddies plus "+N"; the account card shows one status line and one action with caveats behind "Why?"; unavailable history is a dot stipple so hatching means only Claude Code; Sources & repos sits in the nav list. **No colour hex changed.** The rules are in [design-system/DESIGN.md](design-system/DESIGN.md) under "What changed in D9"; the production mapping is in [design-to-code](docs/tech/design-to-code.md#d9-cozy-logbook-refined). The records below that name the D8 screens stay accurate for everything D9 did not touch.

This is the experience brief and artifact index for the MVP defined in [PRODUCT.md](PRODUCT.md) P4. The product is named **Agent Productivity HQ**. Revision records below use the names in effect at their respective reviews. The first-layer visual identity lives in [design-system/DESIGN.md](design-system/DESIGN.md) (Google DESIGN.md format). The research record behind the approved D2 direction, reused unchanged in D3 and D4, is [docs/archive/design/research.md](docs/archive/design/research.md). The viewable style guide and clickable prototype live in [docs/design/prototype/](docs/design/prototype/).

## Product follow-up

- **App bar** shows Refresh on the dashboard and an About info icon at every width. About opens a
  dialog with the app version, project and support links, and the creator credit. The Sources &
  repos navigation item carries the issue count on desktop and phones.
- **Sources & repos** starts with a rectangular **Source coverage** section. At 720px and above,
  show On this machine, Delivery and Account reports in three columns. On phones collapse the
  groups behind one disclosure and indicate actionable issues. Keep refresh timestamps in its header.
  List optional Claude plan checks as **Not checked yet** until the owner requests a reading.
- **Repositories** uses the same actions in Setup and Sources. In browser and Paseo Sources,
  **Add repository** opens an anchored dropdown with scrollable results, leaving the
  tracked-repository card in place. Browser Setup shows the picker inline. Display visibility and
  one **Track**, **Tracking** or **Track again** action per result. Keep the search open after tracking.
- **Overview** opens on its headline metrics. Usage retains its compact coverage disclosure.
  Keep Merged PRs and Linked PRs visible on a populated 320 × 700 phone. At viewport widths of
  1280px and above (D9), the aligned chart occupies eight columns and **Account-reported usage**
  the other four, top-aligned with it; **Recently merged** and **By repository** then run the full
  width below, in that order. Below 1280px, the same account section follows all three activity
  sections in one column, which is also the reading and tab order at every width.
- **Account-reported usage** places the repo-scope badge beside the heading. Show weekly utilization,
  reset times and freshness for each provider, with Claude’s five-hour window always in view.
  Offer a Sources link when the account needs connection.
- **Source status** distinguishes availability, the last attempt, the last success and retained
  records. Use **Needs a password** and **Not running** for Paseo. Reserve **Access denied** for
  unreadable local history. A refresh banner describes an actual failed attempt and mentions
  retained data only when that source has records.
- **Setup** makes GitHub optional and explains that delivery requires both a connection and a
  tracked repo. Reveal registration instructions when requested. If GitHub is disconnected, the
  repository step explains how to go back or finish without it. ChatGPT is a separate choice.
- **Delivery evidence** shows the session identity and tokens before the decision on phones.
  Put the suggestion badge beside its basis and above **Dismiss** and **Confirm link**. The panel
  explains token scope once. Preserve Undo and focus return.
- **Toasts** use a centered dark pill just above the safe area and phone tabs, with room for
  wrapped text and actions at 320px.
- **Startup recovery** uses the Agent Productivity HQ wordmark, a rounded card, tinted reassurance and numbered
  steps. The server renders the recovery page when the database cannot open, the disk is full or
  another process owns the data directory.

The [design-to-code mapping](docs/tech/design-to-code.md#product-follow-up) records the production
mapping. The D7 and D8 prototype, style guide, captures and findings use the branding from their
original revisions.

## Artifact index

| Artifact | Path | Role | Revision |
| --- | --- | --- | --- |
| Visual identity (canonical tokens) | `design-system/DESIGN.md` | Google-format identity: YAML tokens, rationale, motion extension | D9 (colour values unchanged since D2; display font is now self-hosted Nunito; selected segment and Evidence link badge use the grape tint). Earlier: D8 draft (colour/type/shape values unchanged since D2; D8 adds the "Source status words" component rule and one Do/Don't in prose) |
| Research record | `docs/archive/design/research.md` | Inspected sources with receipts, observations, borrow/adapt/reject decisions, direction and prototype rationale | D2 research, reused in D3 to D8 (no new sources; a "Reuse in D8" note and a refreshed declared summary) |
| Clickable prototype (**composition authority**) | `docs/design/prototype/index.html` (+ `app.js`, `ui.js`, `data.js`, `app.css`, `containment-check.js`) | The one editable source for screens, layout and states | D8 draft (`app.js`, `data.js` and `ui.js` changed for the two Paseo states; `index.html` and `app.css` unchanged) |
| Token mirror | `docs/design/prototype/tokens.css` | CSS custom properties mirroring the YAML. Change both together | D9 (only `--font-display` changed, now leading with Nunito). Earlier: D4 (values unchanged; `--bottomnav-h`, `--shadow-nav`, `--scroll-edge` added); unchanged in D8 |
| Design-system style guide | `docs/design/prototype/style-guide.html` | Viewable specimens, states, buddies, year grid, motion replays, narrow-width specimens and usage rules, rendered from the live tokens | D8 draft (`style-guide.html` and `style-guide.js` add the two status tags and a "Paseo status words and helper sentences" table under Components) |
| Layout containment check (review tool) | `docs/design/prototype/containment-check.js`, run from the Prototype states panel | Measures sideways overflow and spilled content in the current window. Not product UI. Never executed by its author | D4 (unchanged) |
| This brief | `DESIGN.md` | Direction, flows, states, critique, handoff, open decisions (revision and repair records: [history](docs/archive/design/history.md)) | D9 summary on the D8 draft |

There is one editable composition authority: the coded prototype. There are no separate mockups and Paper was not selected. The style guide reuses the prototype's CSS, buddies and chart renderer rather than keeping its own copy.

## Paseo status words (D8)

**Why this exists.** The accepted sources named Paseo's two unusable states differently:
- This brief and the D7 prototype drew Paseo as **"Access denied"** (with a "permission denied, allow read access" sentence) on first launch, and as **"Not found"** (with a folder sentence, "run it once") when nothing was found.
- Tech's `data-and-sources.md` (the `paseo` row) says "Design's 'Access denied' copy maps to `needspassword`" and that "Not found" maps to `notrunning` if Paseo was never seen, otherwise "Not running, showing the last snapshot".
- Tech's `design-to-code.md` (Setup criterion 3) says the product's Paseo **"Needs a password"** "is the settled state, not D7's generic Access denied".
- `TECH.md` (failure modes) gives user-visible strings: "Paseo not running · showing the last snapshot from <date>" and "Paseo needs a password, which isn't supported in normal setup".
- The accepted Implementation record lists, among differences from the design that no one has accepted: "'Needs a password' reads where the design says 'Access denied'".

Underneath, a Paseo is not a folder. The dashboard opens a connection to the daemon; either something answers (and may ask for a password) or nothing does. "Access denied" and "Not found" describe a local folder, so they were the wrong words for Paseo.

### The two states

| | **Needs a password** | **Not running** |
| --- | --- | --- |
| Server status | `needspassword` | `notrunning` |
| What it means | The Paseo daemon answered and asks for a password. The dashboard never asks for or stores one (P-41, P-43), so the source can't be used | Nothing answers at Paseo's address on this machine, so there is no daemon to read |
| Status tag | "Needs a password", lock mark, danger tint | "Not running", muted no-entry mark |
| Setup, step 1, helper sentence | "Paseo is asking for a password, which this dashboard doesn’t support. You can continue without it." | "Paseo isn’t running on this machine. Start it, then check again. You can continue without it." |
| Sources & repos, helper sentence | "Paseo is asking for a password, which this dashboard doesn’t support." Add " Names and parents come from its last snapshot." only when a snapshot exists | No snapshot: "Paseo isn’t running on this machine. Start it, then check again." With a snapshot: "Paseo isn’t running on this machine. Showing its last snapshot." The snapshot's date is in the row's own "Last successful refresh" line, so the sentence doesn't repeat it |
| Coverage strip (lower case) | "needs a password" | "not running" (muted mark; the warning clock mark when stale data is still showing) |
| Row button | **Retry** | **Check again** |
| After the button | The same word and sentence again, unless the owner changed Paseo outside the dashboard | The same word and sentence again, unless the owner started Paseo |
| Blocks Continue or Finish | No | No |

**Why these words.** "Needs a password" states the condition plainly and doesn't promise the dashboard will take one. "Access denied" would imply the owner can grant permission, and its sentence ("Allow read access, then retry") would be false here. "Not running" tells the owner what they can act on (start Paseo). "Not found" would send them to "run it once" to create records, but the dashboard can't tell a Paseo that was never installed from one that is stopped; it only knows that nothing answered.

**Rules.**
1. **One word per state, on every surface.** Tag in sentence case, coverage strip in lower case, never a synonym.
2. **Sentence order:** the fact, then what the owner can do (omitted when there is nothing), then, in Setup only, "You can continue without it."
3. **A snapshot is mentioned only when one exists.** A Paseo that was never reached has none, so it never says "last snapshot".
4. **Retry** is for something that answered and can't be used. **Check again** is for nothing there.
5. **Never for Paseo:** "Access denied", "Not found", "permission denied", "Allow read access" and "run it once". Those words stay with Codex and Claude Code.
6. A look that itself failed keeps its own word, "Refresh failed", and its own sentence. It never borrows a Paseo sentence.
7. Paseo keeps its layers icon (no buddy), and Setup has no password field or any other input on step 1.

### Source mapping (server status to word)

| Server status | Codex and Claude Code | Paseo |
| --- | --- | --- |
| `checking` | Looking… | Looking… |
| `ok` | Found | Found |
| `partial` | Partial (with "· N unreadable" on Sources) | Partial |
| `notfound` | Not found | not produced for Paseo |
| `denied` | Access denied | not produced for Paseo |
| `needspassword` | not produced | **Needs a password** |
| `notrunning` | not produced | **Not running**, never "Not found", whether or not Paseo was ever reached |
| `failed` | Refresh failed | Refresh failed |

If a Paseo ever arrives with `notfound` or `denied`, that is a defect in the mapping, not a state to draw.

### Reconciled sources

What D8 settles, and who edits what. Design cannot edit the Tech or Product files; the first three lines are returned to Tech Spec.

| Source | What it says now | Settled by D8 |
| --- | --- | --- |
| Tech `data-and-sources.md`, `paseo` row | "Design's 'Access denied' copy maps to `needspassword`. 'Not found' maps to `notrunning` if Paseo was never seen, otherwise 'Not running, showing the last snapshot'" | **Superseded.** `needspassword` is "Needs a password"; `notrunning` is "Not running" in every case. The snapshot clause depends only on whether a snapshot exists |
| Tech `design-to-code.md`, Setup criterion 3 | "Paseo 'Needs a password' is the settled state, not D7's generic Access denied" | **Agrees with D8.** It lacks the Not running sentence, which is above |
| `TECH.md` failure modes | "Paseo not running · showing the last snapshot from <date>"; "Paseo needs a password, which isn't supported in normal setup" | **Wording superseded** by the helper sentences above. The facts (what happens, what is kept) are unchanged |
| Accepted Implementation record | Lists "'Needs a password' reads where the design says 'Access denied'" as a difference no one accepted | **Closed from Design's side:** the design now says "Needs a password" |
| This brief and the D7 prototype | Paseo "Access denied" (first launch) and "Not found" (nothing found) | **Replaced** in D8 |

**Observed in the current working tree, not an accepted input and not changed here** (for Implementation to confirm once Tech Spec has aligned its documents): the coverage strip draws the password state as "access denied" and a never-reached Paseo as "not found" (`coverageGroups.ts`); the Sources row says "Not running. Showing the last snapshot." even when no snapshot exists (`LocalSources.tsx`); and Setup shows the not-running sentence under the words "Not found" or "Refresh failed" for a Paseo with those statuses (`SetupSourceRow.tsx`). D8 says each should use the words above.

### Concrete screen criteria

Reach them from **Prototype states** (bottom-left): the first-launch scenarios settle about two seconds after they are chosen, and the three rows answer one after another. Each criterion can be checked by reading the screen.

**A. Setup step 1, Paseo "Needs a password"** (scenario *First launch — discovery*)
- **PW-1.** Three rows in order: Codex, Claude Code, Paseo. Codex and Claude Code read "Found" with their location lines. Paseo has the layers icon, not a buddy.
- **PW-2.** Paseo's tag reads exactly "Needs a password", with a lock mark in the danger tint. The words "Access denied" and "Not found" appear nowhere on the screen.
- **PW-3.** Paseo's helper text reads exactly "Paseo is asking for a password, which this dashboard doesn’t support. You can continue without it."
- **PW-4.** Paseo's row has one button, a small secondary "Retry" with the refresh icon. It sits at the right of the row on desktop and under the sentence on a phone.
- **PW-5.** The info notice reads "2 of 3 sources found. History starts where each source’s records start. You can fix the rest later in Sources & repos." Continue is enabled, primary and on the right.
- **PW-6.** Pressing Retry turns only Paseo's tag into "Looking…" and disables Continue for about 0.9 seconds. Then the same tag and sentence return. Nothing else on the screen changes.
- **PW-7.** There is no password field or other input anywhere on step 1.

**B. Setup step 1, Paseo "Not running"** (scenario *First launch — nothing found*)
- **NR-1.** Codex and Claude Code read "Not found" with "No records in its usual locations. If you use Codex here, run it once, then check again." (and the same with Claude Code). Paseo reads "Not running", with the muted no-entry mark. The word "Not found" appears on exactly two rows and never on Paseo.
- **NR-2.** Paseo's helper text reads exactly "Paseo isn’t running on this machine. Start it, then check again. You can continue without it." It does not say "run it once" or "permission denied".
- **NR-3.** All three rows carry a small secondary "Check again" button (none says Retry).
- **NR-4.** The warning notice reads "No local agent records found on this machine. You can still connect accounts for account-reported usage and track repos for merged PRs." Continue is enabled.
- **NR-5.** Pressing Check again on Paseo shows "Looking…" for about 0.9 seconds, then "Not running" with the same sentence.
- **NR-6.** Choose Continue, Continue, then Finish setup (Overview opens in the Account-only world), then open **Sources & repos**. Paseo reads "Not running", with "Paseo isn’t running on this machine. Start it, then check again." (no snapshot sentence), the muted mark and a "Check again" button. The coverage strip on Overview reads "Paseo not running". Pressing Check again shows a toast saying Paseo still isn’t running on this machine.

**C. Both states on a phone (390 and 320px)**
- **PH-1.** Name and tag, the helper sentence and the button stack inside the card. The tag word is not truncated, the sentence wraps, the button is fully visible and the page has no sideways scroll. (The accepted rule for phone button size is unchanged.)

**Specified but not drawn as a scenario** (the prototype's fixtures have no way to reach them): the password state on **Sources & repos** and in the **coverage strip**, and the not-running state when a snapshot exists. Their words, sentences and marks are fixed by the tables above and shown as specimens in the style guide (Components › Paseo status words and helper sentences).

**What this verifies, and what it doesn't.** Verified by reading the changed prototype code and strings against these criteria. Not rendered, not run, no screenshot taken by Design, no keyboard, screen-reader or contrast check. PDLC captures the two Setup scenes declared with this revision.

## Entry, inputs and guidance

The brief and coded prototype are design references, not proof of a rendered production check.
The [sanitized research](docs/archive/design/research.md) and
[revision history](docs/archive/design/history.md) retain the rationale and evidence limits.
Internal workflow receipts and machine-specific input records are excluded.

## Experience intent and references

**Job (unchanged):** a daily or weekly look back at Kelvin's own coding-agent work. *What merged, where agent usage went, and which sessions link to that work*, by day, week or month across up to 12 months.

**Direction D2: a cozy logbook for your agents** (approved by the owner in historical review; D3 doesn't change it). It's still the familiar dashboard skeleton Product asked for, in a warm, gently playful world:

- **Warmth from material:** cream canvas, warm neutrals, soft warm shadows. This is the biggest move away from "enterprise SaaS".
- **Agents as a small crew:** authored buddies stand in for sessions. They keep D1's shape encoding (square Codex, round Claude Code, dashed unknown). *Since 2026-11-19 the buddies are HQ's critters: Codex a boxy owl, Claude Code a round fox, unknown a dashed blob; the shape rule is unchanged.*
- **One friendly action colour (grape) and very little chrome:** pill navigation, segments and chips; one floating rounded filter panel.
- **Tactile, not flashy:** soft button edges, a 3% press, popovers that grow from their trigger.
- **Personality at rare moments:** "Morning, Kelvin", "Let's find your agents", a "quiet one" panel with sleeping buddies for a true zero day, crew art in empty states.
- **"A year of merges":** a day-cell calendar on Trends, a familiar developer pattern. Merges only, with no streaks.

**D1 rules that stay:**
- Merged PRs lead.
- Usage sits beside delivery, never on one scale.
- Coverage is always in words.
- Attribution evidence levels are visible.
- Account reports keep their own unit, window and scope.
- Setup stays out of the way.
- No productivity score, no streaks or leaderboards, no green/red deltas.

**References (inspected; full record in [research.md](docs/archive/design/research.md)):**
- **Pixel Agents** (owner): adapted. The "each agent is a character" idea and the warmth are borrowed. Pixel art, assets, scores and health bars are rejected; HQ's scene (below) is original hand-drawn art and borrows nothing of its look.
- **PostHog** product page: adapted at low dose. Tactile buttons, warm palette, illustration beside data. The desktop metaphor is rejected.
- **Plausible**: adapted. One action colour, soft cards, lots of air. Deltas and uppercase micro-labels are rejected.
- **WakaTime**: rejected as direction. ROI and leaderboard framing, pies and gauges.
- **GitHub contribution calendar**: concept adapted. No visual was observed, so the styling is our own.
- D1's text-based Product references still cover structure and data semantics.

## Information architecture

This table records the D8 prototype's routes and screen order. The
[product follow-up](#product-follow-up) gives the current Overview composition.

| Section | Purpose | Prototype route |
| --- | --- | --- |
| Overview | Greeting → coverage strip → KPIs (with crew rows) → aligned chart + account-reported usage → by-repository table + recently merged | `#/overview` |
| Trends | **A year of merges** → larger aligned chart with Chart/Table switch → the selected period's PRs and sessions → tokens by model | `#/trends` |
| Delivery | Merged PR table with link-basis filter and search; expandable evidence with confirm, dismiss, remove, mark-incorrect and add-link | `#/delivery` |
| Usage | Token categories per provider; Repo → root → children tree with role-sized buddies and Unknown repo, Untracked and Unknown relationship groups | `#/usage` |
| Sources & repos | Local sources found automatically, account connections, tracked repositories, data-retention note | `#/sources` |
| Setup (first launch) | "Let's find your agents": 3 steps (local sources → accounts → repositories), buddies pop in as sources are found | `#/setup` |
| Records drawer | Merged PRs / Sessions for one chart period, drill-through to Delivery or Usage | Opens from the Overview chart |

Shared controls and their scope labels are unchanged from D1: Period, Group by, Repos (usage & delivery), Provider (usage only), Author (delivery only), report timezone. They sit in one floating rounded panel.

**Default view (D3, owner decision):** the dashboard opens on **This week**: the current Monday-start week, grouped by day, with Mine selected for PR author, All repos and All providers. In the fixture, today is Wed Nov 4, so the week is Mon Nov 2 – Sun Nov 8. "Reset" on the phone filter sheet returns to this view. The period presets (Today, This week, This month) and the Custom range (Last 30 days, Last 90 days, Last 12 months, or chosen dates) are unchanged. Whether the app should also *remember* the last-used period is an implementation detail for Tech Spec; the owner chose a fixed default.

## Key flows

Unchanged from D1. Each flow runs through the same routes and scenarios.

1. **Set up coverage:** First launch, discovery or nothing found.
2. **Review a period:** Overview → filters → chart period → drawer → Delivery/Usage. New in D2: Trends → click a day in the year grid → that day's records.
3. **Understand multi-agent work:** Usage tree, now with role-sized buddies.
4. **Trace a merge:** Delivery evidence with Undo, and "#number" from Usage.
5. **Recover from collection failure:** the Refresh failed scenario, and stop-tracking with retention.

**Showcase records (D3 fixture change):** the curated records now sit inside the default week so the first screen shows them without changing any filter:
- Nov 2: "Split usage importer into provider adapters" (two evidence links across Codex and Claude Code, plus one suggestion; a Paseo root with two children), and "Handle archived sessions in export" (suggested only).
- Nov 3: "Add coverage rail to trends chart" (owner-confirmed, merged by someone else) and "Retry GitHub sync on secondary rate limit" (unlinked).
- Nov 4: "Show subscription window beside selected period" (multi-provider evidence).

In D2 the first two groups were dated Oct 29–30; only their dates moved. Randomly generated PRs and sessions fill the rest of each day.

## Important states

Every Product-required state remains demonstrated in the same scenario and location as D1, via the **Prototype states** panel at bottom-left (a review tool, not product UI). D2 changes how some of them look:

| Required state | Scenario → location | D2 treatment change |
| --- | --- | --- |
| Automatic discovery in progress | First launch — discovery → step 1 | Header crew art in "search"; each found source's buddy pops in once |
| No local records found | First launch — nothing found; Account-only | Buddies asleep beside "Not found" for Codex and Claude Code; crew art in the Usage empty state. **D8:** Paseo reads "Not running" in the same scenarios, never "Not found" |
| Local-read access denied (a Codex or Claude Code folder that can't be read) | None in the prototype after D8 | **D8:** the D7 scenario used Paseo as its example, but Paseo is a daemon and can't be "Access denied". The word, its sentence ("…’s data is here but couldn’t be read (permission denied). Allow read access, then retry. You can continue without it.") and the Retry button are unchanged and still specified in the style guide; the prototype no longer draws a scenario for a folder that can't be read. See Open decisions |
| **Paseo needs a password (new in D8)** | First launch — discovery → step 1, Paseo row | Tag "Needs a password"; the sentence and Retry button in [Paseo status words](#paseo-status-words-d8); Continue stays enabled; Retry returns the same answer. Criteria PW-1 to PW-7 |
| **Paseo not running (new in D8)** | First launch — nothing found → step 1, Paseo row; then Sources & repos in the Account-only world | Tag "Not running"; the sentence and Check again button in [Paseo status words](#paseo-status-words-d8). Criteria NR-1 to NR-6 |
| Existing valid sign-in / needs connection or reconnection / connected with no local history | Setup step 2; Refresh failed; Nothing found | Unchanged |
| No tracked repos | No tracked repos | Empty state with crew art; year grid hidden |
| True zero activity | True zero activity (Sun, Nov 1) | "A quiet one" panel with sleeping buddies; year grid outlines Nov 1 as a covered zero |
| Unavailable earlier history | Before available history | Warm hatch (D9: dot stipple); KPI "From … only" |
| Partial collection | Typical → Paseo "partial · 3 unreadable" in the strip, Sources and Usage | Unchanged semantics |
| Stale or failed refresh with cached data | Refresh failed | **D4:** one prose explanation, in the banner (status, last success, coverage limit, Retry and View source). The strip, footer, KPI and readout carry short markers only; the duplicate range notice is gone. The Claude card's stale state is a status chip, one caption and a Reconnect button. **D7:** Retry shows "Retrying…" with a disabled button, then clears the banner (success) or, if "Fails again" is chosen in Prototype states, keeps it with "failed again today, <time>" |
| Inaccessible repo; unknown repo/parentage | Typical | Unknown-relationship sessions show a dashed buddy |
| Link classes; multi-provider PR; account-only | Typical (all link classes are inside the default week); Account-only | Unchanged semantics |
| Subscription window differs from the selected period | Typical → account card: the ChatGPT window (Oct 5 – Nov 3, rolling 30 days) vs the default week (Nov 2 – Nov 8) | Unchanged semantics; **D3:** the default period changed from Last 30 days, so the card's warning now compares against This week |
| **Upcoming days inside the selected period (new in D3)** | Typical → default view: Thu Nov 5 – Sun Nov 8 | The default week extends past "today". Those buckets show nothing in the chart, "Upcoming, no data yet" in the readout, "—" / "Upcoming" in the table and a greyed axis label, never a zero. Early in a real week most of the chart will be upcoming; the first thing to check when rendered |
| Chart loading / empty / error | Chart loading → error | Skeletons "breathe" instead of shimmering; the error panel is unchanged |

## Responsive treatment

The breakpoints are ≥1280, 1024–1279, 720–1023, <720 and <640. The Overview layout follows the product follow-up decision in [design-to-code](docs/tech/design-to-code.md#product-follow-up). The remaining breakpoint rules follow the identity’s Layout section and the style guide.

| Width | Behaviour |
| --- | --- |
| ≥ 1280px | Side nav; KPIs in one row; provider ledgers two-up; coverage strip is a one-line capsule when its container is 900px or wider |
| 1024–1279px | Side nav; KPIs three per row; ledgers still two-up; coverage strip is compact groups |
| 720–1023px | Pill nav row (all five items fit); **half-width cards (provider ledgers, model breakdown, record lists) stack full width**; the tokens KPI stacks its two providers because its card is under 200px |
| < 720px | **Fixed bottom tab bar** with all five destinations ("Sources & repos" shows as "Sources"); app bar keeps the logo and an icon-only Refresh with a 44px touch target; Merged PRs and Linked PRs share the first KPI row, followed by a full-width Recorded local tokens row, then Root sessions and Child agents; segmented controls wrap; filters collapse into a pill summary that opens a bottom sheet; the failed-refresh banner puts its actions on their own row; charts have a 240px minimum |
| < 640px | Tables become stacked label/value cards; **D5:** each Usage-tree session is a two-line card, with identity (name, relationship, ID, then provider · model · time) across the full width and Tokens and Linked PRs on one labelled line below it |

Unchanged from D2: the drawer is inset 8px with rounded corners and fills the width on a phone; action pairs stay in one row with the primary on the right. Anything that scrolls sideways does so locally (year grid, wide tables) and shows an edge shadow; the year grid also says so in words on a phone and opens on its newest weeks.

## HQ (added after D9)

HQ is a destination beside the five of the design: a view-only page of the coding agents running on this machine now, grouped into sessions (an orchestrator and the agents it spawned). It is not part of the D9 prototype, and nothing here changes a token.

- **Navigation.** In the side nav and the 720–1023px pill row it follows Usage. It has no filter bar. **On a phone the bottom tab bar keeps its five tabs** (six do not fit at 320px, and the five-destination decision above stands for the bar); HQ is an icon-only link in the app bar, visible below 720px only, a 44px target named "HQ", with `aria-current="page"` on the page.
- **Roster first.** The accessible account of the page is real nested lists, one card per session, the root first and its agents indented beneath it (the drawn indent stops after three levels, so a deep chain stays inside a phone's width while the lists keep nesting). A session containing a waiting agent is listed first and marked with the existing warning surface and border, and its row says so in words ("Needs you: permission", or "May be waiting for you" when that is inferred rather than reported). Buddies stay decorative (`aria-hidden`), rows are not focusable, and polling updates are not announced.
- **Recent idle.** Sessions with work in progress or an agent that needs attention get illustrated rooms. A Paseo completion awaiting review keeps the finished drawing, with a short “review” caption and **Ready to review** in the roster. It leaves the room when Paseo clears the flag. Idle-only crews appear in **Recent idle (N)** beneath the focused roster, newest activity first and collapsed on entry. Confirmed empty threads are hidden. When the only sessions are recent idle and the feeds are healthy, the AFK scene sits above the disclosure.
- **Honest states.** Loading, a failed request (the last roster stays, with Retry), no live source ("Live agents aren't available in this session."), Setup not finished, Paseo not running or asking for a password (the Sources screen's words), and a quiet roster (an "AFK" room drawn in the scene's style, with "A quiet one. No agents are running right now." as a quieter footnote under it, shown only when at least one feed is live and no feed has a problem) are all drawn in words. What counts as a problem follows the Sources screen: a feed that is `unavailable` (its source is not on in this process) or `notfound` (a provider with nothing on this machine, which Sources shows as a muted "Not found" with a plain "Check again", not as a failed refresh, so a machine without Codex can still be quiet) is not one; a feed that is still starting is not yet known, and one that is not running, asking for a password, denied, failed or waiting for Setup is a problem. A problem shows its own line (or the Setup line) and the page then says "No agents to show right now." instead of claiming quiet, because the feed that cannot look may be hiding an agent. No celebratory copy, no counts that read as a score.
- **The scene.** Above the roster, when at least one session is working or needs attention, HQ draws a cutaway building on a notebook page: one room per session, a hanging sign on each (the chat's title on the first line, so two chats in one repository read differently, or the repository or workspace name when it has no title; the second line is smaller and muted, the repository or workspace name then "captain + 3", "solo", "idle 12 min" or "parent away", with the name cut first and the state never cut; a long title is cut with an ellipsis, and on a room that needs the owner both lines stop short of the star), the captain at its desk with grape arrows to each helper, and a short state in handwriting under every character ("editing", "reading", "needs you"). It is an original "logbook sketch": wobbly ink lines, loose watercolour washes at 0.35–0.7 opacity that sit slightly off their outlines, handwritten captions, and a stepped "line boil" (the ink steps between three wobble filters about four times a second). All colour is the existing tokens. A room that needs the owner gets a soft yellow wash (`--color-sunshine`) and a star on its sign; idle agents can still be drawn within a crew that has work or needs attention. Rooms are three to a row from 1280px, two to a row from 720px and one to a row below that, and the building simply grows taller, one row per three (two, one) sessions, for the sessions that qualify for rooms. A room holds the captain and up to five helpers ("+N" on a bench for the rest). A session keeps its room for as long as it qualifies for one, so nothing jumps: when a session goes its room stays as an empty one (walls and floor) until a new session takes the lowest empty room, and only the empty rows below the last occupied room are dropped. If the window is resized to another column count, the rooms are laid out again in the order they had, with the empty ones closed up.
- **Critters.** Shape carries the provider, as the buddies always have: Claude Code is a round orange fox curled into a bun, Codex a boxy teal owl with a yellow-tipped tuft (the small owl is deliberately plain: two eyes with a thin ring, no beak, no belly marks), any other agent a neutral dashed-outline blob. Poses are editing, reading, running a command, thinking, working, needs you, asleep (idle), error and finished. Since 2026-11-19 the same two critters are the buddies on every other screen too, drawn smaller and flatter (see "The critters everywhere" below).
- **The quiet room.** When the machine is quiet, HQ draws one wide, empty room on the same notebook page (full width up to 720px, one room, no characters): a hung sign lettered "AFK", a sticky note reading "back soon", a desk chair pushed back and slowly turning, a steaming mug, a trail of fox paw and owl talon prints to a door left ajar. No sleeping critter is drawn, since that means an idle agent. It is decorative like the scene (`aria-hidden`, nothing focusable, the same handwriting and loops behind `motion-safe`, a still drawing with reduced motion); the footnote beneath is the statement of the state, and the drawn words carry no meaning of their own.
- **The scene is decorative.** It is `aria-hidden`, has nothing focusable, and the roster beneath it says everything it does. Its handwriting is Playpen Sans (one self-hosted variable-weight latin woff2 with its SIL OFL licence beside it, no font CDN; the system stack `'Bradley Hand', 'Segoe Print', 'Chalkboard SE', 'Comic Sans MS', cursive` follows it as the fallback, so text shows at once and stays legible if the file fails to load), at about 11px or more, outside the filtered groups so it stays sharp. It is the scene's own text only (the heading "HQ, today", the signs and the captions): the roster and the page title stay in the app's UI fonts, and Playpen Sans is not a design token. Every loop is behind `motion-safe`: with reduced motion the scene is a still drawing with the first wobble filter applied. Motion is stepped, never smooth, and never moves layout.
- **The hooks switch (2026-11-19).** On **Sources & repos**, after **On this machine**, a bordered card titled **Know when Claude Code needs you** says the switch affects only HQ. On the first eligible HQ visit in each browser, the same control opens in a labelled Astryx dialog while hooks are off. The dialog says where to find the switch later, keeps focus inside, and remembers dismissal or setup on that browser. The control shows the explanation ("HQ can only guess when an agent outside Paseo is waiting for you. Turn this on to have Claude Code tell HQ directly."), one line saying what turning it on does, and the state in words ("Off. HQ guesses, and says “May be waiting for you”.", "On. Claude Code tells HQ when it needs you.", "Needs repair. …", "Not available. …"). Two small buttons sit in a row that wraps: **What will change** (a disclosure, `aria-expanded` and `aria-controls`, closed by default) and the action that applies (**Turn on**, **Turn off**, or **Repair** beside **Turn off**; when HQ could not remove its own files after turning off, **Turn on** beside **Remove HQ's files**); there is no switch graphic, so the words on the button are the state change. The disclosure sits in a sunken panel and lists, from the server's preview and nothing invented, **the plan of the action on screen** (the one pressed, else the state's first): the settings files that action writes (home-relative, "will be created" or what is wrong with a file, including "is laid out in a way HQ can’t edit safely"), HQ's own files it writes or removes and where, the five events, the exact command in the mono face, what HQ receives, and the backup note. Pressing the action is the only thing that changes anything, and only after the plan has been shown: a press with no successful plan on screen for that button's action (the disclosure shut, still reading, a read that failed, a plan for another state, or the plan of another button: pressing **Turn off** after reading **Repair** shows turning off's plan) only opens the disclosure and reads it, says "Nothing has changed. Read what will change below, then press the button again to confirm.", and a second press sends the change with the plan's fingerprint (the server refuses one that is stale, and the page then reads the plan and the roster again). **Turn off** shows what it will remove (only the files that hold HQ's entries, and HQ's own files) the same way, from any state it is offered in, and the state says in one plain sentence why it is as it is once the plan is read (a needs-repair reason, including "The Node that Claude Code’s hook would run can’t be found. Restart HQ so it uses the Node that is installed, or turn it off.", after which only **Turn off** is shown, no **Repair** that could never be confirmed; or "HQ’s hook script is missing, has changed or can’t be run by Claude Code’s hook."; HQ's data folder or Node path holding a character HQ cannot put in a shell command, with exactly which characters work; or, after a turn-off that could not remove HQ's own files, "HQ’s entries are out of Claude Code’s settings, but HQ could not remove its own files in <folder>; you can delete them."). The answer to such a turn-off says "Turned off. … but HQ could not remove its own files in <folder>; you can delete them." rather than a clean result. The result ("Turned on. …", "Turned off. …", "Repaired. …") is said once in a polite status line and a refusal in a `role="alert"` line with the server's fixed sentence (whatever the code, followed by "HQ left its hook script, its registry file, the copy of your settings it made or a temporary file where it is, because it was changed after HQ wrote it or could not be removed. You can delete it." when the change left any of them) and "Nothing was turned on or off." The copy is plain and unceremonious: no celebration, no exclamation. Existing tokens only (`surface`, `sunken`, `border`, `ink`, `ink-muted`, `danger`); the buttons are Astryx's, 44px high below 720px; at 320px the row wraps and the command breaks anywhere. The first-run dialog waits for a successful roster response and finished Setup, with at least one feeder available. A waiting agent's line reads "Needs you: permission" when a hook reported it and "May be waiting for you" when it was inferred, unchanged.

### The critters everywhere (2026-11-19)

The owner chose HQ's critters as the product's agent characters, so the buddies on every other screen (lists, tables, cards, legends, the KPI crew cluster, the Usage tree, Setup's source rows) and the crew illustration in empty and quiet states are the same two animals, redrawn for their size. The component names, the `awake` / `sleep` / `dizzy` moods and the rule that a buddy is decorative and sits beside text naming the provider are unchanged; D1's shape encoding is restated, not replaced.

- **Shape carries the provider, with or without colour.** Claude Code is round with two pointed ears and a pale muzzle (a fox curled into a bun); Codex is a rounded square with a yellow-tipped tuft and two ringed eyes (a boxy owl); an unknown agent is a dashed-outline blob with neutral eyes. Round with ears, square with a tuft, dashed.
- **Small and flat.** At 13 to 20px the critters are plain shapes in existing tokens (`series-claude`, `series-codex`, `sunshine`, white, ink for the eyes and the nose, `series-neutral` for the blob). They have no wobble, no line boil and no motion: only HQ's scene is hand-drawn and moving. The crew illustration shows the owl and the fox (and the blob when searching) at about twice that size, still flat and still.
- **Moods.** Awake has open eyes; sleep has closed lids; dizzy has crossed eyes, as before.
- **Not a new token.** No colour, type or shape token changed.

## Accessibility and interaction

The target is WCAG 2.2 AA. **Rendered conformance has not been verified.** D1's model is unchanged: skip link, landmarks, focus to heading on route change, keyboard chart with an announced readout, table equivalents, dialog focus traps, Undo.

D2 adds:
- Buddies and crew art are `aria-hidden` and always sit beside text that carries the meaning.
- Shape still encodes provider.
- The year grid has a text summary and per-cell titles. Its cells are pointer targets only; keyboard users reach any day through Custom range and the chart/table. This is a recorded limitation.
- Text selection, caret and form accents are themed.
- Reduced motion keeps fades and removes movement and press scale.

D4 adds or changes:
- **Icon-only controls keep a name.** At phone width the app bar's Refresh label is visually hidden and remains accessible to screen readers.
- **Phone tab bar:** the current tab has `aria-current="page"`; "Sources" keeps the full name "Sources & repos"; the issue count is read as part of the name. **Known trade-off:** the nav is first in the DOM, so at phone width keyboard Tab reaches the bar before the page content although it is drawn at the bottom.
- **Session rows:** the ID is visible, secondary and prefixed "Session ID:" for screen readers; the row's lead is the recorded name or relationship. Expand/collapse buttons are named by name and ID ("Show 2 child agents of planner, thread 7f3a…2c91").
- **Local scrolling is discoverable** (edge shadows, plus a hint in words under the year grid on a phone).
- **Unverified:** stacked phone tables override `display`, which can drop table semantics in some assistive technology.

D5 adds or changes:
- **Evidence level is in text, not only styling.** Each Usage-tree link is `#number` plus a badge whose words (Evidence link, Owner-confirmed, Suggested, Unlinked) carry the meaning, as in Delivery. The "not checked" cases are plain words.
- **The Usage tree's phone layout now overrides table `display`** (the grid described above), so the same semantics caveat applies to it. The header row is kept visually hidden for screen readers. Not verified.

## Content and data provenance

- **Metric definitions, scope labels, evidence classes and guided copy** still come from PRODUCT.md P4.
- **Voice (D2, approved direction):** friendly greetings and empty-state warmth ("Morning, Kelvin", "Let's find your agents", "A quiet one."), with literal numbers and labels. "Great job", streaks, "hours saved", "more productive", productivity scores, cost and a cross-provider token total are still avoided.
- **Per-provider token totals (owner-confirmed, historical review):** each provider's headline total sums every recorded category exactly once:
  - Codex = input + output (cached input and reasoning are subsets and are never added again);
  - Claude Code = uncached input + cache write + cache read + output (separate categories).

  Providers are shown side by side and never combined. This is the presentation rule the owner confirmed. It is **not** established against real provider records, since all token numbers in the prototype are synthetic. Tech Spec must check the category semantics when it inspects real data.
- **Product name:** "Kelvin Agent Crew" is the owner's wording. "Kelvin" now appears in both the brand text and the Overview greeting ("Morning, Kelvin"). I kept both, since the greeting is the personal voice and the brand is the product name; it's easy to change if it reads as repetitive. The owner has asked Product to retitle PRODUCT.md to match (historical review); that is pending.
- **Session names (D4):** the only agent names in the fixture are Paseo agent names (planner, implementer-1, tester-2, reviewer-3 and similar), as the Product evidence describes Paseo carrying agent identity. **No name exists for Codex or Claude Code sessions in the fixture, and none was invented**: those rows lead with the recorded relationship and say "No name recorded". Whether real Codex and Claude Code records expose a session title or summary is unknown; the design says to prefer one when it exists, and Tech Spec must establish whether it does.
- **Paseo status copy (D8):** the two status words and their helper sentences are written by Design from the accepted Tech failure modes and the Implementation's shipped Setup and Sources wording (see [Paseo status words](#paseo-status-words-d8)). They are **not** quotes of messages Paseo or its SDK produces, and no new Paseo behaviour was assumed: that a daemon can require a password and that a stopped one refuses the connection come from accepted Tech inputs (`docs/archive/tech/research.md` R8 and E3 in `data-and-sources.md`), which were read and not re-fetched.
- **All data is synthetic** (`data.js`): repos, logins, session IDs, model names, discovered paths, token counts, and both account reports. The greeting name "Kelvin" and the 9:52 AM clock are fixtures. GitHub links point to fixture repos and won't resolve.
- **Buddies, crew art, the brand mark and HQ's scene and critters** are original authored SVG for this project. No Pixel Agents or third-party assets are used.

## Critique and corrections

I reviewed my own work against the brief, the research and the resolved Impeccable and animate guidance. There was no independent review.

**D1 corrections:** accepted by the owner and still in force.

| D2 finding | Correction |
| --- | --- |
| D1's cool grey canvas, blue action and hard dividers read as enterprise SaaS (owner feedback; contrast with C2/C3 in research) | Warm cream canvas, warm ink and neutrals, grape single action colour, pill navigation and segments, soft warm shadows, filters in one floating panel |
| Playfulness could easily slide into a scoreboard (Pixel Agents' roadmap mentions scores; WakaTime frames ROI and leaderboards) | Playfulness is limited to world, voice and rare moments. Crew rows show literal counts. No streaks, scores or celebratory totals |
| Impeccable craft floor: kicker label above the drawer heading (a ban) | Removed; its context moved into the scope line under the heading |
| Impeccable craft floor: 3px coloured left rule on the Merged PRs KPI | Replaced with a berry-tinted tile (`delivery-surface`) |
| Impeccable craft floor: unicode ✓ in the setup stepper | Replaced with the SVG check icon |
| Impeccable craft floor: browser surfaces at defaults | Themed selection, caret, form accents and scrollbars |
| Animate: approximated easing (`0.2, 0.8, 0.2, 1`), keyframes on toasts and popovers, zero-motion reduced mode | Exact skill curves and durations; transitions with `@starting-style`; entrances emitted for one render only (no replay on re-render); reduced motion keeps fades |
| Animate: re-renders would replay entrances (the whole page re-renders on each state change) | `takeEnter` flags: each entrance class appears in exactly one render; the toast element persists while unchanged |
| Buddies could blur meaning (Paseo isn't a provider; "unknown" must stay distinct) | Paseo uses an icon; unknown relationships use the dashed buddy; the Usage Provider column is plain text, so the mark isn't duplicated |
| D1 untokenized preview literals (danger hover, toast link, row hover, Claude hatch light, rail stroke) | All are named tokens in both the YAML and `tokens.css`; rail stroke uses `coverage-hatch` |

**D3 findings and corrections** (self-review; no independent review):

| D3 finding | Correction |
| --- | --- |
| Opening on This week puts Thu–Sun in the selected period, so a quarter of the first chart is in the future. Showing them as empty bars would read as zero activity | Verified by reading the code, not rendered: future buckets draw nothing, say "Upcoming, no data yet" in the readout and "—" / "Upcoming" in the table, and grey the axis label. This is the first thing to look at when rendered |
| The default week would have hidden the showcase PRs (the multi-provider one, the owner-confirmed one), because they were dated Oct 29–30. The first screen would no longer demonstrate every link class | Moved only their dates into the default week (Nov 2–3). Nothing else in the fixture changed |
| The subscription-window warning compared the ChatGPT window against Last 30 days; against a week it is a much larger mismatch | Same rule and copy; it now reads as a stronger warning on first view, which is accurate. The window is still never used in trends |
| The product name changed after the brand mark was drawn | Name applied everywhere in Design artifacts; mark unchanged. The mark hasn't been reviewed as a final logo |
| "Kelvin" appears in both the brand text and the greeting | Kept; flagged as a possible repetition (Content and data provenance) |
| The Product brief still says "Usage and delivery dashboard", which now disagrees with the Design artifacts | Not edited: PRODUCT.md is Product-owned. Raised as an owner question (Open decisions) |

**D4 findings and corrections from my own review** (separate from the independent critique; no independent review of D4):

| D4 finding | Correction |
| --- | --- |
| D3's phone Refresh button had no accessible name (its label was `display: none`) | Label is visually hidden instead; same for the issue count's words and the tab bar's "Sources & repos" |
| The stale-account caution used a warning box, a status chip and a button for one fact | One chip, one plain caption and the button |
| Group and "unknown relationship" tree rows used `colspan`, which spans the wrong columns when some are hidden on a phone | Every tree row carries the same six cells; the empty state moved outside the table |
| Cards that must work in several widths were relying on viewport breakpoints (the tokens KPI was fine at 241px and broke at 139px) | The tokens ledger and the coverage strip decide from their own width, with the safe layout as the default if container queries are unsupported |
| The new containment tool, the tab bar and the container queries are untested code | Recorded below as limits. The tool was written in its own file so it can't break the app; if it throws, it reports the error instead |
| The fixed bar adds bottom chrome and collides with toasts and the review panel | Toasts, the review panel and the page's bottom padding are offset by the bar's height |

**D8 findings and corrections from my own review** (separate from any independent critique; none was run for D8):

| D8 finding | Correction |
| --- | --- |
| Paseo's first-launch state was drawn as "Access denied" with a "permission denied, allow read access" sentence, but Paseo is a daemon connection, not a folder, so neither the word nor the sentence can be true for it | The first-launch Paseo row is now "Needs a password" with its own sentence. "Access denied" stays a folder word for Codex and Claude Code |
| Paseo's nothing-found state was drawn as "Not found" with a "run it once" sentence; the dashboard can't tell an uninstalled Paseo from a stopped one | "Not running", with "Start it, then check again" |
| The same state had different words in Design, Tech and the product, and the product's coverage strip and Sources row disagreed with its own Setup row | One word per state on every surface, and one table mapping server status to word (above) |
| A never-reached Paseo could be described as having a "last snapshot" | Rule 3: a snapshot is mentioned only when one exists |
| Retry on the old first-launch Paseo row "recovered" it to Found, which would be false for a daemon that still asks for a password | Retry and Check again return the same answer, and the screen says nothing is blocked. I did not invent a way for the dashboard to fix either state |
| The Account-only world still said Paseo was "Not found" after Setup said "Not running" | The Account-only Paseo is "Not running" on Sources and in the coverage strip, with a matching Check again toast |
| Two outcomes of D8 are weaker than before | The D7 "Retry recovers" demonstration and the Paseo-based "Local-read access denied" scenario are gone (see Important states and Open decisions). I chose that over leaving a Paseo state that contradicts the new rule |

**Remaining limits:**
- **D8 has not been rendered or executed.** The prototype edits are small (string maps and one handler) but are untested code. Setup's three answers settle after about two seconds, so any capture must wait for them; a capture taken sooner will show "Looking…" and not either Paseo state.
- **The Setup summary notice** still says "You can fix the rest later in Sources & repos." beside a Paseo that asks for a password, which the dashboard cannot fix. It is accepted wording and outside this request, so it is unchanged. It is worth a look when rendered.
- **Nothing in D4 has been rendered or executed.** No 390px, 320px or desktop check, no keyboard, screen-reader or contrast-tool pass, and no script has run.
- **Container queries** are used for the coverage strip and the tokens ledger. They are supported in current Chrome, Safari and Firefox, but the owner's browsers are unknown; the fallback is the safe stacked layout (capsule and side-by-side forms would not appear).
- **Tab bar:** DOM order differs from visual order (see Accessibility); the safe-area inset has no effect without `viewport-fit=cover`; it is untested on a real phone's browser chrome.
- **Local scroll cue** relies on `background-attachment: local`, which behaves differently in some browsers (notably older iOS Safari); unverified.
- **Year grid** opens on its newest weeks via script, and its scroll position is remembered across re-renders; neither has been run.
- The rounded display voice appears only where `ui-rounded` resolves (Safari on Apple platforms); this is the owner's decision.
- Year-grid cells aren't keyboard-focusable.
- On the first Monday-morning view of a real week, only one day would have data and six would be upcoming. That follows from the owner's default and is by design, but it has not been shown to the owner as a rendered state.
- At 320px the Usage tree's child rows have little room for a name: names wrap at hyphens. Containment, not elegance, is the goal at that width.
- Session names beyond Paseo's are unknown for real data (see Content and data provenance).

## Prototype scope and shortcuts

- **Learning purpose:** the owner approved the D2 world's direction and the D3 screens, states and copy. What remains to learn is whether D4's phone and responsive repairs actually hold when rendered at 390px and 320px, and how the This-week default with its upcoming days reads, without losing D1's clarity and honesty. Flows and states stay testable through the same nine scenarios.
- **Controlled data:** a deterministic fixture. D3 moved only the curated showcase records into the default week; D4 did not change the fixture.
- **Allowed interactions:** local UI state only. There's no network, storage or auth.
- **Shortcuts not to promote:**
  - all D1 shortcuts (full re-render, string HTML, fixed clock, simulated timers, the "private"-name access rule, setup Finish loading the fixture world);
  - plus the fixture greeting name;
  - plus the `takeEnter` render-once mechanism, which works around the re-render shortcut and goes away with a component framework;
  - plus the fixture showcase dates, which were placed to suit the default week and are not meaningful in themselves;
  - plus the **containment check** (`containment-check.js`) and its panel button, which exist only for review and must not be promoted;
  - plus the identity helpers (`sessName`, `sessSub`, `sessRef`): the rule they express is the design, the fixture-specific "only Paseo has a name" logic is not;
  - plus (D8) the Setup discovery answers: fixed results on a timer, and a Retry or Check again that returns the same answer after 0.9 seconds. Real answers come from the server's source statuses; the status words and sentences are the design, the timer and the fixed results are not.
- **File size (kit 0.6.8 rule):** `app.js` is now about 1,330 lines in one file (about 1,280 in D3; D4 added roughly 50). Keeping it together is deliberate: it's string-built presentation code for a design prototype that Tech Spec re-architects into components, so splitting it now would add churn without a lasting benefit. The new review tool went into its own file so `app.js` did not grow for it. It is not a production structure and should not be promoted as one.
- **Reuse candidates for Tech Spec to audit:** tokens, buddy and crew-art SVGs, the aligned-chart and year-grid drawing logic with their coverage semantics, the badge and status vocabulary, and copy.

## Requirements coverage

The mapping is unchanged from D1 (P-04–P-44 as listed there). D2 and D3 add no requirement and remove no state. The year grid is an additional view of P-09 / P-13 / P-19 data (12-month lookback, period selection, merge dates). The This-week default is a choice within P-09 (supported review periods), and the upcoming-days treatment is a design extension of P-05's unavailable-vs-zero distinction: P-05 itself only names dates before available history, so showing not-yet-happened days as neither zero nor unavailable is a Design choice for the owner and Tech Spec to confirm.

## Checks

- **Performed this attempt (D8):**
  - Read the entry files and kit references named in the assignment, the frozen accepted bundle and its manifest, and the accepted DESIGN.md, identity, research, prototype and style-guide files. The checkout's twelve design files were hashed with `shasum -a 256` and matched the accepted hashes before editing (for example `DESIGN.md` `cfa4e1bc…1e51f`, `design-system/DESIGN.md` `876e3c0d…53dc9`). The Product and Tech documents in the checkout also matched their accepted hashes.
  - Found every place the accepted sources name Paseo's password and not-running states (Design, `data-and-sources.md`, `design-to-code.md`, `TECH.md`, the Implementation execution record) and read the current Setup and Sources code in the working tree for the same words. The code is read-only evidence, not an accepted input.
  - **Cause and consistency check by reading:** every Paseo word and sentence in `app.js`, `data.js`, `ui.js`, `style-guide.js` and `style-guide.html` was compared with the tables above; every status key used (`needspassword`, `notrunning`) has an icon entry in `ui.js` and in the coverage-strip icon map; the Retry handler was re-read for brace and scope balance (the `case` now has a block, so its `const` can't leak); the unused `paseoRetries` field was removed with its only use; `data.js` and `style-guide.js` edits were re-read for syntax.
  - Colour, type, shape and spacing tokens were not touched, so `tokens.css` and the identity's YAML were not re-compared.
  - **Not performed (and so not claimed):** any rendering, script execution or syntax check by a tool; screenshots; keyboard, screen-reader, zoom, touch or contrast checks; the two Setup states at 1280, 390 or 320px; `@google/design.md` CLI validation; any new research (none was needed; see research.md › Reuse in D8); reviewer calls (PDLC owns them).
- **Performed this attempt (D5):**
  - Read the frozen D4 files, the critique findings and the preview's `app.js`, `app.css`, `ui.js`, `style-guide.js` and `style-guide.html` around the Usage tree.
  - Confirmed by reading that `linkMap` is used only by the Usage tree, that `U.linkBadge` and the `lb-*` styles already exist (so no new token), that `isTracked` is defined before use, and that every new class (`sess-row`, `tok`, `plc`, `pl-item`) has a rule in `app.css` and is mirrored in the style guide's phone specimen.
  - **Not performed:** any rendering, script execution or syntax check; contrast, keyboard and screen-reader checks; container-query and real-device checks; reviewer calls (PDLC owns them). The D4 "not performed" list below still stands for everything D5 did not touch.
- **Performed in the D4 attempt:**
  - Input hashes (`PRODUCT.md`, `discovery-evidence.md`), the role file and the result schema were recomputed with `shasum -a 256`; inputs and schema are unchanged and the role matches the envelope. The four SKILL.md version lines were read (0.6.8).
  - The published D3 files were hashed before editing and all matched the hashes recorded at D3, so I was repairing the published revision.
  - Impeccable `adapt`, `layout` and `harden` were read from the pinned snapshot.
  - **Cause analysis by reading `app.css`, `app.js` and `ui.js`** for each finding (recorded in the repair record). This is source reading, not measurement.
  - Every `var(--…)` I added resolves: `--bottomnav-h`, `--shadow-nav` and `--scroll-edge` are defined in `tokens.css`, and `--hs-bg` is defined in the rule that uses it. All 17 new class names used by the scripts have rules in `app.css`.
  - The responsive section of `app.css` and the new and changed functions in `app.js` and `style-guide.js` were re-read for syntax and balance after editing.
  - Grep for removed constructs: no `colspan="7"`, no "Paseo agent" column header, no leftover old coverage markup remain in the prototype.
  - The 35 colour tokens in the identity YAML and `tokens.css` were **not** re-compared this attempt: neither colour block was edited (D4's `tokens.css` and identity changes are additions and comments only), and they matched at D3.
- **Not performed (and so not claimed):**
  - **Any rendering** of the prototype or style guide: no 1280px, 390px or 320px view, no screenshots of Overview, expanded Usage or recovery. The screenshot tool only loads public URLs, and no browser was available.
  - **Any script execution.** `app.js`, `ui.js`, `style-guide.js` and `containment-check.js` have not been run or syntax-checked by a tool. In particular the containment check has never been run, so its output format and its false-positive rate are unknown.
  - Reproducing the duplicated-header artifact.
  - Keyboard, screen-reader, zoom, touch or contrast-tool checks; a real-device check of the tab bar.
  - Re-computing contrast: no colour changed, so the D2 figures stand.
  - `@google/design.md` CLI validation.
  - Impeccable's detector scans.
  - Token propagation into Astryx.

## Open decisions

**Settled by the owner** (carried forward, no longer open):
1. The D2 playful-minimal direction and identity values: approved, historical review (topic-scoped).
2. The D3 screens, states and copy: approved for technical handoff, historical review (scoped to the D3 revision; D4 changes parts of them, see below).
3. Default period on open: **This week**.
4. Rounded display font: **system `ui-rounded` stack, no font files**.
5. Light theme only for the MVP; dark mode deferred.
6. Product name: **Kelvin Agent Crew**.
7. Per-provider token total: **all categories counted once** (Tech Spec to verify against real records).
8. Original request truncation: closed.
9. PRODUCT.md title: **ask Product to retitle it** (historical review). The decision is made; the action is Product's and has not happened.

10. **Acceptance of D4's changes** to the phone tab bar, compact coverage strip, tokens ledger layout, Usage tree rows and session identity wording: **approved** (historical review, topic-scoped, as design; not rendered or technical acceptance).
11. **Where rendered evidence for D4 comes from:** **Verification, after implementation** (historical review). Design does not need to close it.

**Still open:**
1. **Rendered evidence for D4 is not held by Design.** The owner has since said they verified it and have nothing to follow up (historical review); no capture or tool output reached Design. Originally this was Verification's job: 1280px, 390px and 320px views, updated Overview, expanded Usage and recovery captures, and the containment tool's output (the Capture checklist). Until then "fixed" in the repair record means "changed in the source for a cause found by reading", not "seen working". Accepted risk, stated by the owner's own choice: a layout defect may be found only after Tech Spec and implementation have built on D4. If it is, it returns to Design.
2. **The duplicated-header artifact** (finding 5): needs a reproduction (window size, scroll offset, scenario, whether the capture was stitched). Verification's rendered pass is the natural place to look for it.
3. **D8: acceptance of the two Paseo words and sentences** ("Needs a password", "Not running", the helper sentences, the Retry and Check again buttons and the screen criteria). Put to the owner in Review; nothing here records an answer.
4. **D8: a Setup scenario for a folder that can't be read.** D8 removed the only scenario that showed "Access denied" in Setup, because it used Paseo. The word and sentence are unchanged and specified. Recommendation: leave it out for now (it is outside this request), and ask for it as separate work if you want it drawn. Put to the owner in Review.

**Returned to Product (via the orchestrator):** retitle `PRODUCT.md` and any "Usage and delivery dashboard" mentions to Kelvin Agent Crew, with no change to scope, requirements or metrics. Design did not and cannot edit that file.

**For Tech Spec (not decisions for the owner):**
- **D8, Paseo status words:** edit the documents Design cannot: the `paseo` row of `data-and-sources.md` (replace "Design's 'Access denied' copy maps to `needspassword`… 'Not found' maps to `notrunning`…" with the mapping in [Source mapping](#source-mapping-server-status-to-word)), the two Paseo strings in `TECH.md`'s failure modes, and add the Not running sentence to `design-to-code.md` Setup criterion 3. Then hand the three product differences listed under [Reconciled sources](#reconciled-sources) to Implementation;
- confirm that real Codex and Claude Code records expose a session **start** time. The prototype labels every session time "Started" (D7); if the real field is something else (last activity, a range), the label changes with it;
- verify the token-category semantics against real provider records;
- find out whether real Codex and Claude Code records carry a session title or summary that should lead a session row in place of the relationship fallback;
- settle DOM-versus-visual order for the phone tab bar (see Accessibility) and the touch-target, input-size and safe-area observations in the repair record;
- the system-rounded font renders differently by browser; dark mode is out of scope; the Astryx/Tailwind mapping in the style guide is unverified, as is the container-query support Tech Spec wants to rely on; and whether the app should remember the last-used period is open for implementation.

## Handoff readiness and next action

This brief records design intent and historical checks, not a current rendered product assessment.
Earlier design handoffs deferred rendered verification. Responsive containment, keyboard and
assistive-technology behavior, exact component mapping and source-status copy still require checks
against the implementation being assessed. Historical owner feedback does not replace those checks.

Use the [current mapping](docs/tech/design-to-code.md),
[sanitized design history](docs/archive/design/history.md) and
[release limitations](docs/delivery/public-release-review.md). Private workflow receipts and
review conversations are excluded; substantive open limitations remain documented.
