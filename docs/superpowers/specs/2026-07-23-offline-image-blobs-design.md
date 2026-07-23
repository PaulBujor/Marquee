# Offline image blobs (MRQ-111b)

**Date:** 2026-07-23
**Branch:** `paul/mrq-111b-image-blobs` (stacked on `paul/mrq-111-media-channel`)
**Status:** approved, building

## Context

111a synced media **metadata** (title/poster-path/backdrop-path/seasons); posters
still load from the TMDB URL, so they need network. 111b makes the local replica
**self-contained**: cache the poster + backdrop **image bytes as Blobs in IndexedDB**
keyed by our media id, so tracked titles render **with zero network** and an offline
export carries the artwork (data ownership — survives CDN/URL changes). Per AGENTS.md,
the IDB blob is the offline/export source of truth; SW full-res caching (MRQ-46) is
separate.

## Design

- **Store:** new IDB `mediaImages` object store keyed by our media id →
  `{ id, poster: Blob | null, backdrop: Blob | null, updatedAt }`. Bump `DB_VERSION`
  to 2 with an idempotent `upgrade` that creates it.
- **`idb/images.ts`:** `getMediaImages(id)`, `putMediaImages(id, { poster?, backdrop? })`,
  `mediaIdsMissingImages(candidates)` (media rows lacking a cached blob).
- **`image-sync.ts` (`runImageSync`, fetch injected):** after the media sync, for each
  cached media still missing images, fetch poster (`w342`) + backdrop (`w780`) from the
  TMDB image CDN, store the blobs. **Bounded** per run (e.g. 12 titles) so a big list
  fills in over several cycles, not one burst; `log`-free, best-effort (a failed image
  is retried next cycle). Wired into the engine after `runMediaSync` (non-fatal; bumps
  `revision` when it stores something). TMDB image CDN sends permissive CORS, so a
  client `fetch(...).blob()` yields real bytes; if that proves opaque in verification,
  fall back to a same-origin proxy (noted).
- **`MediaImage.svelte`:** given `{ id, path, kind, size, alt, class }`, renders the
  cached Blob (`URL.createObjectURL`) when present, else the TMDB URL; revokes the
  object URL on destroy / id change. This is the offline-capable `<img>` the lists
  (PR3) use everywhere; here it's wired into the detail hero + poster.

## Testing

- **Unit (TDD):** `runImageSync` round trip (fake-indexeddb + stub fetch returning
  image bytes → blobs stored; already-cached skipped; respects the per-run bound);
  `mediaIdsMissingImages`.
- **Playwright:** track a title → after sync the `mediaImages` store holds non-empty
  poster/backdrop blobs; the detail hero/poster render from the blob (and still show
  with the network blocked).

## Out of scope

SW cache-first for full-res posters (MRQ-46); custom-media user uploads; blob eviction
/ size caps (revisit if storage pressure shows up).
