# Tracking controls on the detail page (PR2 — MRQ-50 / MRQ-51, closes MRQ-41 wiring)

**Date:** 2026-07-22
**Branch:** `paul/mrq-41-event-writing-layer` (stacked on
`paul/mrq-112-provider-agnostic-media-identity`, PR #87)
**Status:** DRAFT — awaiting decision on the add-flow UX (see Open questions)

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

**Deferred to their own PRs:** user rating 1–5 (MRQ-114 — the reference shows only
the TMDB /10 rating, so our rating control's placement is unspecified), episode
watched-state (MRQ-48/53), bulk actions (MRQ-49/113), the client sync engine that
pushes/pulls the outbox (MRQ-43 — offline-first means the local write is
authoritative now; server sync lands later).

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
"Add to watchlist" affordance or status-picker for that first add. This is the
one real UX decision blocking implementation (see Open questions).

## Proposed design (pending the add-flow decision)

### Read model

- Add `getTrackingByMediaId(mediaId): Promise<ClientTracking | undefined>` to
  `src/lib/client/idb/state.ts` (unit-testable, node env).
- The detail page reads it client-side (`onMount` / `$effect`) — SSR renders a
  neutral "not tracked" state; the local state hydrates on the client. (No server
  round-trip: the client IDB replica is the source of truth for the user's data.)

### Action logic (pure, TDD'd)

A small `src/lib/tracking/actions.ts` mapping a UI intent + current state to the
correct event — the testable core:

- `setStatus(current, next)`: emit `tracking.added` when `current` is
  untracked/removed, else `tracking.status_changed`.
- `toggleFavorite(current)`: emit `tracking.favorite_toggled` with the negated
  value (added implicitly if the title wasn't tracked — decision below).

These return `{ type, payload }` for the component to pass to `recordEvent`, so
the branching logic is covered by unit tests without a DOM.

### Component

`TrackingControls.svelte` (in `src/lib/components/media/`), using existing
primitives (`toggle-group` or `dropdown-menu` for status, a `button` + `Heart`
for favorite). Reactive to the local read model; each action calls `recordEvent`
then re-reads. Wired into the detail page where the placeholder comment is.

**Testing reality:** this repo has no Svelte component test harness (vitest is
node-env, `*.test.ts` only), so the component itself is covered only by
typecheck + build in CI, same as the existing detail page. The pure logic and
read helper get real unit tests. The visual layer needs manual verification —
which is why this pauses for review rather than shipping blind.

## Open questions (need a decision before building)

1. **Add-flow affordance.** For an untracked title from search, how is it added?
   Options: (a) a primary "Add to watchlist" button that, once added, becomes the
   status picker; (b) always show the status picker, and picking any status
   performs the add; (c) a `+`/bookmark icon that adds as `want_to_watch`, with
   status changeable afterward. Recommendation: **(b)** — one control, fewest
   taps, matches the reference's single status pill.
2. **Favorite before tracking.** Can you favorite an untracked title (implicitly
   adding it), or is favorite only available once tracked? Recommendation:
   **implicit add** (favoriting adds a `want_to_watch` row), so the Heart always
   works — but confirm.
3. **Status set → `did_not_finish`.** Surface all four statuses in the picker, or
   keep `did_not_finish` to a secondary action? Recommendation: all four in a
   dropdown; `did_not_finish` reads oddly as a primary toggle.

## Stack position

PR1 (media identity, #87) → **PR2 (this)** → PR3 MRQ-56/57 (My Lists + dashboard,
which renders what these controls populate) → PR4 MRQ-111 (media pull channel).
