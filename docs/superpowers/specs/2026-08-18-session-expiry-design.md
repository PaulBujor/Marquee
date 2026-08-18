# Handling an expired session elegantly

## Problem

The client error reporter now surfaces every reported error as a toast. An expired session is not a
bug, but it reaches that path anyway: the SPA caches `data.user`, so nothing notices the session is
gone, and every authed fetch starts returning 401. The event channel turns that into
**"Something went wrong · sync failed: HTTP 401"**, re-raised on each 60s cycle (throttled to three
per 30s window). A normal, expected end-of-session reads as a crash.

A session ends when `validateSession` drops it — the 30-day sliding TTL lapses, the account stops
being `enabled`, or the row is gone (logout elsewhere, account deleted). Safari/ITP eviction is the
fourth path, and it can take the cookie and the IndexedDB replica independently.

### What each path does today

| Path | Today |
| --- | --- |
| `/api/sync` (events) | `SyncError(401)` → not retriable → trips the events breaker → `reportClientError({source:'sync'})` **unhandled** → the generic error toast, every cycle |
| `/api/media/sync` | plain `Error('media sync failed: HTTP 401')`, retried 3× against a hopeless 401 first, then the same generic toast |
| `/api/media/image` | warn-only in the sync log; silent |
| `/api/whoami` (service worker) | silently aborts the background-sync flush |
| `/search` load | returns empty results — reads as "no results" |
| `/person/[id]` load + pagination | returns `reachable: false` — says "needs a connection", which is untrue |
| `/title/…` enrich | `{ status: 'error' }` |
| `title-detail.svelte` season fetch | swallowed |
| `/api/push/*` (notifications state + settings card) | swallowed |
| settings form actions | `fail(401, { message: 'Service unavailable.' })` — mislabels expiry as an outage |

Only a hard reload or a layout-revalidating navigation clears it. Then `data.user` goes null, the
layout `$effect` tears down sync, and the routes with a `+page.ts` guard redirect to `/login` —
silently, with no explanation. `/` and `/timeline` have no guard and render their signed-out state
in place.

## Decisions

1. **Toast and stay put.** On detection the app keeps its shell and stays readable from the local
   replica; sync pauses. We deliberately do **not** call `invalidateAll()`, which would null
   `data.user`, hide the tab bar and bounce guarded routes mid-scroll. Navigation happens only when
   the user chooses it.
2. **Detection is wide.** One shared helper, used by the three sync channels and every client-side
   authed fetch, so a tap during the window gets the honest message instead of "no results".
3. **A distinct `signed-out` sync status.** The indicator's error copy literally says "retrying
   automatically", which becomes a lie once the engine stops.
4. **Scope: detection only.** The "Restoring your library…" state for an evicted replica is
   deliberately out (see Non-goals).

## Design

### 1. Detection primitives

`src/lib/client/session.ts` — pure, no runes, unit-testable:

- `class SessionExpiredError extends Error` — one type every caller can distinguish.
- `isAuthFailure(status: number): boolean` → `status === 401`.
- `assertAuthed(res: Response): void` — throws `SessionExpiredError` on a 401, nothing more.

`src/lib/client/session.svelte.ts` — rune singleton, mirroring `errors.svelte.ts`:

- `expired = $state(false)`, `announced = $state(false)`.
- `expire(source: string): void` — **idempotent**: three channels 401ing in the same cycle produce
  one announcement. The first call flips `expired` and calls
  `reportClientError({ …, handled: true })`. The `handled` flag exists for exactly this: the expiry
  is recorded in the diagnostics log and forwarded to the sink (worth having if a 401 ever turns out
  to be a bug) without raising the generic toast.
- `reset(): void` — on a fresh sign-in.
- `authFailed(res: Response, source: string): boolean` — marks expired and returns true on a 401.
  For loads and components that degrade rather than abort.

**The split matters.** `assertAuthed` stays pure and touches no state, so the three sync channels
keep importing only plain modules and their tests never mutate a shared singleton. The engine —
which already depends on rune modules — is the single place that catches `SessionExpiredError` and
calls `expire()`. The two helpers exist because the call-site families want opposite control flow: a
channel aborts the cycle, a load returns its offline-shaped fallback.

### 2. Sync channels

`assertAuthed` goes into `sync.ts` (`runSync`), `media-sync.ts`, and `image-sync.ts`, ahead of each
existing `!res.ok` throw. In `engine.svelte.ts`:

- `SyncStatus` gains `'signed-out'`.
- New `markSignedOut()` sets the status and calls `stop()` — killing the 60s interval is what ends
  the storm.
- `retriableSync` **must** exclude `SessionExpiredError`. Its current
  `!(err instanceof SyncError) || …` returns true for any non-`SyncError`, so an expiry would be
  retried three times before surfacing.
