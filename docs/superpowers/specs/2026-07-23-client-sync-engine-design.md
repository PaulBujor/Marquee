# Client sync engine (MRQ-43)

**Date:** 2026-07-23
**Branch:** `paul/mrq-43-client-sync-engine` (stacked on
`paul/mrq-41-event-writing-layer` → `paul/mrq-112-...`)
**Status:** approved, building

## Context

The event-sourced foundation (#82) shipped the server endpoint (`POST /api/sync`)
and every client piece — the outbox (`getUnsynced`/`markSynced`), the
`deviceId`/`cursor` meta, and `applyEventToIdb` — but **nothing calls
`/api/sync`**. So `recordEvent` writes to local IndexedDB and stops there:
tracking works on-device but never reaches the server, and nothing syncs across
devices. MRQ-43 is the engine that drives the round trip. It's the first
prerequisite for multi-device (then MRQ-111 media channel, then the lists/
dashboard read the synced local stores unchanged).

## Design

### Core round trip

`runSync({ fetch })` — `fetch` injected so it's unit-testable:

1. `deviceId = getDeviceId()`, `cursor = getCursor()`, `events = getUnsynced(SYNC_MAX_PUSH)`.
2. `POST /api/sync` with `{ deviceId, cursor, events }` (the existing `SyncRequest`).
3. On `200`: `markSynced(applied)`; `applyEventToIdb` each pulled event; `setCursor(res.cursor)`.
4. Loop while `res.hasMore` **or** the push was full (`events.length === SYNC_MAX_PUSH`) — i.e. more to pull or more to push.

Idempotent: the server dedupes by event id and merges LWW, so re-pushing after a
failed ack is safe. Pulled events include the client's own (now server-persisted)
events; re-applying them is a no-op.

### Engine (rune singleton)

`src/lib/client/sync/engine.svelte.ts` — mirrors the `theme`/`pwa` singletons.
Reactive `status: 'idle' | 'syncing' | 'error' | 'offline'` (reused later by the
sync-pending indicator, MRQ-95). Guards against overlapping runs with a `running`
flag; a `requestSync()` received mid-run sets a `rerun` flag so it runs again once
the current pass finishes (coalesced, not queued).

### Triggers

Set up once, browser-only, when authenticated:

- **mount** (initial catch-up), **`visibilitychange`** → visible, window
  **`online`**, and a **~45s interval** while the tab is open.
- **write-nudge**: `TrackingState`'s write path calls `requestSync()` (debounced)
  so a change pushes promptly instead of waiting for a trigger.

### Retry / offline

Exponential backoff on network/5xx failure (2s → capped ~60s), reset on success.
A pure `backoffDelay(attempt)` helper is unit-tested. While `navigator.onLine` is
false, `status = 'offline'` and runs are skipped; the `online` listener kicks a
sync on reconnect.

### Per-user databases (data-safety, replaces reset-on-switch)

**Sensitive data must never be lost on an accidental wrong-account login.** So the
IndexedDB is **namespaced per user**: `openDb()` opens `marquee-<userId>` using an
active-user id set once via `setActiveUser(id)` from `+layout.svelte` (reactively
from `data.user.id`) before any tracking UI mounts.

- Switching accounts opens a _different_ DB — the prior user's DB (including
  unsynced events) is untouched; logging back in restores it intact.
- No cross-user leakage; **no destructive reset** anywhere.
- `openDb()` throws if no active user is set (fail loud rather than write to the
  wrong store). `dbPromise` is invalidated when the active user changes.
- `deviceId` lives in each per-user DB's `meta` (per-user-per-device is fine for
  event attribution/dedup).

This supersedes the `userId` meta mismatch/reset approach.

### Wiring

Started from `+layout.svelte` when `data.user` exists: `setActiveUser(user.id)`,
then start the engine (listeners + interval + initial sync). Teardown removes
listeners/timers.

## Testing

- **Round trip (TDD, fake-indexeddb + stub fetch):** seeds unsynced events →
  `runSync` pushes them, clears the outbox (`markSynced`), applies pulled events
  into `tracking`/`episodeWatches`, advances the cursor, and loops on `hasMore`.
- **`backoffDelay`** pure helper.
- **Per-user DB:** `openDb` throws without an active user; two different active
  users open independent stores (data written under A is absent under B).
- Existing `state`/`outbox` tests set a test active user in `beforeEach`.
- Manual (Playwright): two browser contexts signed into the same seeded account —
  a tracking change in one appears in the other after a sync.

## Out of scope / follow-ups

- Media channel (MRQ-111) — separate parallel sync for reference data + image
  blobs; next in the stack.
- Rate-limit handling `429`/`Retry-After` (MRQ-109) and a visible sync-pending
  indicator (MRQ-95) — later; `status` is the hook for the latter.
