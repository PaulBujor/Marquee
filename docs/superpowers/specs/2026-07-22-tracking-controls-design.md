# Tracking controls on the detail page (PR2 — MRQ-41/50/51 + episode/season/series: MRQ-48/49/53/113)

**Date:** 2026-07-22 (revised 2026-07-23 after review)
**Branch:** `paul/mrq-41-event-writing-layer` (stacked on
`paul/mrq-112-provider-agnostic-media-identity`, PR #87)
**Status:** built & browser-verified (Playwright, on the real auth-gated detail page via
a seeded local session — both a movie and a series). See "Revision 2" for the final shape.

## Context

The event-writing layer MRQ-41 asks for **already exists**: `recordEvent(type,
entityId, payload)` (`src/lib/client/idb/index.ts`) stamps an event, enqueues it
in the outbox, and applies it to local materialized state optimistically — built
and tested in the #82 foundation. What's missing is **UI that calls it**: the
detail page (`/title/[type]/[id]`) is read-only, with a
`<!-- Mark-as-viewed check lands here -->` placeholder.

This PR wires the pipeline into the detail page: set/change **status** (MRQ-50)
and toggle **favorite** (MRQ-51), writing through `recordEvent` with the media id
from PR1 (`tmdbMediaId(type, tmdbId)`).

Episode-level and bulk tracking were **pulled into this PR during review** (see
Revision 2): per-episode watched, mark-next-episode, mark-season-watched,
mark-series-watched (MRQ-48/49/53/113).

**Still deferred to their own PRs:** user rating 1–5 (MRQ-114), auto status
transitions / completion sequence on the last episode (MRQ-55 — episode marks do
**not** auto-change status here), and the client sync engine that pushes/pulls the
outbox (MRQ-43 — offline-first means the local write is authoritative now).

## What the reference determines

From `reference/watchlist-ui-concept.jsx` (detail page, ~L1290–1334):

- **Favorite** is a `Heart` button, top-right of the title meta row, filled with
  the accent when `favorite` is true. → a toggle calling
  `recordEvent('tracking.favorite_toggled', mid, { favorite: !current })`.
- **Status** is displayed as an uppercase pill (`status.replace(/_/g, ' ')`).

## What it does NOT determine (the open question)

The reference's detail page assumes the title is **already on the user's list**
(`selected` comes from the user's items). Our detail page is reached from
**search** — the title is typically **untracked**. The reference specifies no
"Add to watchlist" affordance or status-picker for that first add. That was the
one real UX decision; it was settled in review (see Decisions below).

## Design

### Read model

- Add `getTrackingByMediaId(mediaId): Promise<ClientTracking | undefined>` to
  `src/lib/client/idb/state.ts` (unit-testable, node env).
- The detail page reads it client-side (`onMount` / `$effect`) — SSR renders a
  neutral "not tracked" state; the local state hydrates on the client. (No server
  round-trip: the client IDB replica is the source of truth for the user's data.)

### Action logic (pure, TDD'd)

A small `src/lib/tracking/actions.ts` of pure helpers — the testable core the
component composes with `recordEvent`:

- `toTrackingView(row)`: collapse a `ClientTracking` row (or `undefined`) into
  `{ tracked: false } | { tracked: true; status; favorite }`; a removed
  tombstone reads as untracked.
- `statusEventType(view)`: `'tracking.added'` when untracked (the first status
  asserts the row), else `'tracking.status_changed'`.
- `nextFavorite(view)`: the favorite value to write next (favoriting an untracked
  title implicitly adds it).

Keeping these free of IndexedDB/DOM lets the branching be unit-tested; the
component picks the literal `recordEvent(type, mid, payload)` call per branch so
the event type/payload correlation stays type-safe.

### Component

`TrackingControls.svelte` (in `src/lib/components/media/`), using existing
primitives (`toggle-group` or `dropdown-menu` for status, a `button` + `Heart`
for favorite). Reactive to the local read model; each action calls `recordEvent`
then re-reads. Wired into the detail page where the placeholder comment is.

**Testing reality:** this repo has no Svelte component test harness (vitest is
node-env, `*.test.ts` only), so the component itself is covered by typecheck +
build in CI (same as the existing detail page) plus **manual Playwright
verification against real IndexedDB** through a throwaway unauthenticated harness
route (`/dev-tracking-test`, deleted before commit) — the real detail page is
auth-gated. Verified: the full state progression, favorite toggle, the remove
dialog's three paths, and persistence across reload. The pure logic
(`actions.ts`) and read helper (`getTrackingByMediaId`) have real unit tests.

## Decisions (from review) — the built flow

The control sits **high up, above the description** (right after the
rating/runtime/genre meta row, before the collapsible Details toggle). Primary
button progresses:

- **untracked** → `[+ Want to Watch]` → emits `tracking.added { want_to_watch }`.
- **tracked, not completed** → `[✓ Mark Watched]` (→ `completed`) plus a `[×]`
  remove button (tooltip "Remove").
- **completed** → `[✓ Watched]` (secondary/active); clicking reverts to
  `want_to_watch`. `[×]` still present.

The **`[×]` opens a dialog** with three choices: **Remove** (destructive/red →
`tracking.removed`), **Mark as didn't finish** (→ `status_changed {
did_not_finish }`), **Cancel**. A **favorite Heart** toggle is always shown;
favoriting an untracked title implicitly adds it as `want_to_watch` (the
projection upserts a default row).

**UI refinements deferred** (foundation-first, per review — "refine the UI when we
get to it"): no explicit status _label_/pill yet, so `watching` and
`did_not_finish` both currently render as `[Mark Watched] [×]`; no `watching`
affordance in the primary control (episode tracking will drive that later); the
`[×]` tooltip is a native `title`, not the Tooltip component.

## Revision 2 — review feedback (2026-07-23), the final built shape

Testing the first cut surfaced three fixes and a series-specific redesign:

1. **Favorite is hidden until tracked.** The Heart only renders once the title is on
   a list (it was showing — and confusing — on untracked titles).
2. **Status is now visible.** A status pill (`Want to Watch` / `Watching` /
   `Completed` / `Didn't finish`) renders whenever tracked, so "didn't finish" is a
   real, legible state. "Didn't finish" is still **set from the `[×]` popup**, not a
   primary control; the pill only reflects it.
3. **Movies vs. series are tuned separately** instead of sharing one flow.

**Movie (tracked):** status pill + `Mark watched` (→ completed; `Watched` reverts) +
`[×]` (Remove / Mark as didn't finish / Cancel) + Heart.

**Series (tracked):** two rows —

- **Row 1** — next-episode quick-mark: "Next: S_·E_ · <title>" → marks that episode
  watched; the row recomputes the next unwatched episode and disappears when the show
  is fully watched. Title is best-effort from whatever season the page has cached.
- **Row 2** — the action row: status pill + `Mark series watched` (**confirm dialog** —
  seeds `episode.watched` for every real episode + sets `completed`) + `[×]` + Heart.

Plus, in the seasons section (tracked only): a **`Mark Season N watched`** button
(**confirm dialog**, bulk-seeds that season) and a **per-episode watched toggle** on
each episode row.

### Architecture added for this

- `src/lib/tracking/tracking.svelte.ts` — a reactive `TrackingState` class (runes)
  that wraps `recordEvent` + the IDB reads (`getTrackingByMediaId`,
  `getEpisodeWatches`) and exposes `view`, `watched` (a `Set` of `"season:episode"`),
  `ready`, `busy`, and the write actions. The page holds one via
  `const tracking = $derived(new TrackingState(mediaId))` + an `$effect` that reloads
  it; child controls receive it as a prop, so the whole page shares one optimistic
  source of truth.
- Pure, unit-tested helpers in `actions.ts`: `nextEpisode`, `allEpisodes`,
  `seasonEpisodes`, `watchedKey` (Specials/season 0 excluded from progression).
- `next-episode-row.svelte` and a reusable `confirm-dialog.svelte`.

Bulk marks seed one `episode.watched` per episode (per the AGENTS.md sync-push bound).
Verified end-to-end in the browser on The Matrix (movie) and Breaking Bad (series):
add, mark watched, DNF-via-popup with a visible pill, next-episode advance, mark
season (confirm), mark series (confirm → completed, row disappears), and per-episode
toggles.

## Stack position

PR1 (media identity, #87) → **PR2 (this)** → PR3 MRQ-56/57 (My Lists + dashboard,
which renders what these controls populate) → PR4 MRQ-111 (media pull channel).
