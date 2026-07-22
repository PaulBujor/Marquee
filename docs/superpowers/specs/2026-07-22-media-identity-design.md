# Provider-agnostic media identity (MRQ-112, identity-only slice)

**Date:** 2026-07-22
**Branch:** `paul/mrq-112-provider-agnostic-media-identity`
**Status:** approved, ready for implementation plan

## Context

The Offline & Sync foundation (PR #82) shipped with an ad-hoc media id of the
form `movie:603` (`mediaId(type, tmdbId)` in `src/lib/sync/events.ts`). The #82
review decided media identity must be **ours and provider-agnostic** so we can
switch metadata providers (OMDb, or become our own) and survive a TMDB outage
**without any id remapping** (Linear MRQ-112; recorded in `AGENTS.md` →
"Offline-first data model").

This is worth doing **now, before the tracking loop is wired up**, because the
change is currently almost free:

- `mediaId()` has **zero call sites** — nothing computes a media id yet.
- The `media` table is **unpopulated scaffolding** — no code inserts or selects
  it (only defined in `schema.ts`).
- The `/api/sync` protocol is **already events-only** (`src/lib/sync/protocol.ts`);
  there is **no interim `media[]` sidecar to revert** (MRQ-111's revert is a
  no-op against the merged code).

Every tracking feature built afterwards would bake in the `movie:603` id, so the
cost of this refactor only grows.

## Scope

This is the **identity-only slice** of MRQ-112. In scope:

1. A deterministic, provider-agnostic media id.
2. A `media` schema that stores `{provider, external_id, source}` and is keyed
   by our own id.

**Explicitly deferred** to the Custom Media & Linking epic (MRQ-16), where they
are actually consumed — do **not** build them here:

- `media.linked` alias events and read-time alias resolution.
- `match_suggestions` table (MRQ-69) and custom→TMDB matching (MRQ-71/72).
- Random per-user UUIDs for custom media.

The schema must be shaped so these drop in later **without a second identity
migration** (i.e. `provider`/`external_id`/`source` already present; a future
`media_external_ids` / alias table references `media.id` as-is).

## Design

### Media id derivation

Media id becomes a **deterministic UUIDv5** derived from `(provider, externalId)`.
Same inputs → same UUID on every device, offline, with no coordination.

`src/lib/sync/events.ts` (client-safe module — imported by browser, server, and
drizzle-kit's esbuild bundle):

```ts
import { v5 as uuidv5 } from 'uuid';

/** Providers we can hydrate metadata from. Custom media is handled separately (deferred). */
export const MEDIA_PROVIDERS = ['tmdb'] as const;
export type MediaProvider = (typeof MEDIA_PROVIDERS)[number];

/**
 * Fixed UUIDv5 namespace for Marquee media ids. NEVER change this — it would
 * repoint every derived media id and orphan existing events.
 */
const MEDIA_ID_NAMESPACE = 'b7c8e9a0-3f2d-4c1b-9e6a-8d5f4a2b1c0e';

/** Our own, provider-agnostic media id: a deterministic v5 UUID from (provider, externalId). */
export function mediaId(provider: MediaProvider, externalId: string): string {
	return uuidv5(`${provider}:${externalId}`, MEDIA_ID_NAMESPACE);
}

/** TMDB's stable external id for a title — `${type}/${tmdbId}` (movie 603 ≠ show 603). */
export function tmdbExternalId(type: 'movie' | 'show', tmdbId: number): string {
	return `${type}/${tmdbId}`;
}

/** Convenience: our media id for a TMDB title. */
export function tmdbMediaId(type: 'movie' | 'show', tmdbId: number): string {
	return mediaId('tmdb', tmdbExternalId(type, tmdbId));
}
```

- **Why `uuid` (added dependency) rather than Web Crypto:** UUIDv5 requires
  SHA-1. `crypto.subtle.digest` is **async**, but `mediaId()` is called from
  synchronous paths (`createEvent`, projection, future UI handlers). The `uuid`
  package's `v5` is synchronous and pure-JS (works in workerd), so it keeps the
  call sites synchronous. Alternative (hand-rolled sync SHA-1) is more code to
  own for no benefit.
- **Why `type/tmdbId` as the TMDB external id:** TMDB numbers movies and shows
  independently, so `603` is ambiguous; `movie/603` is stable and unique.
- `entityId` on events is now this UUID (the docstring in `events.ts` referring
  to `movie:603` / `type:tmdbId` is updated accordingly).

### `media` schema (`src/lib/server/db/schema.ts`)

Replace the TMDB-specific columns with the provider-agnostic model:

| Column        | Type    | Notes                                                       |
| ------------- | ------- | ----------------------------------------------------------- |
| `id`          | text PK | our UUID (v5 for provider-sourced)                          |
| `provider`    | text    | `'tmdb'` (default); provider slug                           |
| `external_id` | text    | provider's id, e.g. `movie/603`; nullable (custom = null)   |
| `source`      | text    | `'linked' \| 'custom'`, default `'linked'`                  |
| `type`        | text    | `'movie' \| 'show'` — media kind, **not** provider identity |
| `title`       | text    | unchanged                                                   |
| `year`        | integer | unchanged, nullable                                         |
| `poster_path` | text    | unchanged, nullable                                         |
| `overview`    | text    | unchanged, default `''`                                     |
| `updated_at`  | integer | unchanged, epoch-ms LWW clock                               |

- Drop `tmdb_id` (integer) and the `media_tmdb_idx` unique index on
  `(tmdb_id, type)`.
- Add a unique index on `(provider, external_id)` — the natural key for
  provider-sourced rows. (Custom rows carry `external_id = null`; SQLite treats
  each NULL as distinct in a UNIQUE index, so multiple custom rows are fine.)
- `source` foreshadows the linked-vs-custom distinction MRQ-90 relies on
  (crowdsourced search only ever exposes `source = 'linked'` rows).

### Migration

- New migration(s) via `pnpm db:generate` (never edit 0004 — it is applied to
  remote D1). Implemented as a **two-pass split** — **0005** (add
  `provider`/`external_id`/`source` + new unique index) then **0006** (drop
  `tmdb_id` + old index) — because drizzle-kit's column-rename resolver needs an
  interactive TTY when a table both adds and removes columns in one diff, which
  is unavailable headless; splitting so each pass is add-only or drop-only skips
  the prompt. The `media` table is empty, so this is safe.
- Hand-write the matching `drizzle/down/0005_*.down.sql` and
  `drizzle/down/0006_*.down.sql` that reverse each (per `AGENTS.md` — up/down in
  lockstep, plain SQL, no `--> statement-breakpoint`).

### Route

`/title/[type]/[id]` stays **TMDB-keyed** — the URL is navigation, not identity.
No route change in this PR. We derive our UUID internally via `tmdbMediaId`.

## Testing

Add `src/lib/sync/events.test.ts` cases (or a colocated file):

- **Determinism:** `tmdbMediaId('movie', 603)` returns the same value across
  calls, and equals a hard-coded expected UUID (guards against an accidental
  namespace change).
- **Uniqueness:** `movie/603` and `show/603` derive different ids.
- **Shape:** result matches the UUID regex already in `events.ts`.

Existing coverage that must stay green:

- `projection.test.ts` (server materialization — unaffected but exercises the
  schema).
- `createTestDb()` applies migration 0005, so the migration is validated by
  every DB-backed test.

CI runs the full gate (`lint → check → build → test`); we rely on it rather than
the local full gate.

## Out of scope / follow-ups (the rest of the stack)

1. **PR2 — MRQ-41:** wire the dormant event pipeline (`src/lib/client/idb/*`)
   into the detail page: add-to-watchlist / status / favorite / rating →
   optimistic IDB write + outbox, using `tmdbMediaId`.
2. **PR3 — MRQ-56/57:** "My Lists" views + dashboard so tracked titles surface.
3. **PR4 — MRQ-111:** media pull channel + offline image blobs.
4. **Later:** episode-level tracking (MRQ-48/53), bulk actions (MRQ-49/113).

Each gets its own spec → plan → implementation cycle.
