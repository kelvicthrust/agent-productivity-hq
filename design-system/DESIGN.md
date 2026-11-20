---
version: alpha
name: "Agent Productivity HQ — visual identity"
description: "Warm, gently playful, minimal identity for a private dashboard that joins merged PRs with recorded Codex and Claude Code usage on the installation host. A cozy logbook for your agents: friendly in tone, literal in every number."
colors:
  canvas: "#FBF8F3"
  surface: "#FFFFFF"
  surface-sunken: "#F3EEE6"
  border: "#E8E1D6"
  border-strong: "#D3C9BB"
  control-border: "#8F8579"
  text: "#1F1B16"
  text-muted: "#5F574D"
  action: "#5A3FD6"
  action-hover: "#4A2FC2"
  on-action: "#FFFFFF"
  focus: "#5A3FD6"
  selection-surface: "#EFEBFF"
  series-delivery: "#D6336C"
  series-codex: "#0F7B7B"
  series-claude: "#C2551F"
  series-neutral: "#9A9086"
  coverage-hatch: "#C9BEAF"
  delivery-surface: "#FCEEF3"
  heat-1: "#F9D3E0"
  heat-2: "#F0A0BE"
  heat-3: "#E2668F"
  heat-4: "#D6336C"
  sunshine: "#F5B83D"
  success: "#1E7A46"
  success-surface: "#E6F4EA"
  warning: "#8A5A00"
  warning-surface: "#FFF4D6"
  danger: "#B42318"
  danger-surface: "#FDECEA"
  danger-hover: "#8F1C13"
  row-hover: "#FDFBF8"
  toast-link: "#C9BDFF"
  hatch-light: "#E9A27E"
typography:
  metric:
    fontFamily: "'Nunito', ui-rounded, 'SF Pro Rounded', ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: 30px
    fontWeight: 700
    lineHeight: 36px
    letterSpacing: -0.015em
  title-page:
    fontFamily: "'Nunito', ui-rounded, 'SF Pro Rounded', ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: 24px
    fontWeight: 700
    lineHeight: 30px
  title-section:
    fontFamily: "'Nunito', ui-rounded, 'SF Pro Rounded', ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: 16px
    fontWeight: 650
    lineHeight: 22px
  body:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 20px
  label:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: 13px
    fontWeight: 500
    lineHeight: 18px
  data:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 18px
    fontFeature: "'tnum' 1"
  caption:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16px
  mono:
    fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16px
rounded:
  sm: 8px
  md: 14px
  lg: 20px
  pill: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
  3xl: 48px
components:
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.on-action}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    height: 34px
    padding: 0 14px
  button-primary-hover:
    backgroundColor: "{colors.action-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    borderColor: "{colors.control-border}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    height: 34px
    padding: 0 14px
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.on-action}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    height: 34px
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    borderColor: "{colors.control-border}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    height: 34px
    padding: 0 12px
  segmented-track:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.pill}"
  segmented-selected:
    backgroundColor: "{colors.selection-surface}"
    textColor: "{colors.action}"
    borderColor: "{colors.action}"
    rounded: "{rounded.pill}"
  nav-item-active:
    backgroundColor: "{colors.selection-surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.pill}"
  card:
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.border}"
    rounded: "{rounded.md}"
    padding: 16px
  kpi-primary:
    backgroundColor: "{colors.delivery-surface}"
    borderColor: "{colors.heat-1}"
    rounded: "{rounded.md}"
  badge-evidence:
    backgroundColor: "{colors.selection-surface}"
    textColor: "{colors.action}"
    rounded: "{rounded.pill}"
    typography: "{typography.caption}"
  badge-owner-confirmed:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    borderColor: "{colors.text}"
    rounded: "{rounded.pill}"
    typography: "{typography.caption}"
  badge-suggested:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-muted}"
    borderColor: "{colors.control-border}"
    rounded: "{rounded.pill}"
    typography: "{typography.caption}"
  badge-unlinked:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.pill}"
    typography: "{typography.caption}"
  banner-warning:
    backgroundColor: "{colors.warning-surface}"
    textColor: "{colors.text}"
    borderColor: "{colors.warning}"
    rounded: "{rounded.md}"
  drawer:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
  toast:
    backgroundColor: "{colors.text}"
    textColor: "{colors.surface}"
    rounded: "{rounded.pill}"
---

# Visual identity

