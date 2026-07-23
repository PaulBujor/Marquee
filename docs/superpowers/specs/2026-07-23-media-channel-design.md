# Media reference channel — server-side hydration (MRQ-111a)

**Date:** 2026-07-23
**Branch:** `paul/mrq-111-media-channel` (stacked on `paul/mrq-43-client-sync-engine`)
**Status:** approved, building

## Context

Tracked rows reference our `mediaId` (a one-way v5 hash of `provider:externalId`);
the lists/dashboard need title/poster/episode-counts to render, and those must
**sync** so a fresh device can show a watchlist it never tracked locally. Media is
heavier than events, so it rides its **own channel** (`POST /api/media/sync`),
triggered after each event sync. This is **111a** (metadata; posters via TMDB URL);
offline image blobs are **111b**, a follow-up.

## Security decision: server-side hydration (not store-and-forward)

`mediaId`s are publicly derivable and `linked` (TMDB-backed) media rows are shared/
crowdsourced (MRQ-90 reads them). If clients pushed metadata into that shared table,
a malicious client could overwrite a popular title's title/poster for everyone. So:

- The client sends only **identity** `{provider, externalId}`. The **server derives
  the id itself** (`mediaId(provider, externalId)`), ignoring any client-claimed id,
  and fetches title/poster/etc. **from TMDB** — shared rows only ever hold
  authoritative data; clients can't inject metadata.
- **Anti-abuse:** the server only hydrates media the requesting user's **own events
  reference** (a title must be in the user's synced event log), bounding TMDB fetches
  to legitimate media.
- Custom (user-authored) media is out of scope here and, when added, stays
  **private/per-user** — so client-authored metadata can never affect other users.

## Schema (migration 0007)

Add to `media`: `backdrop_path text` (header image) and `seasons text` (JSON
`[{seasonNumber, episodeCount}]` for shows, null for movies — powers Continue
Watching progress). Hand-write the matching down migration.

## Server

- `src/lib/server/media/hydrate.ts`:
  - `parseTmdbExternalId(externalId): { type, tmdbId } | null` (pure, tested) —
    parses `movie/603` / `show/1396`; rejects anything else.
  - `hydrateMedia(db, tmdbClient, provider, externalId): Promise<Media | null>` —
    derive id; if the row exists return it; else parse + `getDetails` + upsert
    `{ id, provider, externalId, source: 'linked', type, title, year, posterPath,
backdropPath, overview, seasons }`; return null on unknown provider / bad
    externalId / TMDB miss.
- `POST /api/media/sync` (auth-gated, problem+json, zod DTO):
  - Request `{ refs: {provider, externalId}[], need: string[] }`.
  - Derive ids for `refs`; union with `need`; **keep only ids referenced by the
    user's events** (`SELECT entity_id FROM events WHERE user_id = ? AND entity_id IN (…)`).
  - For each kept ref, `hydrateMedia` (fetches TMDB only when missing). Then return
    every kept id already present in `media`.
  - Response `{ media: MediaDTO[] }` (`id, provider, externalId, type, title, year,
posterPath, backdropPath, overview, seasons`).

## Client

- `db.ts`: reshape `ClientMedia` to `{ id, provider, externalId, source, type, title,
year, posterPath, backdropPath, overview, seasons, updatedAt }` (supersedes the
  `MediaSnapshot`-based shape). Bump `DB_VERSION` (per-user DBs are new, so no real
  data to migrate).
- `src/lib/client/idb/media.ts`: `putMedia`, `getMedia(id)`, `getAllMedia`,
  `getMediaRefs()` (identity of locally-known media), `getMissingMediaIds(ids)`.
- **Capture-at-track:** the detail page passes the title's snapshot to
  `TrackingState`; on a tracking write it `putMedia`s the row locally, so the
  tracking device renders immediately and offline, and has identity to push.
- `src/lib/client/sync/media-sync.ts`: `runMediaSync(fetchFn)` — gather local media
  identity (`refs`) + referenced-but-missing ids (`need`, from tracking rows minus
  local media), `POST /api/media/sync`, `putMedia` each returned row. Testable core.
- Engine: after a successful event `runSync`, run `runMediaSync`; bump `revision`
  when it applies media so open views re-read. (Media on its own call, never inside
  `/api/sync`.)

## Testing

- **Unit (TDD):** `parseTmdbExternalId`; `hydrateMedia` with a stub TMDB client +
  in-memory DB (hydrates once, caches, rejects bad externalId); `runMediaSync`
  round trip against fake-indexeddb + stub fetch (sends refs+need, stores returned
  media); `/api/media/sync` handler against the in-memory DB (only hydrates
  user-referenced ids).
- **Playwright:** on a fresh-IDB device for an account that tracked a title on
  another device, the media channel pulls the title's metadata and the list/detail
  renders its poster+title (image via TMDB URL).

## Out of scope

- **111b — offline image blobs** (fetch poster/backdrop → Blobs in IDB keyed by
  mediaId; SW cache-first). Next stacked PR.
- Server refresh / nightly re-sync (MRQ-38/39); custom-media push (Custom Media
  epic); media-channel rate limiting (extends MRQ-109).