- `#runChannel` rethrows `SessionExpiredError` **before** `circuit.recordFailure()`. An expiry is
  not a channel fault, and a tripped breaker would sit in its 60s cooldown blocking the catch-up
  sync right after the user signs back in.
- `#sync()` bails immediately when `session.expired`. On a `SessionExpiredError` from any channel it
  calls `sessionState.expire(<channel>)`, records
  `syncLog.add('cycle', 'signed out — sync paused', 'warn')`, and returns without setting `lastError`
  or reporting an error. This is the only place a channel 401 becomes session state.

### 3. The toast

New `src/lib/components/session-expired-toast.svelte`, mounted in the root layout beside
`<ErrorReporter />` and built the same way — watch the state, raise the sonner:

- Title "You've been signed out", description "Your session expired. Sign in again to keep syncing."
- `duration: Infinity` — this is a state, not an event, so it should not time out.
- Action **Sign in** → `goto(resolve('/login'))`.

Keeping sonner and `goto` in a component rather than the state module matches `ErrorReporter` and
leaves `session.svelte.ts` testable without either.

The root layout gains `$effect(() => { if (session.expired) sync.markSignedOut(); })`. The layout
already owns the sync lifecycle, and routing the reaction through it avoids the import cycle that
`session.svelte.ts` → `engine.svelte.ts` → `session.svelte.ts` would otherwise create.

### 4. The sync indicator

`sync-indicator.svelte` ranks `signed-out` **below** `offline` (when both apply, being offline is
what actually blocks signing in) and **above** `error`:

- Tooltip: "You're signed out — your changes are saved on this device and will sync when you sign in
  again."
- Single tap → `/login`.
- In this state only, the hidden double-tap sync-log gesture is dropped, so a double-tap cannot both
  navigate and open the log behind it. Every other state keeps it untouched. Accepted trade-off: the
  sync log is unreachable while signed out, where it holds one line anyway.

### 5. Client-side authed fetches

Each gets `authFailed(res, source)` and keeps its existing fallback shape; the persistent toast and
the indicator carry the explanation.

- `src/routes/search/+page.ts`
- `src/routes/person/[id]/+page.ts` and `src/routes/person/[id]/+page.svelte` (pagination)
- `src/routes/title/[type]/[id]/+page.ts` (`fetchEnriched`)
- `src/routes/title/[type]/[id]/title-detail.svelte` (season fetch)
- `src/lib/state/notifications.svelte.ts` (vapid-key, subscribe)
- `src/routes/settings/notifications-card.svelte` (list, delete)

### 6. Server-side honesty

`src/routes/settings/+page.server.ts` — the three `if (!locals.user) return fail(401, { message:
SERVICE_UNAVAILABLE })` branches get a dedicated `SESSION_EXPIRED` message. A null `locals.user` on
an authed action means the session ended; it is not a service outage.

### 7. Reset on re-login

- `src/routes/login/+page.svelte` — `session.reset()` beside the existing `clearPendingLogout()` in
  the code-verify success handler.
- The root layout's account-change effect — `session.reset()`.
- Magic-link sign-in is a full page load, so module state resets on its own.

## Non-goals

- **The "Restoring your library…" state.** After an eviction that takes the replica, the first sync
  post-login re-pulls the whole event log while the dashboard shows its "Nothing here yet" empty
  state, which reads as data loss. Real, and deliberately separate work.
- **The service worker's `/api/whoami` 401.** A worker has no access to the rune; the next
  foreground cycle detects the expiry.
- **Per-page signed-out copy.** `/search` still renders "no results" rather than "sign in to
  search". The persistent toast plus the indicator are judged sufficient here.

## Testing

- `session.test.ts` — `isAuthFailure`, `assertAuthed` throwing on 401 and passing everything else.
- `session.svelte.test.ts` — `expire()` idempotence (three sources, one announcement), `reset()`,
  the `handled: true` report, `authFailed` on 401 vs other statuses.
- `sync.test.ts`, `media-sync.test.ts`, `image-sync.test.ts` — a 401 throws `SessionExpiredError`
  rather than `SyncError` / a generic `Error`.
- Retry/breaker behaviour — `SessionExpiredError` is never retried by `retriableSync` and never
  reaches `circuit.recordFailure()`.

## Notes on the workspace

Branched from `origin/main` (`d592a09`, the error-reporting commit) in a worktree, so none of the
unmerged custom-media work is present — there is no `/custom` route, no `credit-row.svelte` and no
`write-guard.ts` to wire up here. `better-sqlite3@13` cannot build locally (no MSVC), so the
DB-backed server tests run in CI; the client suites this change touches run locally and were green
at baseline (17 files, 149 tests).