Status: **draft for owner review**, revision **D9** (the owner's choice of the "Cozy Logbook, Refined" redesign with sparklines, 2026-11-18, see "What changed in D9"; **no colour hex changed**: the display font is now self-hosted Nunito, the selected segment and the Evidence link badge move onto the existing grape tint, and the filter bar, account card, crew cluster and sparklines are re-specified). D8 was (a scoped clarification for finding `PASEO_STATUS_COPY`: Paseo's password-required and not-running states get one word and one helper sentence each, see "What changed in D8"; **no colour, type or shape value changed**, and no rendering or script has been run). D7 was repair 3/3 (desktop data cells never wrap, token values share one right edge, session times read "Started", and the phone repository row fill spans its width; **no colour, type or shape value changed**, see "What changed in D7"). D6 was repair pass 2 of 2 ( it changes no identity value and only corrects a phone rule so Usage-tree provider, model and time show once, see "What changed in D6"). D5 was repair pass 1 after an independent GPT critique of D4; it changed only the Usage tree's phone row layout and its link-evidence labels, and **no colour, type or shape value** (see "What changed in D5" below). The text that follows describes D4, which D5 builds on: D4 was a responsive/usability repair on D3; D3 built on D2 of 2026-11-05. The owner approved the D2 direction and identity values in historical review (topic "Approve the D2 playful-minimal direction") and approved the D3 screens, states and copy in historical review (topic "Accept the D3 screens, states and copy for technical handoff"). Each approval is scoped to its own topic and revision. D4 changes **no colour, type or shape values**; it changes layout, navigation and wording, and adds three layout/depth tokens (below). The owner then approved D4's changes to the accepted screens (historical review, topic "Review D4's changes to the screens you accepted in D3") and chose to defer the rendered 390px/320px/desktop checks to Verification after implementation. The D4 changes have still **not been verified in a rendered browser**: the identity is approved as design intent, with rendered confirmation carried to Verification. No colour, type or shape value changed in this revision.

Scope: the Agent Productivity HQ MVP described in `PRODUCT.md` P4.

Sources:
- Canonical values: the YAML front matter above.
- Preview mirror: `docs/design/prototype/tokens.css`. It must change together with this file.
- Viewable guide: `docs/design/prototype/style-guide.html`.
- Broader brief: the root `DESIGN.md`.
- Research record: `docs/archive/design/research.md`.

**Product name.** Use "Agent Productivity HQ" in the wordmark and page titles. The navigation sections include "Usage" and "Delivery". The owner selected Logbook for the header and favicon, a violet notebook with two eyes and a peach ribbon.

