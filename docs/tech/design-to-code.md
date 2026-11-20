# Design system to code (T1–T5, scoped clarification T6)

Supporting contract for [TECH.md](../../TECH.md). It maps the accepted design to production code without restyling it.

The D7 design brief, canonical tokens and prototype supported the original production mapping.
The [archived design research](../archive/design/research.md) records the earlier visual decisions.

The T6 clarification compared historical M10 Setup captures against the prototype and the
[Setup API boundary](local-api.md#setup-progress-and-api-boundary). The retained synthetic
[captures](../implementation/evidence/m10/README.md) illustrate the geometry from that candidate.
The clarification added no new browser measurements.

## Product follow-up

The dashboard and Setup show a project credit below their content. Its GitHub link opens in a separate tab.

The [current design brief](../../DESIGN.md#product-follow-up) specifies the following production
composition. The earlier prototype comparisons below remain evidence for their captured revisions.

- Overview renders the aligned chart, Recently merged and By repository, then Account-reported
  usage, in that DOM and reading order. At viewport widths of 1280px and above (D9) the grid
  places the chart in eight of twelve columns and the account section in the other four,
  top-aligned on the first row; Recently merged and By repository span all twelve columns below.
  At narrower widths the account section follows the activity sections. It shows weekly plan
  utilization and reset times, including Claude’s five-hour window inline. The section’s repo-scope
  badge sits beside the heading. Sources links appear when an account needs setup or reconnection.
- Sources reads the coverage summary from its existing Sources and tracked-repo requests. Show
  timestamped groups in a card, collapsed below 720px. Overview leads with its headline metrics
  and keeps refresh warnings. Usage keeps the coverage disclosure with its **Manage sources** link.
- Setup and Sources share a repository picker. The active GitHub sign-in supplies suggestions.
  Each result keeps its tracking action inline. Full slugs and pasted GitHub URLs remain valid.
- Source labels describe current availability. A refresh banner represents a recorded failed
  attempt. Last attempt and last success are distinct, and the retained-data line depends on
  `SourceStatus.hasRetainedData`. The **Sources & repos** nav item shows a badge when the issue
  count is positive. The app bar shows **Refresh**.
- In Setup, signed-out owners can choose **Connect GitHub** or **Continue without GitHub**.
  Registration details open on demand. A disconnected owner can return to Accounts or finish
  Setup from the repository step. The connection and repository requirements apply to delivery.
- On phones below 720px, a Delivery suggestion shows session identity, tokens and the basis
  beside its badge before wrapping actions. Explain session token scope once per expanded panel.
  Preserve the decision actions, Undo and focus return.
- The recovery HTML uses the Agent Productivity HQ wordmark, a warm rounded card, tinted reassurance and numbered
  steps. Render it from the server when the application cannot start, with the case-specific
  diagnosis and instructions. See [local setup](../delivery/setup.md#when-something-is-wrong).

## D9: Cozy Logbook, Refined

Owner decision 2026-11-18, chosen through an Impeccable redesign round. [design-system/DESIGN.md](../../design-system/DESIGN.md) "What changed in D9" is the contract; **no colour hex changed**. The production mapping:

| D9 rule | Production mapping |
| --- | --- |
| **Typography: Nunito for display roles** | `typography.metric`, `title-page` and `title-section` lead with `'Nunito'` in `design-system/DESIGN.md`; `pnpm tokens:generate` emits `--font-display` (and the `docs/design/prototype/tokens.css` mirror carries the same line, as `test/tokens/parity.test.ts` requires). The three display roles must keep one identical `fontFamily` string, because the generator's `familyVar` maps a stack to `--font-display` by exact match. Body, label, data, caption and mono stay on the system stacks. |
| **Font file** | `@font-face` in `src/client/theme/globals.css` points at `./fonts/nunito-latin-wght.woff2` (one variable-weight 600 to 800 latin subset, `font-display: swap`; SIL OFL licence in `src/client/theme/fonts/OFL.txt`). Vite resolves and hashes the URL and the Hono server serves it as a static asset with the rest of the client build, so nothing is fetched from a font CDN and the outbound boundary is unchanged. The startup recovery page (`src/server/http/recovery/layout.ts`) is a standalone document that does not load the file; it keeps its system stack. |
| **Font file for HQ's scene** | A second `@font-face` in `globals.css` points at `./fonts/playpen-sans-latin-wght.woff2` (Playpen Sans from the Fontsource package `@fontsource-variable/playpen-sans` 5.3.0, latin, weight axis only, 100 to 800, 196 KB, `font-display: swap`; SIL OFL licence in `src/client/theme/fonts/OFL-PlaypenSans.txt`). It is **not** a design token: the family is named once, as `HAND_FONT` in `features/hq/HqScene.tsx`, ahead of the system handwriting faces (the fallback), and is used only on the scene's own text (heading, signs, captions, bench count), never on the roster. It is not preloaded, as Nunito is not. The build copies its licence to `dist/client/licenses/Playpen-Sans-OFL.txt` and lists it in the third-party notices (`scripts/third-party-notices.ts`), as for Nunito. Sign text is cut by `fit` and `fitSecondLine` in `Room.tsx` (0.54 em a character; the first line is the session's title, else the repository or workspace name, and the second is "place · state" with the place cut first and the state kept, so the state is never cut for it; a room with a star gives both lines `STAR_CLEARANCE` less width) and neighbouring captions are staggered by `captionsCollide` (0.56 em): both use estimates so layout never waits for the font. |
| **Segmented control selected state** | `globals.css` rule on `.astryx-segmented-control-item[aria-checked='true']` (grape tint, grape text, `0 0 0 1px var(--color-action)` ring, faint shadow). Radius and the 44px phone hit area are unchanged. See the Component map row. |
| **Evidence link badge** | Grape-tint pill with a leading dot on `LinkBadge`. Owner-confirmed, Suggested and Unlinked are unchanged. |
| **Filter bar** | `PageHeader` renders the route title, optional subtitle and actions, then the filter bar the shell placed in the filter slot. From 720px the bar is two groups that wrap as wholes: period segment + Custom with the "Filters · n" popover (the route's other groups), then the date range and timezone caption, on one row where they fit and on the next line otherwise. Each route registers only the filters it uses; Sources registers none, so no bar renders there. The phone sheet is unchanged. Filter state stays URL-owned. |
| **Sparkline** | A decorative SVG (`aria-hidden`) over 12 Monday-start weekly values, on the Merged PRs KPI and each provider's local tokens KPI only. Each line is scaled to its own min and max, ends in a filled dot in the series colour (berry, teal, terracotta) for the current week, and breaks at a `null` week instead of drawing zero. Providers are never combined. The SVG is wrapped in a `role="img"` element whose name lists every week and this week's value, prefixed with the provider for token lines. The weeks come from `useKpiTrend` (`lib/analytics.ts`): `/api/series` at week granularity for the 12 weeks ending with the current week, independent of the selected period, with the current repos, provider and author; a kept answer from a previous filter is not drawn. No tokens are allocated to PRs. |
| **KPI crew cluster** | Three `Buddy` components at 16px (shape by provider) plus "+N" for the remainder, in place of the nine-buddy row. Decorative beside the literal count. |
| **Account card** | D9 originally put caveats and Claude's shorter windows behind "Why?" and showed a Sources action on healthy accounts. [Product follow-up](#product-follow-up) defines the current account section. |
| **History unavailable** | A dot-stipple pattern in the chart's coverage rail (`coverage-hatch` on `surface-sunken`), so the diagonal `hatch-light` hatch means only Claude Code. The textual coverage statement is unchanged. |
| **Upcoming days** | Chart x labels for days after today render in `text-muted` and one "Upcoming" caption names them; the buckets stay empty. |
| **Navigation** | Sources & repos is an item in the nav list (and keeps its issue badge). |

Verification stays with the existing gates: `pnpm tokens:check` for the token contract, and the rendered functional, accessibility and responsive groups for the filter bar, segmented control and sparklines. This section records the mapping; it is not rendered evidence.

## D5–D7 delta (T5)

What changed in the accepted design since T4, and what it does to this mapping:

| Design change | Technical consequence | Where |
| --- | --- | --- |
| **D5** Every linked PR in the Usage tree shows `#number` plus Delivery's badge. Unlinked is explicit. Where PRs were never checked the cell says so in words. | `Session.linkStatus` and class-bearing `linkedPrs` in the API. New `SessionLinks` component reuses `LinkBadge`. A fifth not-checked case (`prs_not_collected`) has no designed copy. | [local-api](local-api.md), [data-and-sources › Usage-tree link status](data-and-sources.md#usage-tree-link-status), component map |
| **D5** At ≤ 639px each Usage-tree session is a two-line card: identity across the full width, then Tokens and Linked PRs on one labelled line. Group rows keep one line. | The prior T1 decision "the Usage tree stays a real table" no longer matches the design. Below 640px the tree renders as a nested list (same decision as Delivery), so no table semantics are overridden with CSS. | [Responsive and accessibility decisions](#responsive-and-accessibility-decisions) |
| **D6** Provider, model and time shown once on a phone card (the duplicate was a cascade bug: a more specific `display: block` rule beat `.hide-sm`). | The list component renders the identity block once and has no hidden duplicate cells, so this class of bug cannot exist in the production structure. A test asserts it. | Component map › Usage tree; TECH › Verification |
| **D7** Desktop Provider, Model, Started, Merged and Active cells never wrap. The first column absorbs spare width. A too-narrow table scrolls locally. | Column policy in the component map. The local scroller gets a keyboard-focusable region. A containment assertion checks "no wrapped data cell". | Component map › Tables; responsive decisions |
| **D7** Repository token totals: one provider per line, right-aligned, tabular figures, same layout on every repository row. | `TokenStack` rule below. | Component map › Usage tree |
| **D7** Count labels agree with their numbers ("1 session", "2 roots"). | `plural` is `Intl.PluralRules`-based and covered by a unit test. | Prototype reuse audit |
| **D7** One label, "Started", for every session time. | `Session.startedAt` with a defined source, rule and fallback. Real-record confirmation is E1 and E2. | [data-and-sources › Session start time](data-and-sources.md#session-start-time) |
| **D7** Retry shows "Retrying…" with a disabled button, then clears (success) or keeps the banner with "failed again <time>" (failure). | `SourceStatus.consecutiveFailures`, the refresh-run poll, and copy rules below. | Designed state → behaviour |
| **D7** On a phone the repository group row's fill spans the whole row. | Presentational, in the list component. | Component map › Usage tree |

**Tokens.** `design-system/DESIGN.md` D7 states its colour, type and shape values are unchanged, and `tokens.css` is byte-identical to D4. A count of two-space-indented `key: value` lines in the whole file is the same in the D4 and D7 identity files (52 each). That is a coarse structural check, not a value-by-value comparison. The T1 parity test (`pnpm tokens:check` against `tokens.css`) is the authoritative check and Implementation runs it in slice 0.

## Foundation wiring

**Stack:** React 19, Tailwind CSS v4.3 (`@tailwindcss/vite`), and Astryx (`@astryxdesign/core`, `@stylexjs/stylex`, a stock theme extended with `defineTheme`), per research R13, R14 and R18. Astryx package versions are pinned at setup from npm, with the lockfile committed.

**Global CSS (proposed `src/client/theme/globals.css`; layer order from R13):**

```css
@layer reset, theme, base, astryx-base, astryx-theme, components, utilities;

@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/preflight.css" layer(base);
@import "@astryxdesign/core/reset.css";
@import "@astryxdesign/core/astryx.css";
@import "@astryxdesign/theme-stone/theme.css";          /* warm-neutral base; overridden below (E7 confirms) */
@import "@astryxdesign/core/tailwind-theme.css";
@import "./generated/tokens.css" layer(astryx-theme);    /* product tokens win over the stock theme */
@import "tailwindcss/utilities.css" layer(utilities);
```

The stock theme is only a base. `theme-stone` is chosen because Astryx describes it as warm neutrals (R14). Every product colour, type, shape and space value comes from `design-system/DESIGN.md`.

## One token contract

`design-system/DESIGN.md`'s YAML is the **single canonical source**. A build script generates every downstream artifact, so values can't drift:

```text
scripts/generate-tokens.ts  (proposed)
  read design-system/DESIGN.md front matter (YAML)
  + LAYOUT_EXTENSIONS = { bottomnav-h: 64px, shadow-nav: …, scroll-edge: … }   # D4 prose-only tokens, see note
  + MOTION = { ease-out, ease-in-out, ease-drawer, dur-press … dur-pop }        # identity › Motion table
  emit src/client/theme/generated/tokens.css      # :root { --color-*, --type-*, --radius-*, --space-*, … }  (same names as prototype tokens.css)
  emit src/client/theme/generated/tailwind.css    # @theme { --color-canvas: var(--color-canvas); … } so utilities like bg-canvas, text-muted exist
  emit src/client/theme/generated/crewTheme.ts    # defineTheme({ extends: stone, … }) overrides mapping roles → Astryx tokens (keys verified in E7)
pnpm tokens:check  → regenerates in memory and fails CI if any generated file differs
```

**Note for Design (non-blocking):** the three D4 layout tokens (`--bottomnav-h`, `--shadow-nav`, `--scroll-edge`) exist only in prose and `tokens.css`, not in the YAML. The generator carries them as named extensions with a comment pointing at design-system/DESIGN.md › Layout. Moving them into the YAML later is a Design edit and needs no code change beyond deleting the extension map.

| Foundation (canonical) | CSS custom property | Tailwind utility (via `@theme`) | Astryx theme role (E7 verifies keys) |
| --- | --- | --- | --- |
| `colors.canvas` `#FBF8F3` | `--color-canvas` | `bg-canvas` | page background |
| `colors.surface` / `surface-sunken` | `--color-surface`, `--color-surface-sunken` | `bg-surface`, `bg-sunken` | surface / subdued surface |
| `colors.text` / `text-muted` | `--color-text`, `--color-text-muted` | `text-ink`, `text-muted` | primary / secondary text |
| `colors.action` / `action-hover` / `on-action` / `focus` | `--color-action…` | `bg-action`, `text-action`, `ring-focus` | primary / accent, focus ring |
| `colors.control-border`, `border`, `border-strong` | `--color-control-border…` | `border-control` … | control edge / divider |
| `colors.success*`, `warning*`, `danger*` | `--color-success…` | `text-success`, `bg-warning-surface` … | status roles |
| `colors.series-*`, `heat-1…4`, `coverage-hatch`, `hatch-light`, `delivery-surface`, `sunshine` | same names | used only by chart/buddy components | **not** mapped into Astryx (product extensions) |
| `typography.metric … mono` | `--type-*` font shorthands + `--font-display/sans/mono` | `font-display`, `text-metric` … | Astryx text styles: body and label families → system sans, headings → display stack |
| `rounded.sm/md/lg/pill` | `--radius-*` | `rounded-sm/md/lg/full` | component radius scale |
| `spacing.xs…3xl` | `--space-*` | Tailwind spacing via `@theme` | Astryx spacing (4px base matches) |
| Elevation (prose) | `--shadow-card`, `--shadow-overlay`, `--shadow-press`, `--shadow-nav` | `shadow-card` … | elevation tokens |
| Motion (identity table) | `--ease-*`, `--dur-*` | `ease-crew-out`, `duration-press` … | Astryx motion tokens if overridable (E7), else wrapper |

**Evidence obligation (frontend-standards › design-system):** E7 and the Verification stage must show one token change (`--color-action`) reaching both an Astryx `Button` and Tailwind-styled app UI in a rendered page.

## Component map

"Astryx" means the library component themed by the token contract. "Custom" means a product component in `src/client/components/` built with Tailwind utilities on the same tokens. **No styled-components** (frontend-standards).

| Design pattern (guide section) | Implementation | Props / semantics contract | Notes and to-verify |
| --- | --- | --- | --- |
| App shell, side nav ≥ 1024, pill nav row 720–1023 | Astryx `App Shell`, `Side Nav` / `Side Nav Item` | `<nav aria-label="Sections">`; items are links with `aria-current="page"` | Pill styling from tokens. The row variant is a horizontal `Side Nav` or custom if unsupported (E7). |
| **Phone tab bar < 720** (D4) | Custom `PhoneTabBar` (a `<nav>` of links) | Five equal links, icon over 12px label. "Sources" is visible with full name "Sources & repos" via `VisuallyHidden`. Issue badge is read as part of the name. `aria-current`. Height `--bottomnav-h` + `env(safe-area-inset-bottom)`. | Resolves DOM order (see [Responsive and a11y decisions](#responsive-and-accessibility-decisions)). Astryx `Mobile Nav` is a toggle drawer, not a tab bar, so it isn't used. |
| **HQ app-bar link < 720** | Custom `AppBarLinks` (a `NavLink` per `NavItem` with `phone: 'appbar'`), drawn in the app bar's actions with `APPBAR_BUTTON` | An icon with a visually hidden name ("HQ"), `aria-current="page"` when active, a 44px target, `min-[720px]:hidden`. | `PhoneTabBar` draws only the items without that flag, so it keeps five tabs. Not drawn on Setup. |
| **HQ roster** (`features/hq`) | Custom `Roster` (nested `<ul>` per session, one `Row` per agent), `FeedLine` (a feed's `StatusTag` and words), `states.tsx` (loading, request error with Retry, no live source, quiet), pure `sessions.ts` and `copy.ts` | A `<ul aria-label="Sessions">` of cards; each card holds a list named for its root, the root first, its agents in a nested list (indented for three levels, flat below that). Rows are not focusable; no `aria-live`. `Buddy` is decorative. A card with a waiting agent uses `border-warning` / `bg-warning-surface`. | Existing tokens only. The scene (next row) mounts above it in `route.tsx` when there is at least one agent. Polled by `useHq` (2 s; 10 s after an error). |
| **Claude Code hooks for HQ** | Shared `ClaudeHooksSwitch` in `components/`. `HqHooks` renders it on Sources and `HooksFirstRun` renders it in an Astryx dialog on the first eligible HQ visit. Copy lives in `lib/hooksCopy.ts`. | Sources gives the control a labelled section. The dialog has a labelled title, traps focus and closes on Escape. A browser storage flag records that it was shown. | The disclosure reads the action's preview. Confirmation sends its fingerprint to `PUT /api/hq/claude-hooks`, then refreshes the preview and status. The command wraps and the mobile buttons have 44px targets. |
| **HQ quiet room** (`features/hq`) | Custom `AfkScene` (one SVG room on the scene's notebook page, reusing `Heading`, `Roof`, `Vent`, `Ground` and `PAGE_CLASS` from `HqScene` and the desk, mug, plant and door from `art.tsx`), mounted by `HqQuiet` in `states.tsx` | The root is `aria-hidden="true"`, `data-testid="hq-afk"`, nothing focusable, no `role`, `title` or name. "AFK" and "back soon" are SVG `<text>` in `HAND_FONT`, their words held in `AFK_COPY`; the sentence `HQ_COPY.quiet` is a `text-caption` footnote beneath and is the statement of the state. | Shown only in the quiet state (a live feed, none with a problem, no agents); the unavailable, setup, loading, error and "No agents to show right now." states do not draw it. The room's box is 480 by 254 units, scaled to the page's width up to 720px, so "AFK" (68 units) is about 40px on a 320px phone and about 90px on a desktop. Existing tokens only; no character, so no idle or sleeping state is implied. Three wobble filters from `useSceneFilters`; the chair's backrest turns with `hq-swivel` (`SWIVEL` in `motion.ts`). |
| **HQ scene** (`features/hq`) | Pure `scene.ts` (`layoutScene(prev, sessions, { columns, nowMs })`: rooms, slots, grid, poses, captions, mood; reuses `buildSessions`) and `stage.ts` (where characters stand and how small a crowd is drawn). `HqScene` (the page, roof, ground and room grid; `useMediaQuery` picks 1, 2 or 3 columns), `Room` (one room in its own SVG box), `Character` (fox, owl, blob), `art.tsx` (path data ported from the approved mockups), `sketch.ts` (seeded hand-drawn strokes for walls, signs and washes), `sceneFilters.tsx`, `motion.ts` | The root is `aria-hidden="true"`, with no focusable or interactive part, no `role`, `title` or live region. A room's `<svg>` is `data-testid="hq-room"` (`data-mood`, `data-session`). Signs, captions and the heading are SVG `<text>` outside the filtered groups, in the scene's handwriting, held once as `HAND_FONT` (Playpen Sans first, then system handwriting faces; see "Font file for HQ's scene" above). | Colours are utility classes on the generated tokens (`fill-series-claude`, `stroke-ink`, `fill-sunshine`, …); **no raw hex and no new token**. A room's width in units is 420 (two columns), 360 (three) or 290 (one column on a phone), so text stays about 11px or more. Every session has a room and the building has the screen's column count however few or many sessions there are; it grows one row per `columns` sessions and nothing is folded. A room keeps its slot while its session is present, a vacated slot is drawn as an `EmptyRoom` until a new session takes the lowest free one, rows after the last occupied slot are dropped, and a change of column count closes the slots up in their old order. The previous scene is held in state and replaced only when a slot changes. Three wobble filters per scene, ids from `useId`, named to the keyframes through `--hq-wobble-a/b/c`. |
| Buttons: primary, secondary, ghost, danger, small; busy; disabled with reason | Astryx `Button` (variants primary / secondary / ghost / destructive), `Icon Button` | `label`, `onClick`, disabled + nearby reason text, busy state | Tactile bottom edge (`--shadow-press`) and `scale(0.97)` press via the theme or `className`. If Astryx press feedback conflicts, keep Astryx behaviour and record it (E7). |
| Segmented control (period, provider, author, link basis, chart/table) | Astryx `Segmented Control` | Single-select group. Wraps inside its container under 720 (D4). | Semantics: Astryx's (radio-group or pressed). Its own semantics win over the prototype's `aria-pressed` lookalike. **D9:** the selected segment is a grape tint (`--color-selection-surface`), grape text (`--color-action`) and a 1px `--color-action` ring, set in `globals.css` on `.astryx-segmented-control-item[aria-checked='true']` (kept out of forced-colors mode, where Astryx's Highlight pair stays). The filter bar's own **Custom** trigger, which is not an Astryx segment, must draw the same state with `aria-pressed:bg-selection-surface aria-pressed:text-action` and an `--color-action` ring so the track reads as one control. |
| Filter bar (D9: one title-first row) / phone filter summary → bottom sheet | Custom `FilterBar`, rendered by `PageHeader` (`src/client/components/PageHeader.tsx`) from the shell's filter slot (`src/client/lib/filterSlot.tsx`). Sheet via Astryx `Bottom Sheet`. | Row order: page title (the route's `<h1>`), then period segment + Custom and the **"Filters · n"** button, then the date range and timezone caption (wrapping together to a second line where the row is too narrow). The button opens a popover with the route's other groups; scope labels stay in each group label ("Repos · usage & delivery"). A route shows only the filters it uses (Sources none). Below 720px the sheet and its summary are unchanged: traps focus, Esc closes, focus returns to "Filters". | Filter state is URL-owned (see TECH › State). `n` counts active non-default filters. See [D9](#d9-cozy-logbook-refined). |
| Custom range popover, repo filter popover | Astryx `Popover` + `Date Range Input` + `Checkbox List` | Grows from trigger (`--dur-popover`, origin top-left). Validation messages inline. | Date inputs at 16px on phones (iOS zoom; see decisions) |
| Records drawer | Astryx `Drawer` | `role=dialog`, `aria-modal`, labelled by heading. Inset 8px, `lg` corners. Focus to heading, return to bucket on close. | Motion: `--ease-drawer` 320ms |
| Toast with Undo | Astryx `Toast` / `useToast`, styled with product tokens | Polite live region. Undo button. 8s with undo, 5s without. | Centered dark pill with visible actions and wrapping text. Lifted above the phone tabs and safe area. |
| Confirm "Stop tracking" | Inline custom `ConfirmPanel` (danger surface) | Group with label. Cancel left, Stop tracking right. Esc cancels. | Matches prototype; not a modal |
| Cards, KPI tiles | Astryx `Card` + custom `KpiCard` | Label, scope line, value (display stack), meta. Merged PRs on `delivery-surface`. **D9:** Merged PRs and each provider's local tokens KPI carry a `Sparkline`; Root sessions and Child agents show a crew cluster (3 buddies at 16px + "+N"). | `container-type: inline-size` on KPI |
| **Provider ledger in tokens KPI** (D4) | Custom `ProviderLedger` | Stacked (label left, value right) by default. Side by side at `@container (min-width: 200px)`. Never sums providers. | Tailwind v4 `@container` / `@[200px]:` variants |
| **Provider token ledger (Usage)** (D4) | Custom `TokenLedger` (a `<table>` with caption) | Numbers `nowrap`, tabular, right-aligned. Subsets indented with elbow and "included in input/output" note. Total row. | Data from `/api/usage/categories` |
| **Coverage strip** | Custom `CoverageStrip` | Collapsed phone disclosure below 720px; expanded groups on wider screens, with a capsule at 900px of container width. | Named **Source coverage** region and disclosure on phones |
| Failed-refresh banner (D4, D7) | Astryx `Banner` (warning) or custom if layout can't match | The one prose explanation. Actions row: View source, then Retry (primary, right). **Retry states (D7):** idle "Retry"; in progress "Retrying…" with `aria-busy` and `disabled`, announced politely; success clears the banner; failure keeps it with the attempt line from `consecutiveFailures` ("failed <time>" or "failed again <time>"). | `role="status"`. Driven by `GET /api/sources` and the polled `GET /api/refresh/{id}`. |
| Status tags (Found, Partial, Refresh failed, Access denied, Reconnect needed, Looking…) | Custom `StatusTag` (icon + text) | Never colour-only | Icon set ported from `ui.js` ICONS |
| Link-basis badges (evidence, owner-confirmed, suggested, unlinked, marked incorrect) | Custom `LinkBadge` on Astryx `Badge` if variants allow fill/outline/dashed, else custom | Fill style encodes class plus the text label. **D9:** Evidence link is a grape-tint pill (`--color-selection-surface`, `--color-action` text) with a leading dot, not solid ink | — |
| Aligned delivery/usage chart | Custom `AlignedChart` (SVG, React) | Two panels, separate y-axes and units. Coverage rail. Hatch patterns. `role="group"` with roledescription "chart". Arrow keys / Home / End / Enter. Live readout. Chart/Table switch. **D9:** history unavailable is a dot stipple (the diagonal hatch means only Claude Code); upcoming days are labelled in `text-muted` with one "Upcoming" caption. | Port of `ui.js › alignedChart`. `@astryxdesign/charts` not used: its fit for dual-axis coverage semantics is unverified and Design specified custom SVG. |
| Year of merges | Custom `YearGrid` (SVG) | Text summary, per-cell `<title>`. Cells are pointer targets (keyboard via Custom range and chart/table, an accepted limitation). Local horizontal scroll with edge cue; opens on newest weeks. | Port of `ui.js › yearGrid` |
| Agent buddies and crew art | Custom `Buddy` and `CrewArt` SVG components | `aria-hidden`, always beside text. Moods awake / sleep / dizzy / search. Since 2026-11-19 the buddies are HQ's critters (a round orange fox with pointed ears and a pale muzzle for Claude Code, a boxy teal owl with a yellow-tipped tuft and ringed eyes for Codex, a dashed blob for unknown), redrawn flat for 16 to 20px in `Buddy.tsx` with existing tokens only; `CrewArt` places the same shapes at about 2x. HQ's hand-drawn art (`features/hq/art.tsx`) is separate and unchanged. No filter and no animation in either component. | Authored for the project; the first version ported paths from `ui.js` |
| Logo and favicon | `BrandMark` and the browser tab share [Logbook](../../public/logbook.svg). | Empty alt text beside the product name. | [Paseo sidebar mark](../../plugins/paseo-agent-productivity/client/logbook-icon.ts) |
| Usage tree (repo → root → children; Unknown relationship group) — **≥ 640px** (D5–D7) | `UsageTreeTable`: Astryx `Table` + `useTableTreeData` / `useTableRowExpansion` if they keep six real cells per row. Otherwise custom `<table>`. | Expand buttons named by name and ID. Every row keeps six cells (no `colspan`, D4). Columns Session (width 100%, absorbs spare room), Provider, Model, Started, Tokens, Linked PRs. **D7 policy:** Provider, Model, Started cells `whitespace-nowrap` (identifiers such as `claude-sonnet-5-5` never break); Tokens right-aligned tabular. The table sits in a local scroller (`overflow-x: auto`) with the edge cue, as `role="region"` + `aria-label` + `tabIndex={0}` so keyboard users can scroll it. | Lazy group expansion via `/api/usage/groups/{key}/roots`. Transient expanded-set owned by the Usage feature and shared with the list below. |
| Usage tree — **< 640px** (D5, D6, D7) | `UsageTreeList`: nested `<ul>` of rows, rendered **instead of** the table by a single `useMediaQuery('(max-width: 639px)')` read (no SSR, so no flash) | Group row: one line (name · "N roots · N sessions" · stacked token totals), whole row filled (D7). Session row = a card: `SessionIdentity` across the full width (name, relationship line, "Session ID:", then provider · model · Started **once**), then a `<dl>` with **Tokens** and **Linked PRs** on one labelled line. Disclosure button named by name and ID. Unknown-relationship and "show more" rows keep one line. | Replaces the prototype's CSS-grid override of `<table>`, which the design itself flags as dropping table semantics in some assistive technology (D5, unverified). The list has no hidden duplicate cells, so the D6 repetition cannot occur. |
| **Repository token totals** (D7) | `TokenStack` inside the group row's Tokens cell | One provider per line (buddy, then value), always a column, right-aligned, tabular numerals. Same on every row; provider order Codex then Claude Code; a zero-token provider shows `0`, an uncovered one shows "—". Never summed. | The right edge matches the session rows' Tokens column |
| **Linked PRs cell** (D5) | `SessionLinks` using `LinkBadge` | From `Session.linkStatus` and `linkedPrs`: `linked` → each `#number` (a link to the PR) + the Delivery badge (Evidence link, Owner-confirmed, Suggested), ordered evidence, owner, suggested; `unlinked` → Unlinked badge; `repo_not_tracked`, `repo_unknown`, `prs_not_collected` → plain words, never "Unlinked". Meaning is in text, not colour. | A session with many links wraps its items; first thing to look at in the rendered check (Design D5 collateral note). |
| **Session identity** (D4, D7) | Custom `SessionIdentity` | Lead = recorded name or relationship label. Sub = relationship · Paseo · workspace or "No name recorded". ID line prefixed "Session ID:" (visually hidden). Meta line "provider · model · **Started** <time>" from `Session.startedAt` (basis `first_event` adds an accessible description). | Data contract `Session.nameLead / named / nameSource / startedAt / startedBasis` |
| Delivery PR table with expandable evidence | Astryx `Table` + `useTableRowExpansion`. Phone < 640: card list (see decisions). | Row toggle named "Show link evidence for {title}". Evidence items with actions; primary right. **D7 policy:** the Pull request column takes spare width; Merged (and every other data) cell is `whitespace-nowrap`; same local scroller region as the Usage table. Evidence item time is "Started <time>". | — |
| Account-reported usage | `AccountCards` section and `AccountCard` provider rows | Render the identified general Codex weekly quota and Claude’s plan windows with status, freshness and reset time. A connected ChatGPT account without a verified weekly window shows "Weekly usage unavailable." | The provider filter selects visible rows. Dates and repos leave plan readings intact. |
| Setup progress (3 steps) | Custom `SetupProgress`, a product-owned ordered list styled with the canonical tokens | `activeStep: 0 \| 1 \| 2`; labels Local sources, Accounts, Repositories; exactly one `aria-current="step"`; earlier steps announced as done | **T6 supersedes the Astryx Stepper mapping.** D7's wrapping pills at every width; no connected track or phone-only vertical orientation. See [Setup indicator reconciliation](#setup-indicator-reconciliation). Setup has no nav/filters. |
| Empty, quiet and skeleton states | Astryx `Empty State` / `Skeleton` with `CrewArt` | Text names the state and the next step. Skeletons "breathe" (opacity). HQ's quiet state is the exception: it draws the AFK room above its sentence (see "HQ quiet room"). | — |
| Visually hidden text, focus trap, announcements | Astryx `VisuallyHidden`, `useFocusTrap`, `useAnnounce` | — | Replaces prototype `.sr-only` / `trapTab` / `announce()` |

## Setup indicator reconciliation

**Decision proposed for owner review (SETUP_STEPPER_MAPPING).** Follow the accepted composition's pill indicator. The old component-map choice of Astryx `Stepper` did not specify how to reproduce that appearance. The actual product (`src/client/features/setup/route.tsx`, Astryx 0.7.9 in `package.json`) draws connected progress tracks and explicitly selects a vertical orientation below 720px. That is a visible mismatch, not a source-discovery or authentication problem. Use a small product-owned `SetupProgress` in the existing Setup feature; the rest of the Astryx foundation is retained. No library upgrade, new dependency, API field or saved setup state is needed. This turn changes documentation only; a later authorized Implementation repair would replace that indicator and verify it.

**Literal design source, not production wiring:** `docs/design/prototype/app.js` › `pageSetup()` emits `<ol class="stepper" aria-label="Setup progress">`, with three `<li class="step">` items. Its current item has `aria-current="step"`; each earlier item has `is-done`, an SVG check and visually hidden ` (done)` text. The marker is decorative (`aria-hidden="true"`). `app.css` › setup supplies:

```css
.stepper { display: flex; gap: var(--space-sm); flex-wrap: wrap; }
/* .step: 6px / --space-md padding, --radius-pill, --type-label,
   --color-surface-sunken and --color-text-muted. */
/* .step-n: 22px circle, --color-surface, --color-control-border. */
/* Current: --color-selection-surface pill; --color-action marker,
   --color-on-action number; --color-text label, weight 600. */
/* Done: --color-success-surface marker, --color-success check/border. */
```

**Proposed component/controller contract:** `SetupProgress({activeStep}: {activeStep: 0 | 1 | 2})` renders that ordered list from the same transient `step` that selects the body and the app-bar caption `Step N of 3` (`N = activeStep + 1`). It owns no query, mutation, timer or persistence. Items are informational, not buttons or tabs, and create no keyboard stops. State is positional: index below `activeStep` means a step was passed, including Skip, **not** that a source was found, an account connected or a repo added. Back recomputes the markers from the new index; reloading starts on Local sources. Errors and pending requests do not advance the indicator. Finish stays on Repositories while pending or failed and leaves Setup only after successful completion. See the matching [API boundary](local-api.md#setup-progress-and-api-boundary).

**Historical screen comparison.** T6 compared all three Setup steps at 1280, 390 and 320 pixels.
The prototype used wrapping pills while the product then used a horizontal track on desktop and
a vertical track on phones. The [M10 Setup report](../implementation/evidence/m10/README.md)
links to the retained synthetic screenshots.

**Concrete criteria for the later candidate check:**

1. Capture all nine step and viewport combinations with the same browser/font/viewport conditions on each comparison side, and record the candidate and capture conditions. The app bar, body heading and indicator agree on the current step. At 1280px the three content-sized pills share one row; at 390 and 320px the reference arrangement is Local sources + Accounts, then Repositories. Use flex wrapping at pill boundaries rather than a hard-coded phone column. Full labels and markers remain visible, with no ellipsis, clipped pill, horizontal page overflow or connecting rail. Use the existing 8px gap and token/state roles from the literal source; the 22px markers are informational, not touch controls.
2. At steps 1/2/3 exactly 0/1/2 preceding markers show the success check, and exactly one item exposes `aria-current="step"` in the ordered list named Setup progress. Read the complete label and done/current state with assistive technology. Verify Back and Skip update body, caption and indicator together; a skipped step's check does not claim successful connection. No progress item receives focus; retain the existing focus move to the new body heading after explicit step navigation.
3. **Local sources:** preserve the heading, automatic/read-only explanation, three status rows, Retry/Check again and ability to continue without sources. Product locations are discovered paths; D7's synthetic "Sessions from" dates must not cause a transcript import before Finish. The product's Paseo "Needs a password" is the settled state, not D7's generic Access denied. Retry failure leaves this step current.
4. **Accounts:** preserve GitHub and ChatGPT, existing-sign-in reuse, optional connection, the GitHub App fallback and the Codex sign-in disclosure. D7 shows GitHub disconnected and ChatGPT already signed in; the product captures show the opposite. Compare layout without treating those fixture differences as failures. The product's Claude explanation belongs here; D7's Connect Claude button must **not** be restored. Claude capture stays opt-in on Sources & repos after a preview.
5. **Repositories:** preserve the input, validation with retained entry, empty list, Back and Finish with zero repos allowed. D7's "private" simulation sentence is removed in production. Keep the existing skippable flow and phone action order/touch targets: Back and Skip before the full-width primary action. The indicator repair does not require shrinking production controls to D7's 34px buttons or undoing the product's wider phone content. No unrelated spacing/restyling change is authorized by this reconciliation.
6. Inspect the repaired indicator at all three widths with the existing containment helper, keyboard checks and relevant axe checks. Earlier M10 reported zero containment FAILs but 1/2 CHECKs for visually hidden completed text on steps 2/3; those are historical observations, not a pass for new markup. Inspect any new CHECK and keep the done announcement visually hidden. Screenshots alone establish neither semantics nor working Finish/import/auth flows; rerun the affected Setup behavior checks in the later implementation task.

**Result and limits:** all nine historical pairs were visually compared; the mismatch is present in each. No repaired UI exists from this turn, and no rendered, keyboard, assistive-technology or runtime check was rerun. Outer spacing, different fixture states, and settled source/account behavior are contextual differences, not additional repair requests. Owner acceptance of this revised mapping is still required before dependent execution.

## Designed state → behaviour

| Named state (DESIGN.md › Important states) | Driven by | API field(s) | Component |
| --- | --- | --- | --- |
| Discovery in progress / found / denied / not found | `POST /api/setup/discover`, then `GET /api/sources` | `SourceStatus.status` (`checking` → result) | Setup step 1 rows, buddy pop once (mount transition) |
| Existing sign-in / needs connection / reconnect / connected without local history | `GET /api/sources` accounts plus local source statuses | `AccountStatus.status`, sources `notfound` | Setup step 2, Sources accounts, account card |
| No tracked repos | `GET /api/repos` empty | `kpis.mergedPrs.delivery = none` | Empty state with crew art. Year grid hidden. |
| True zero | `/api/overview.trueZero` | — | "A quiet one" panel |
| Unavailable earlier history | `Bucket.usage.* = unavailable`, `ProviderKpi.note` | `unavailableText` | Hatch, KPI "From … only" |
| Partial collection (Paseo unreadable) | `SourceStatus.unreadable > 0`, `paseoNote` | — | Strip marker + Usage notice |
| Failed refresh | Recorded failed attempt and current source availability | `lastAttemptAt`, `lastSuccessAt`, `hasRetainedData`, `staleAfter` | Banner explains the attempt and offers Retry. Mention retained data only when verified. |
| **Retry in progress / succeeds / fails again** | Retry → `POST /api/refresh {sources:[id]}` → poll `GET /api/refresh/{id}` every 1 s | `RefreshRun.sources[id].state` and `SourceStatus.consecutiveFailures` | The action says “Retrying…” while the run is active. A successful retry clears the banner. A failed retry updates the attempt line and reports the failure. Previously collected records stay available where the source has them. |
| Inaccessible repo | `Repo.accessState = inaccessible` | `inaccessibleRepos` | Repo table row, Delivery notice, Sources row |
| Unknown repo / parentage | `Session.repoGroup = unknown`, `kind = unknown` | — | Tree groups, dashed buddy |
| Link classes, multi-provider PR | `PullRequest.linkClass`, `providers[]` | — | Badges, provider tags |
| Account-only usage | All local sources `notfound`, ChatGPT connected | — | Usage empty state + account card |
| **GitHub via your App** | `AccountStatus.status = needsapp`, then the connect response's `userCode` | `via`, `appClientIdSaved` | In Setup, **Connect GitHub** reveals the client-ID field and a collapsed registration guide. Sources uses the same guide. Connecting with a saved ID opens the existing device-code flow with its verification URL and polling status. |
| **ChatGPT connect disclosure** (owner choice P4) | `POST /api/accounts/chatgpt/connect` | `authUrl` | Caption beside the Connect button: "This signs Codex in on this computer too." |
| **Claude plan limits** | `AccountStatus.planLimits` and `POST …/plan-limits/check` | Percent and reset time | Sources explains that a successful first check enables rechecks from **Refresh** and **Refresh all**, and shows the last reading. The Overview sidebar reads saved windows. A recorded hook has a removal action on Sources. |
| ChatGPT quota read fails | Saved weekly `AccountReport.stale` | `refreshedAt` | Show the last reading and its time with the stale message. |
| Upcoming days in period | `Bucket.delivery/usage = future` | — | Nothing drawn. "Upcoming, no data yet". Greyed axis label. |
| Chart loading / error | TanStack Query `isPending` / `isError` for `/api/series` | — | Skeleton; error panel with Try again; Table view still works from cached data |

## Responsive and accessibility decisions

These settle the items Design handed to Tech Spec (DESIGN.md › Open decisions › For Tech Spec). Each is a technical decision within accepted design intent. Any change to appearance goes back to Design.

| Item from Design | Decision | Why |
| --- | --- | --- |
| Tab bar is first in DOM but drawn at the bottom | Render **two nav instances**: `SideNav` (≥ 720px) placed before `<main>`, and `PhoneTabBar` (< 720px) placed **after** `<main>` in the DOM. Each uses `display: none` outside its range, so only one is in the accessibility tree and tab order. | DOM order matches visual order at every width (WCAG 2.4.3). No script needed. |
| Touch targets under 44px | Phone (< 720px): tab bar, app-bar actions, filter-summary button, row toggles and evidence actions get **44×44px** hit areas (padding or pseudo-element; visual size unchanged where the design shows 24–28px). Desktop keeps design sizes, all ≥ 24px (WCAG 2.5.8 AA). | Meets AA everywhere and the Impeccable adapt guidance on phones without redesigning desktop density |
| 14px inputs zoom on iOS | Text, search, date and select inputs use 16px at < 720px (`text-[16px]` variant of `--type-body`). | Prevents zoom on focus. Same type role, one size step. |
| `viewport-fit=cover` / safe areas | Add `viewport-fit=cover`. Tab bar pads bottom, left and right with `env(safe-area-inset-*)`; page bottom padding includes it. | Makes D4's inset rule effective |
| Stacked phone tables drop semantics | Below 640px, Delivery, repository **and (T5, from D5) the Usage tree** render a **separate list component** (`<ul>` of cards with `<dl>` label/value pairs) instead of CSS-overriding `<table>` display. **Supersedes T1, which kept the Usage tree a real table.** | Keeps reliable semantics in each mode. D5 turned the tree rows into cards, and the design records that its CSS-grid override may drop table semantics (unverified). |
| Local scrollers for wide tables (D7: a table too narrow for its columns scrolls inside its wrapper instead of breaking values) | The scroller is `role="region"` with an `aria-label` ("Usage by repository, scrolls sideways") and `tabIndex={0}`, plus a visible focus ring | A scrollable area that keyboard users cannot focus fails WCAG 2.1.1; axe's `scrollable-region-focusable` rule checks it |
| Session time label | One label, "Started", fed by `Session.startedAt` everywhere (row, card, record lists, Delivery evidence, add-link options) | D7 owner-facing wording. Real-record confirmation is E1/E2; if a provider has no start record the basis falls back to first usage and the wording question returns to Design only if the gap is large ([data-and-sources](data-and-sources.md#session-start-time)). |
| Container-query support | Rely on CSS container queries (Tailwind v4 built-in). Target browsers: current Safari, Chrome and Firefox on the owner's Mac (local tool). The stacked "safe" layout remains the default style. | Supported in all current engines. The fallback is already designed. |
| Local scroll cue (`background-attachment: local`) | Keep the CSS technique. Verification checks it in Safari and Chrome at 390px. | No script; degrades to no shadow |
| Remember last-used period? | **No.** Filters live in the URL. Opening `/` (no params) shows This week. A bookmarked or back-navigated URL restores its filters. | Fixed default is the owner's choice. URL state gives deep links and back/forward for free. |
| Year grid cells not keyboard-focusable | Keep as designed (accepted limitation). The text summary and Custom range path remain. | Owner-approved D3/D4 |
| Duplicated sticky header in a capture | No code change. Production has one sticky app bar plus a filter bar, and no sticky nav row on phones. Verification's rendered pass checks it. | Unreproduced, per DESIGN.md |

## Motion mapping

| Moment | Implementation | Reduced motion |
| --- | --- | --- |
| Button / icon press `scale(0.97)` 160ms `--ease-out` | Tailwind `active:scale-[.97] transition-transform duration-press ease-crew-out`, or the Astryx press feedback if equivalent (E7) | `motion-reduce:active:scale-100` |
| Popover 200ms, scale .95→1 from top-left | Astryx `Popover` with token overrides, else a wrapper using `@starting-style` | opacity only |
| Drawer / bottom sheet 320ms `--ease-drawer` | Astryx `Drawer` / `Bottom Sheet` overrides (E7) | opacity only |
| Toast 400ms translateY | Astryx `Toast` overrides | opacity only |
| Buddy pop on first-run discovery 300ms | CSS on mount (`@starting-style`) in `SetupSourceRow`. React mounts it once, so the prototype's `takeEnter` hack isn't needed. | opacity only |
| HQ scene: the line boil (ink groups step between three wobble filters, ~4 fps), scribbles, cursor, steam and pennant flicker, thinking dots, z marks, the question bubble's bob, a reader's sheet tilt, the error mark's shake, and the quiet room's turning chair back | Stepped keyframes (`hq-boil`, `hq-flick3`, `hq-flick2`, `hq-dot`, `hq-zed`, `hq-bob`, `hq-tilt`, `hq-shake`, `hq-swivel`) in `src/client/theme/globals.css`, applied by the class strings in `features/hq/motion.ts`, each as `motion-safe:animate-[…]`, written as complete literal class strings (Tailwind's scanner cannot see interpolated ones). Opacity, transform and `filter` only; the boil is on two groups per room, never per part. | **No animation at all**: nothing is applied without `motion-safe`, so the scene is a still drawing with the first wobble filter and every mark at rest. (The global reduced-motion rule alone would leave infinite loops running.) |
| Chart bars, filters, tab switches, keyboard chart movement | **No animation** | — |

## Prototype reuse audit

| Prototype code | Disposition | Detail |
| --- | --- | --- |
| `tokens.css` values | **Replaced by generation** from YAML (identical names) | The generator must reproduce the file's values. A test diffs generated `:root` against the D4 `tokens.css`, excluding comments, to prove parity at T1. |
| `app.css` rules | **Reference only.** Re-expressed as Tailwind utilities and component styles. | Containment rules (`min-width: 0`, nowrap policy, container queries, 240px chart minimum) carry over as review checklist items |
| `ui.js › alignedChart`, `niceMax`, `yearGrid` geometry | **Port to TypeScript React components**, keeping layout constants and coverage semantics | Replace string-built SVG with JSX, and `esc` with React escaping. Keep a pure `layoutAlignedChart(buckets, width) → shapes` function for unit tests. |
| `ui.js › buddyInner`, `crewArt`, `ICONS`, brand mark | **Port** SVG paths into components | Authored for this project (DESIGN.md › Content provenance) |
| `ui.js` date helpers (`weekStart`, `addDays` on UTC dates) | **Replace** | Production buckets by report timezone with DST-safe logic (TECH › Critical logic). The prototype's UTC-date trick is fixture-only. |
| `ui.js › compact`, `int`, `plural` | **Port** (`Intl.NumberFormat` for `int`; `plural` becomes an `Intl.PluralRules`-based helper taking singular and optional plural forms) | Same output format ("38.1M"). D7's "1 root · 1 session" and "2 roots · 8 sessions" are unit-tested, including "child"/"children". |
| `app.js › linkMap` and the Usage-tree Linked PRs cell (D5) | **Rule reused, implementation replaced** | The class order (evidence, owner, suggested), the Unlinked-only-when-checked rule and the two not-checked texts move to the server (`Session.linkStatus`, `linkedPrs`) so the client never infers a check from missing data. |
| `app.js` Retry handler and the Prototype states "Retry result" choice (D7) | **Replaced** | Production derives the three outcomes from the real run result. The radio is review tooling and is not shipped. The one-second `later()` window and the fixed "9:52 AM" attempt time go away. |
| Phone Usage-tree CSS grid on `<table>` (D5) and the `.tree td.hide-sm` fix (D6) | **Reference only** | Reproduced as the `UsageTreeList` component, not as CSS overrides. |
| `app.js` copy strings (greeting, notices, empty states, banner, toasts, field errors) | **Reuse verbatim** in a `copy.ts` module, except fixture-specific phrases | "Prototype: names containing 'private' simulate no access" and "(simulated)" are removed |
| `app.js › sessName / sessSub / sessRef` | **Rule reused**, implementation replaced | Lead = recorded name (provider title or Paseo title), else relationship. The fixture rule "only Paseo has a name" is dropped. |
| `app.js › parseRepo` regex | **Reuse** (server-side) and extend for URL suffixes | — |
| `app.js` full re-render, string HTML, `takeEnter`, `data-fk` focus restore, `later()` timers, fixed clock "9:52 AM", `GREETING` constant | **Replace** with React state, Router focus management (focus `h1` on route change), real timers and server time | — |
| `data.js` fixture world and 9 scenarios | **Not shipped.** Re-implemented as a **test seed** (`test/fixtures/seed.ts`) that writes the same deterministic world into a temp SQLite DB for Playwright | Keeps D3 showcase PRs (Nov 2–4) and every required state, so E2E tests cover the design's states |
| `containment-check.js` | **Not product UI.** Adapted into a Playwright helper `test/e2e/helpers/containment.ts` run at 1280/390/320 | Implements DESIGN.md's Capture checklist as an automated check (Verification obligation) |
| Prototype states panel | **Not shipped** | Review tool only |
