# Tracking controls on the detail page (PR2 — MRQ-50 / MRQ-51, closes MRQ-41 wiring)

**Date:** 2026-07-22
**Branch:** `paul/mrq-41-event-writing-layer` (stacked on
`paul/mrq-112-provider-agnostic-media-identity`, PR #87)
**Status:** built & browser-verified (Playwright, via a throwaway harness route — the
real detail page is auth-gated). Flow decided by review; see Decisions.

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

## Stack position

PR1 (media identity, #87) → **PR2 (this)** → PR3 MRQ-56/57 (My Lists + dashboard,
which renders what these controls populate) → PR4 MRQ-111 (media pull channel).