**What changed in D9 (owner decision 2026-11-18, chosen through an Impeccable redesign round: "Cozy Logbook, Refined" plus sparklines; no colour hex changed):**
- **Display font is self-hosted.** Nunito (variable weight, latin subset, SIL OFL) ships as one woff2 and leads the display stack, with `ui-rounded` and the system sans behind it. Display roles only (metric, title-page, title-section); UI and data text stay on the system sans. This supersedes the historical review "no font files" decision (Typography).
- **Selected state is grape.** A selected segment is a grape tint (`selection-surface`) with grape text and a 1px `action` ring. The Evidence link badge is the same tint with grape text and a dot, replacing solid ink. Owner-confirmed, Suggested and Unlinked badges are unchanged.
- **Sparklines** on Merged PRs and on each provider's local tokens KPI (Components › Sparkline).
- **Filter bar** comes after the title as one row on a wide screen, with a "Filters · n" popover for the route's other groups; each route shows only the filters it uses and Sources shows none (Components › Filter bar).
- **KPI crew cluster** is three 16px buddies plus "+N", replacing the nine-buddy row.
- **Account card** carries one status line and one action per account (a connected account's action is where it is managed in Sources); caveats, Claude's shorter windows and the scope label sit behind "Why?", which opens by itself whenever a warning applies. The "Not filtered by repo" chip is said once, in the section header.
- **History unavailable** is drawn as a dot stipple so the diagonal hatch means only Claude Code; upcoming chart days are labelled in `text-muted` with one "Upcoming" caption.
- **Sources & repos** sits in the nav list with the other destinations.

**What changed in D8 (owner request for `PASEO_STATUS_COPY`; no token value changed):**
- **Two Paseo status words, one helper sentence each.** "Needs a password" (server status `needspassword`) and "Not running" (`notrunning`). Paseo is a daemon the dashboard connects to, not a folder it reads, so it never uses "Access denied" or "Not found"; those two stay Codex and Claude Code words. The words, sentences, actions and the surfaces they appear on are in Components › Source status words, and the full table with screen criteria is in the root `DESIGN.md` › Paseo status words.
- **Existing marks and tints only:** "Needs a password" uses the lock mark on the danger tint (as "Access denied" does); "Not running" uses the muted no-entry mark (as "Not found" does). No new colour, type, shape or icon value.
- **Mapping aligned:** the older sentence "Design's 'Access denied' copy maps to `needspassword`" (Tech's `data-and-sources.md`) is superseded by this revision; the settled word is "Needs a password". Tech Spec owns the edit to its own documents.

**What changed in D7 (repair 3/3; no token value changed):**
- **Table data cells:** on desktop, Provider, Model, Started and Merged are `nowrap` and the first column (Session, Pull request) takes the spare width. A literal identifier is never split at its hyphens.
- **Token column:** repository and session token values share one right edge in tabular numerals; a repository's provider totals always stack, one per line.
- **Session time:** one label, "Started", wherever a session time appears (assumes the real record exposes a start time; Tech Spec to confirm).
- **Phone repository row:** the sunken fill is on the whole row.
- **Retry feedback:** Retry shows its in-progress state, then success or "failed again today, <time>"; the failure keeps the banner and the cached data.

**What changed in D6 (repair pass 2 of 2; no token value changed):** on a phone the Usage tree's hidden Provider, Model and Active cells (`.hide-sm`) stay hidden, so provider, model and time appear once, in the session's identity block. Rule: a layout rule that sets `display` on table cells must not override `.hide-sm`.

**What changed in D5 (repair pass 1 of 2, answering an independent GPT critique of D4; no token value changed):**
- **Usage tree link evidence:** each linked PR in a session row shows `#number` plus the same badge Delivery uses (Evidence link, Owner-confirmed, Suggested). A session with no link in a tracked repo shows the Unlinked badge instead of a dash. Where PRs were never collected (repo not tracked, or no repo recorded) the cell says so in words. Existing tokens only (`lbadge` classes).
- **Usage tree on a phone (≤ 639px):** a session row is a two-line card, with identity across the full width and Tokens and Linked PRs on one aligned line below it. The three-column table layout is dropped there. Group, "show more" and unknown-relationship rows keep one line.

**What changed in D4 (answer to an independent critique of D2 at 390px; usability and responsive craft only):**
- **Phone navigation** is a fixed bottom tab bar (Layout, Components), replacing a horizontally scrolling row that clipped.
- **Containment:** half-width cards stack at 1023px and below; the tokens KPI spans the full row on a phone and stacks its two providers when its card is narrower than 200px; segmented controls wrap; the chart minimum width is 240px; the app bar compacts on a phone.
- **Provider ledgers** keep numbers on one line and show included subsets with an elbow connector and an "included in…" note.
- **Coverage strip** is compact source groups by default and a one-line capsule only at 900px of container width and above; failure explanations are consolidated into the banner.
- **Session identity:** rows lead with the recorded agent name, or the recorded relationship when no name was recorded, with the technical ID secondary.
- **Local scrolling** (year grid, wide tables) shows an edge shadow, and the year grid says so on a phone.
- **Accessibility fix:** icon-only app-bar controls on a phone keep their names (visually hidden, not `display: none`).
- **New tokens (CSS mirror and this prose only, not the YAML):** `--bottomnav-h: 64px`, `--shadow-nav: 0 -4px 14px rgba(31,27,22,.06)`, `--scroll-edge: rgba(31,27,22,.16)`.

**What changed in D3 (owner decisions from historical review, no visual redesign):**
- The product name above.
- The dashboard opens on **This week** (see root `DESIGN.md`). This is behaviour, not a token.
- The rounded display font stayed the **system `ui-rounded` stack with no font files** (superseded in D9: Nunito is now self-hosted, see Typography).
- The MVP is **light theme only**; dark mode is deferred and undesigned.
- Per-provider token totals count **every recorded category once** (Components › Token totals).

**What changed from D1 (in D2):** the owner approved D1's Overview (direction and honesty rules), then asked for a design that is "a bit more playful… while staying relatively minimal", and less "Enterprise-like… SaaS". D2 keeps every D1 structure, state and honesty rule. It changes the palette (cool grey → warm cream, blue action → grape, plum delivery → berry), shape (rounder), depth (soft tactile shadows), the display type voice (rounded stack), and adds agent buddies, crew illustrations and authored motion. All D1 untokenized preview literals are now named tokens.

## Overview

Kelvin is the only user. Each day or week he looks back over his own coding-agent work: **what merged, where his agents spent their tokens, and which sessions link to that work**. The skeleton stays a familiar dashboard: visible filters, summary metrics, aligned time-series charts and tables you can drill into. That's what Product asked for, and what Impeccable's guidance calls "earned familiarity" for a task-focused tool.

Character: **a cozy logbook for your agents: warm, a little cheeky, honest about gaps.** The playfulness is grounded in the owner's own reference, Pixel Agents ("make the hours you spend doing it feel less like administration and more like play"). D2 borrows its *idea*, that each agent is a little character in a warm world. The pixel art, office and game mechanics are not borrowed. PostHog's inspected product page showed that a developer analytics tool can carry strong personality through illustration, warm colour and tactile buttons while its charts stay conventional. D2 takes that lesson at a much smaller dose, keeping the minimal feel the owner asked for.

The personality lives in five places:
1. a warm cream canvas instead of cool enterprise grey;
2. rounder shapes and pill navigation;
3. soft, tactile depth;
4. a rounded display voice for headings and big numbers;
5. **agent buddies**, small authored characters standing in for sessions, and a tiny crew illustration reserved for rare moments: first launch, a quiet zero day, empty states.

This is still not a scoreboard. There's no productivity score, no streaks, levels or celebratory treatment of totals, and no green/red deltas. Coverage and attribution are always stated in words.

## Colors

- **Warm neutrals:** canvas `#FBF8F3` (cream), surface white, surface-sunken `#F3EEE6`, border `#E8E1D6`. Cards sit on the cream with a soft shadow. `surface-sunken` marks tracks, group rows, unavailable regions, Unlinked badges and zero cells in the year grid.
- **control-border `#8F8579`:** the edge of interactive controls. About 3.6:1 on white and 3.4:1 on cream, enough for non-text UI contrast. The decorative `border` is never a control's only edge.
- **Text `#1F1B16`, text-muted `#5F574D`:** warm ink. Muted text is about 7.1:1 on white, 6.7:1 on cream and 6.3:1 on the berry KPI tint. There is no lighter text tier.
- **Action, grape `#5A3FD6`:** primary buttons, links, focus ring, selected states. About 6.7:1 against white, both as text and with white text on it, and about 5.8:1 as text on its `selection-surface` tint (D9: the selected segment and the Evidence link badge). It's the only action colour, so the primary path stays obvious.
- **Data series, marks only:**
  - delivery, berry `#D6336C` (≈4.6:1 on white);
  - Codex, teal `#0F7B7B`;
  - Claude Code, terracotta `#C2551F`;
  - neutral/unknown `#9A9086`.
  Series colours never set body text. Berry and terracotta are about 4.3:1 on cream, below the text threshold.
- **Year grid ramp:** `heat-1…4` (`#F9D3E0` → `#D6336C`), with sunken as the covered zero.
- **delivery-surface `#FCEEF3`:** tints the Merged PRs KPI, replacing D1's coloured side rule, which Impeccable's craft floor refuses.
- **Sunshine `#F5B83D`:** an illustration accent only, for sparkles and the owl's tuft tip. Never text, data or state.
- **Redundant encoding:** Codex marks are squares (buddy: the boxy owl, a rounded square with a tuft; bars: solid). Claude Code marks are circles (buddy: the round fox with pointed ears; bars: diagonal hatch using `hatch-light`). Unknown relationships are a dashed outline. Every legend and readout names the series.
- **Coverage:** unavailable history is a dot stipple (`coverage-hatch` on `surface-sunken`; D9, so the diagonal hatch means only Claude Code), a covered zero is a baseline tick, and future buckets are left empty.
- **Feedback:** success, warning and danger, each with a tinted surface; text on its tint is about 4.7–6.6:1. Success marks a healthy source or connection and is never used to praise a metric.
- **Browser surfaces:** text selection uses `selection-surface`; caret and native form accents use `action`; scrollbars use `border-strong` on canvas.

Contrast ratios here were computed by hand from the hex values with the WCAG relative-luminance formula. The style guide recomputes them at runtime from the live tokens. Neither is a rendered accessibility audit.

## Typography

- **Display (Nunito, rounded):** `'Nunito'`, then `ui-rounded`, SF Pro Rounded, then the system sans. Used for page titles, section titles, KPI values and chart panel titles only. Rounded terminals carry most of the friendliness at almost no density cost.
- **UI and data (system sans):** body, labels, table cells, captions, with tabular numerals everywhere numbers line up.
- **Mono:** only for session IDs and discovered paths, which are literal identifiers. It isn't used as a "technical" costume.
- **One self-hosted font file (owner decision D9, superseding historical review's "no font files").** Nunito ships as a single variable-weight (600 to 800) latin woff2 under `src/client/theme/fonts/`, with its SIL OFL licence beside it. It is served by the dashboard itself, so the outbound boundary is unchanged (no font CDN). `font-display: swap` shows the fallback first; if the file fails to load the stack falls back to `ui-rounded` (Safari on Apple platforms), then the system sans. Characters outside the latin subset also fall back. Design nothing that depends on exact rounded glyph widths: the fallback is close but not identical.
- **A second self-hosted file, for HQ's scene only (owner request, 2026-11-19).** HQ's drawn text (heading, signs, captions) is Playpen Sans (SIL OFL), one variable-weight (100 to 800, weight axis only) latin woff2 under `src/client/theme/fonts/` with its licence beside it, declared once in `globals.css` with `font-display: swap`. It is **not** a typography token or role: no UI role uses it, so it is absent from this front matter, the generator and the token mirror. The scene names it once (`HAND_FONT`, in `features/hq/HqScene.tsx`) ahead of the old system handwriting stack, which remains the fallback if the file fails to load. The roster and the page title stay in the UI fonts. The file is served by the dashboard itself, so the outbound boundary is unchanged.

| Role | Size / line | Weight | Stack | Use |
| --- | --- | --- | --- | --- |
| metric | 30 / 36 | 700 | display | KPI values |
| title-page | 24 / 30 | 700 | display | Page H1, including the Overview greeting |
| title-section | 16 / 22 | 650 | display | Card and section titles |
| body | 14 / 20 | 400 | sans | Prose, text cells |
| label | 13 / 18 | 500 | sans | Controls, filter labels, headers |
| data | 13 / 18 | 400, tnum | sans | Numeric cells, readouts |
| caption | 12 / 16 | 400 | sans | Scope lines, footnotes, badges, axes |
| mono | 12 / 16 | 400 | mono | Session IDs, paths |

Headings use `text-wrap: balance` and prose uses `text-wrap: pretty`. Sentence case throughout, and units always follow numbers.

## Layout

- **Density:** medium, unchanged from D1. A 12-column grid with 16px gaps, a 24px page gutter, and content up to 1440px wide.
- **Shell:** a 60px app bar with Refresh on the cream canvas with no divider line, and a 220px nav of pill items. The Sources & repos nav item carries the issue badge. The filter bar (D9) sits under the page title: period and a "Filters · n" popover, then the date range and timezone, on one row where they fit.
- **Overview hierarchy:** greeting → coverage strip (compact groups, or a capsule on wide containers) → KPIs (Merged PRs first, berry tint) → aligned chart beside account-reported usage → by-repository table beside recent merges.
- **Trends:** year-of-merges grid → aligned chart → selected-period records → tokens by model.
- **Breakpoints (D4):**
  - **≥ 1280px:** side nav; KPIs in one row; provider ledgers two-up.
  - **1024–1279px:** side nav; KPIs three per row; provider ledgers still two-up.
  - **720–1023px:** a pill nav row under the app bar (all five items fit); half-width cards (provider ledgers, model breakdown, record lists) stack full width.
  - **< 720px:** a **fixed bottom tab bar** with all five destinations; filters collapse into a pill summary that opens a bottom sheet; Recorded local tokens spans the full row; segmented controls wrap.
  - **< 640px:** tables become stacked label/value cards; in the Usage tree (D5) each session is a two-line card: identity across the full width, then Tokens and Linked PRs on one line.
- **Containment rules:**
  - Grid and flex children take `min-width: 0`.
  - `white-space: nowrap` is only for short labels and numbers, and never inside a card narrower than they are.
  - Components that must fit several widths adapt to their **own** width with container queries (coverage strip at 900px, tokens ledger at 200px inner width), with the safe layout as the default if unsupported.
  - Anything that scrolls sideways does so locally with an edge shadow.
  - A pill radius is not used on anything that wraps to several lines.
- **Phone tab bar:** `--bottomnav-h` (64px: 52px items plus 6px padding top and bottom) plus the device safe-area inset. Five equal tabs, icon over a 12px label; the current tab sits on the selection tint; "Sources & repos" is shown as "Sources" and keeps its full accessible name; the issue count is a small badge on that tab. Toasts and the review panel are lifted above the bar and the page gets matching bottom padding.
- **HQ (added after D9):** a destination after Usage in the side nav, with no filter bar. The phone tab bar stays at five tabs; HQ is an icon-only app-bar link below 720px (44px target, accessible name "HQ", `aria-current="page"` when active). Its roster uses the existing surface, border, warning and buddy tokens only; HQ's illustrated scene (DESIGN.md › HQ) is an original hand-drawn "logbook sketch": ink lines, watercolour washes, handwritten captions in Playpen Sans (self-hosted; system handwriting faces as the fallback; not a typography token), and a stepped line boil, with one room per session and critter characters (a round orange fox is Claude Code, a boxy teal owl is Codex; shape carries the provider). It uses existing tokens only: the sunshine wash marks a room that needs the owner, the grape action colour draws the captain's arrows. Its loops stop under reduced motion, and, since 2026-11-19, the same critters are the buddies on the other screens, drawn small and flat.
- **Charts** redraw at their container's pixel width with a 240px minimum, so text never drops below 11px (a 320px window leaves a 256px card body).
- **Action order:** primary on the right, matching the tab order. On a phone, action pairs share one row and are not reversed.

## Elevation & Depth

Soft and warm, never hard.
- Cards: `0 1px 2px rgba(31,27,22,.05), 0 4px 14px rgba(31,27,22,.05)`.
- Overlays (popovers, drawer, sheet, toast): `0 14px 36px rgba(31,27,22,.16), 0 2px 6px rgba(31,27,22,.08)`.
- Primary and danger buttons: an inset 2px darker bottom edge (`inset 0 -2px 0 rgba(31,27,22,.22)`).
- Secondary buttons: a sunken bottom edge.
- Phone tab bar (D4): `--shadow-nav`, `0 -4px 14px rgba(31,27,22,.06)`, lifting it off the page from below.
- Local scroll cue (D4): `--scroll-edge`, `rgba(31,27,22,.16)`, a soft edge shadow on whichever side of a sideways scroller still has content.

There are no zero-blur block shadows, no glass and no glow. The scrim is 36% warm ink.

## Shapes

- `sm` 8px: buttons, inputs, notices, review-tool controls.
- `md` 14px: cards, KPI tiles, evidence items, banners.
- `lg` 20px: drawer, bottom sheet, floating filter panel.
- `pill`: nav items, segmented controls (on a phone they wrap, so they take `md` there), the coverage strip **only in its one-line capsule form**, chips, badges, toast, phone filter summary.
- Chart bars have 3px rounded tops when wider than 6px. Year-grid cells are 11px with 3px radius.

## Components

- **Buttons:** primary (grape, tactile bottom edge), secondary (white, control-border, sunken bottom edge), ghost (row actions), danger (confirmations). 34px tall, with a 28px small variant. Press = `scale(0.97)` over 160ms. Disabled = 45% opacity plus `aria-disabled`, with a visible reason nearby.
- **Segmented control (D9):** a pill track (`surface-sunken`) with one selected pill: grape tint (`selection-surface`), grape text (`action`) and a 1px `action` ring, over a faint shadow. The selection is carried by the ring and the tint, not by colour alone. Astryx segments expose `role="radio"` with `aria-checked`; the Custom range trigger is a toggle button with `aria-pressed` and the same look.
- **Source status words (D8):** a status tag is an icon plus a short sentence-case word, with no full stop. The vocabulary is Looking…, Found, Partial, Refresh failed, Not found, Access denied, and Paseo's two, **Needs a password** and **Not running**. *Not found* and *Access denied* describe a local folder (no records there; present but unreadable). Paseo is a daemon, so it uses only **Needs a password** (the daemon answered and asks for a password this dashboard doesn't support; lock mark, danger tint; action **Retry**) and **Not running** (nothing answered; muted no-entry mark; action **Check again**). Retry is for something that answered and can't be used; Check again is for nothing there. The same word appears on every surface, in lower case inside the coverage strip ("needs a password", "not running"). Helper sentences follow one order: the fact, then what the owner can do (if anything), then, in Setup only, "You can continue without it." A snapshot is mentioned only when one exists. The exact sentences are in the root `DESIGN.md`.
- **Filter bar (D9):** the page title comes first, then the filters: the period segment plus **Custom** and a **"Filters · n"** button (n counts active non-default filters; read aloud as "Filters, n active") that opens a popover holding the route's other filter groups (group by, repository, provider, author), then the date range and a timezone caption. On a wide screen this is one row; where the row is too narrow (a long date range at 720–1279px) the controls (period and Filters) keep their row and the date range and timezone caption wrap together onto the next line, never one control alone. A route shows only the filters it uses; **Sources shows none**. Below 720px the row collapses into the existing pill summary and bottom sheet.
- **Filter scope line:** every card names the filters that apply to it, or says "Account-wide · not filtered by repo".
- **KPI card:** label, then scope caption, value (display stack), and a neutral meta line. Merged PRs sits on `delivery-surface`. Root sessions and Child agents show a **crew cluster (D9)**: three 16px buddies coloured and shaped by provider, then "+N" for the rest. The number is the count, written literally; the buddies are decoration and it isn't a score.
- **Sparkline (D9):** a small trend line under a KPI value, on **Merged PRs** and on **each provider's local tokens KPI** only. It shows 12 Monday-start weeks. Each line has its **own scale** (a line is never read against another), is drawn in the series colour (berry for delivery, teal for Codex, terracotta for Claude Code), and ends with a filled dot in that colour for the current week. A week with no data (`null`, such as before history begins) **breaks the line** rather than reading as zero. A single recorded week (a provider's first, say) is drawn as its dot alone; with no recorded week there is no sparkline. Providers are **never combined** into one line. The drawing is decorative (`aria-hidden`); the line is exposed as one `role="img"` whose name reads every week oldest to newest and this week's value ("Codex 12-week trend, oldest to newest: …; this week …"). It always covers the 12 weeks ending with the current week, whatever period is selected, and follows the repository, provider and author filters. It carries no axis, tooltip or delta colour.
- **Provider ledger in the tokens KPI (D4):** inside Recorded local tokens each provider is a label/value pair. With at least 200px of inner card width the two providers sit side by side (label above value); with less they stack one per row (label left, value right, a note line under both). The card spans the full row on a phone. Totals are never combined in either layout.
- **Provider token ledger on Usage (D4):** one card per provider. Labels may wrap; numbers are right-aligned, tabular and never wrap. An included subset ("Cached input", "Reasoning") sits under its parent with an elbow connector and an "included in input/output" note, and the divider between parent and subset is dropped so they read as one group.
- **Session identity (D4):** a session row (Usage tree, record lists, Delivery evidence) leads with the **recorded agent name** if the source recorded one (in the fixture, Paseo records only). With no recorded name it leads with the **recorded relationship** ("Root session", "Native subagent", "Unknown relationship") and the sub line says "No name recorded". Never invent a name. The sub line also carries the relationship, "Paseo" and the workspace where recorded. The technical ID is the third line in the mono style, secondary but visible and prefixed "Session ID:" for screen readers. On a phone a fourth line carries provider, model and time because those columns are hidden. **Linked PRs (D5):** one item per link (`#number` plus the Delivery evidence badge); a session with no link in a tracked repo shows the Unlinked badge, never a dash; where PRs were not collected the cell says "Repo not tracked, so PRs not checked" or "No repo recorded, so PRs not checked". On a phone, Tokens and Linked PRs sit together on one labelled line under the identity block. When real providers expose a title or summary it should replace the relationship fallback as the lead (Tech Spec to establish).
- **Coverage strip (D4):** state only, no prose. Compact source groups by default: a label column (This machine, Delivery, Account reports) and one line per source (status icon, name, a few words), then a footer row with the refresh time and "Manage sources". At 900px of container width and above it becomes the one-line capsule. Below 340px the group label stacks above its sources. One prose explanation of a failure, with freshness, coverage limit and recovery action, lives in the failed-refresh banner; the strip, notices and cards carry only short status markers.
- **Failed-refresh banner (D4):** icon beside the text; on a phone the actions sit on their own row, right-aligned, primary last.
- **Local scroll cue (D4):** a sideways scroller (year grid, wide tables) shows an edge shadow on each side that still has content, drawn in CSS only. The year grid also says "Scroll sideways to see the full year" on a phone and opens on its newest weeks.
- **Token totals (owner-confirmed, Review r6):** each provider's headline total counts every recorded category exactly once. Codex = input + output (cached input and reasoning are subsets and are never added again). Claude Code = uncached input + cache write + cache read + output (separate categories). Providers are shown side by side and never combined. The definition is the design's presentation rule; Tech Spec must still check it against real provider records, which the prototype's synthetic fixtures don't establish.
- **Agent buddy:** an authored 20×20 SVG, the small flat version of HQ's critters (since 2026-11-19; before that, Codex was a rounded square with an antenna and Claude Code a plain circle). Codex is a boxy teal owl: a rounded square with a yellow-tipped tuft and two ringed eyes. Claude Code is a round orange fox curled into a bun: a circle with two pointed ears, a pale muzzle and a nose dot. An unknown relationship is a neutral blob with a dashed outline. Shape carries the provider without colour (round with ears, square with a tuft, dashed). Existing tokens only; no outline filter and no animation at this size, so it stays crisp at 16 to 20px. Moods are awake (default), sleep (not found, quiet day) and dizzy (reserved for recovery illustrations). Decorative (`aria-hidden`) and always paired with text. Sizes: 18px for root sessions in the Usage tree, 13px for children and crew rows, 15px in provider tags.
- **Crew art:** a 132×64 illustration with awake, search, sleep and dizzy variants. Used only for first-run setup, empty states and the true-zero "quiet one" panel.
- **Link-basis badges (D9):** the **Evidence link** badge is a grape-tint pill (`selection-surface`, grape text) with a leading dot; ink outline + check = owner-confirmed; dashed = suggested; sunken + dash = unlinked. Each still names its basis in words.
- **Overview account card:** put **Not filtered by repo** at the right of the section title. Lead each provider row with its reported weekly utilization and reset time. Keep Claude’s five-hour reading visible below the headline. Show connection actions only for accounts that need setup or reconnection.
- **Navigation (D9):** Sources & repos is a normal item in the nav list, keeping its issue count badge.
- **Aligned chart:** unchanged semantics apart from two coverage marks (D9). Berry delivery bars with rounded tops; Codex solid and Claude hatched stacked tokens; dashed gridlines; a coverage rail; a text readout; Table view. **History unavailable** is a dot stipple on the rail (`coverage-hatch` on `surface-sunken`), so diagonal hatching means only Claude Code. Upcoming days are labelled in `text-muted` with a single "Upcoming" caption and are left empty.
- **Year of merges:** a day-cell grid for the last 12 months, Monday-start weeks. Delivery only, because local usage history doesn't span the year. The selected period is outlined; clicking a day opens it in Trends. Summary facts are total, days with a merge, and busiest day. There are deliberately no streaks.
- **Records drawer:** a right-hand panel inset 8px from the viewport, with `lg` corners. No kicker label above its heading.
- **Toast:** an ink pill with a lavender Undo link.
- **Mapping to Astryx/Tailwind** is listed in the style guide as *to verify*. The prototype uses plain HTML/CSS lookalikes, not Astryx.

### Motion (project extension; from Emil Kowalski's animate skill, snapshot c8a7962)

| Token | Value | Use |
| --- | --- | --- |
| `--ease-out` | `cubic-bezier(0.23, 1, 0.32, 1)` | Entrances, presses |
| `--ease-in-out` | `cubic-bezier(0.77, 0, 0.175, 1)` | Reserved for on-screen movement |
| `--ease-drawer` | `cubic-bezier(0.32, 0.72, 0, 1)` | Drawer, bottom sheet |
| `--dur-press` | 160ms | Button and icon press |
| `--dur-popover` | 200ms | Popovers (scale 0.95 → 1 from top-left), row chevrons |
| `--dur-drawer` | 320ms | Drawer, sheet, scrim |
| `--dur-toast` | 400ms, `ease` | Toast slide-up (recipe) |
| `--dur-pop` | 300ms | Buddy pop on first-run discovery (rare tier) |

Entrance classes are applied for one render only, so re-renders never replay motion. Things that are keyboard-driven or frequent (chart bucket movement, filters, tab switches) don't animate, and neither do chart bars. Reduced motion keeps the opacity fades and removes translate, scale and press. Spinners and skeletons switch to a gentle opacity "breathe".

## Do's and Don'ts

- **Do** spend personality on rare moments and precise details. **Don't** decorate every card or animate data.
- **Do** keep buddies beside text, with shape matching provider. **Don't** put buddies inside charts or use them as scores.
- **Do** state coverage in words beside every number that could be incomplete. **Don't** let a partially collected year look complete.
- **Do** keep Codex and Claude Code totals side by side. **Don't** show a cross-provider token total, or one sparkline that merges providers.
- **Do** give each sparkline its own scale and break it at weeks with no data. **Don't** draw a missing week as zero or compare lines across cards.
- **Do** reserve diagonal hatching for Claude Code and use the dot stipple for unavailable history. **Don't** reuse either for another meaning.
- **Do** use the display font only for titles and KPI values. **Don't** set body, table or chart text in Nunito, or add a font file for a UI role. (HQ's scene has one more, Playpen Sans, for its drawn text only.)
- **Do** show account-reported usage under its own window and unit. **Don't** add it to local usage, filter it by repo or draw it into trends.
- **Do** use friendly greetings and empty-state copy that name the state and the next step. **Don't** use "Great job", streaks, "hours saved", "more productive" or jokes about lost data.
- **Don't** add kicker labels above headings, coloured side rules, gradient text, glass, hard block shadows or emoji icons.
- **Do** lead a session with its recorded name or relationship and keep the ID secondary. **Don't** invent a name for an unnamed session, or lead with an ID when a name exists.
- **Do** let a component adapt to its own width and make the safe layout the default. **Don't** rely on a viewport breakpoint for something that can also sit in a narrow card.
- **Do** keep an icon-only control's name available (visually hidden text). **Don't** use `display: none` on a label that is the only name.
- **Do** say it in one place when something has failed. **Don't** repeat the same failure explanation in the strip, a notice, a card and a banner.
- **Don't** claim a layout is contained until it has been measured at 390px and 320px.
- **Don't** add a machine picker, folder picker, API-key field or password form to setup.
- **Do** call Paseo's two unusable states "Needs a password" and "Not running" everywhere. **Don't** call Paseo "Access denied" or "Not found", and don't say "last snapshot" when no snapshot exists.
