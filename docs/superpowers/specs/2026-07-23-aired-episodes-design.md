# Aired-episode awareness (MRQ-45)

**Date:** 2026-07-23
**Branch:** `paul/mrq-45-aired-episodes` (stacked on `paul/mrq-56-lists-dashboard`)
**Status:** built & browser-verified

## Problem

Media syncs only episode _counts_, which include announced-but-unaired episodes.
So a currently-airing show that you're caught up on still had a "next episode"
(pointing at something unaired) — it stayed in Continue Watching, and unaired
episodes were markable from the next-episode row, per-episode checks, and
mark-season/series (from manual testing).

## Fix — the aired frontier

TMDB's `/tv/{id}` returns `last_episode_to_air` (season+episode). We capture it as
**`lastAired`** on the media record (from `getDetails`), sync it via the media
channel (migration **0009** adds `media.last_aired`; captured at track-time +
server-hydrated), and cap everything to aired episodes:

- Pure logic (`actions.ts`): `isAired(coord, lastAired)` + `airedEpisodes(seasons,
lastAired)`; `nextEpisode` and `isSeasonFullyWatched` take the frontier (default
  null = uncapped, so existing 2-arg callers/movies are unaffected).
- Progress + Continue Watching (`library.ts`): `showProgress` counts aired only, so
  a caught-up show has `next = null` and drops out of Continue Watching.
- Completion (`reconcile.ts`): measured against aired episodes, so "all released
  episodes watched" completes the show (unaired don't hold it back).
- Bulk marks (`TrackingState`): `markSeasonWatched` / `markSeriesWatched` seed only
  aired episodes; `hasAired(season, episode)` gates the detail page's per-episode
  checkbox so unaired rows have no mark control.

`lastAired` is null for movies and not-yet-premiered shows (⇒ uncapped, i.e. current
behaviour).

## Testing

- **Unit (TDD):** `isAired`, `airedEpisodes`, `nextEpisode` capped at the frontier.
- **Browser (Playwright, real TMDB):** Silo (mid-air, `last_aired` S3E3, S3 lists 10
  eps) — episodes S3 E1–E3 have a mark control, E4–E10 don't; marking all aired
  episodes removes the next-episode row and drops Silo from Continue Watching.
  Data path confirmed in D1 (`last_aired` hydrated for Silo/GoT/Simpsons).

## Out of scope

Detecting a frontier advance to re-prompt / re-open a completed show when a new
episode airs (the rest of MRQ-45 / new-episode notifications) — needs a periodic
media re-sync (MRQ-38/39) to refresh `lastAired`; the status then reconciles when
the user marks the newly-aired episode.
