# Home dashboard: Continue Watching + My Lists (MRQ-56/57/54/58)

**Date:** 2026-07-23
**Branch:** `paul/mrq-56-lists-dashboard` (stacked on `paul/mrq-111b-image-blobs`)
**Status:** approved, building

## Context

The sync stack (events + media) is done, so the home page — empty for signed-in
users today — becomes the dashboard, reading the **local IndexedDB** stores
(tracking ⋈ media ⋈ episode-watches), reactive to `sync.revision`. Works offline
and multi-device. Series and movies are treated differently (per the reference):
**Continue Watching and progress rings are shows-only** (movies have no next
episode); poster tiles show a movie/show type icon + favorite heart.

## Data

- **`genres` on media** (migration 0008; `MediaRecord`/`ClientMedia`; captured at
  track-time + hydrated server-side from `detail.genres`) — needed for the genre
  filter. Existing cached rows backfill as they're re-hydrated; newly-tracked
  titles carry genres immediately from the detail page.
- **`LibraryState`** (`src/lib/tracking/library.svelte.ts`): loads non-removed
  tracking rows joined with their `ClientMedia` and, for shows, an episode-watch
  progress `{ watched, total, next }`. Reactive; the page re-loads on
  `sync.revision`.

## Pure logic (`library.ts`, TDD)

- `showProgress(seasons, watchedSet)` → `{ watched, total, fraction }` for shows
  with episodes, else null (movies).
- `continueWatching(items)` → in-progress shows (a next episode exists), for the
  dashboard row.
- `filterAndSortLibrary(items, { tab, type, year, genre, sort })` — tab
  (want_to_watch / watching / completed / favorites, where favorites = favorite
  flag across statuses), type (all/movie/show), optional year + genre, and sort
  (title / date-added / release-year). `favorites` tab shows favorited items
  regardless of status.
- `availableYears(items)` / `availableGenres(items)` for the filter options.

## UI (`/+page.svelte`, signed-in)

Reuses `ProgressRing`, `PosterTile` (extended with optional `mediaId`+`posterPath`
→ renders `MediaImage`, so list posters are offline-capable), and the shadcn
`tabs` / `toggle-group` / `dropdown-menu` primitives.

- **Continue Watching** — horizontal scroll of in-progress shows: poster + a
  progress ring with a centered **mark-next-episode** tap target (MRQ-54) + "S_·E_".
- **My Lists** — tab bar (4 tabs) → responsive **poster grid**; each tile links to
  the detail page, shows the type icon + favorite heart.
- **Filters/sort** (MRQ-58) — a type segmented control (All/Movies/Shows) always
  visible; a "Filters" disclosure for year + genre; a sort control. All applied
  client-side via `filterAndSortLibrary`.
- Empty states per tab (reuse `empty-state`).

Signed-out home keeps the existing landing copy.

## Testing

- **Unit (TDD):** `showProgress`, `continueWatching`, `filterAndSortLibrary`,
  `availableYears/Genres`.
- **Playwright:** dashboard renders tracked items in the right tabs; switching
  tabs + type/year/genre filters + sort update the grid; a show appears in
  Continue Watching and its quick-mark advances; posters render from cached blobs.

## Out of scope

Completion animation on the Continue Watching card (MRQ-55 flourish); crowdsourced
search (MRQ-90); custom media tiles (Custom Media epic).
