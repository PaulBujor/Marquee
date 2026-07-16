# Watchlist App — Product & Technical Spec

**Status:** Draft v1
**Purpose:** Personal replacement for TV Time — track movies/shows, watch status, favorites, and episode progress. No social features.

This document is written to be decomposed into GitHub issues. Each numbered item under "Epics" is intended to become one issue (or a small set of sub-issues where noted).

**Reference implementation:** `watchlist-ui-concept.jsx` is a throwaway React mockup of the UI/UX (plain inline styles, mock data — not the real stack, not shippable code). This spec points into it by `data-spec-ref="..."` values on specific elements (e.g. "see `continue-watching-quickmark`"), so an implementer can jump straight to the interaction being described. Those attributes exist only for this cross-referencing and should not be carried into the real app unless a genuine later need justifies it (e.g. e2e test hooks).

---

## 1. Goals & Non-Goals

**Goals**

- Track movies and TV shows: want to watch, watching, completed, dropped
- Season/episode-level progress tracking for shows
- Favorites (simple flag, not a rating system)
- Pull rich metadata from TMDB: details, cast, images, trailers, ratings
- Cache aggressively so TMDB is only hit when data is missing or stale
- Installable on phone as a PWA, no app store / dev account required
- Run entirely on Cloudflare (Workers + D1), no separate backend host
- Work offline: view tracked lists, mark episodes/shows watched, toggle favorites without a connection, syncing once back online
- Discover new things to watch (trending/popular) — deferred to post-v1, see §12
- One-time import of existing TV Time watch history, plus an ongoing self-service data export
- Surface upcoming releases across tracked lists in a calendar-style view
- Add a niche title not on TMDB using just basic identifying text, and later link it to TMDB data if a match appears — without losing tracking history

**Non-Goals**

- No social features: no comments, reviews, friend activity, sharing
- No user-generated ratings/reviews (TMDB's rating is displayed, that's it)
- No multi-provider metadata merging (TMDB only, for now)
- No native mobile app (PWA only)
- No real-time multi-device sync (eventual sync on reconnect is enough — this isn't a collaborative app)
- No media acquisition/downloading of any kind — the Jellyfin integration (§15) is a read/write API surface only, not a download mechanism

---

## 2. Architecture Overview

- **One SvelteKit app, one Cloudflare Worker.** `adapter-cloudflare` (not `adapter-static`) — the built client (the installable PWA shell) and the API (`+server.ts` routes) deploy together, one `wrangler.jsonc`, one domain, one deploy command. See §3 for local dev.
- **Why one Worker, not two:** splitting frontend and API into separate Workers means CORS config, cross-origin session handling, and two deploy pipelines to keep in sync — real friction with no payoff for a personal project. Same-origin keeps auth, requests, and deploys simple.
- **Database:** Cloudflare D1 in both production and local dev — the same engine, the same driver (`drizzle-orm/d1`), no separate local database to keep in sync. See §3.
- **Local storage:** IndexedDB in the browser (not `localStorage` — needs structured queries and larger capacity) for the offline event queue + cached lists/episodes
- **Asset caching:** Hotlink TMDB CDN images directly; optionally proxy through Workers + R2 later if offline resilience is needed (not v1)
- **Auth:** Passwordless (email magic link / code), `httpOnly` session cookie — no password hashing anywhere (avoids CPU-time limits on Workers free tier). See §6.
- **Email delivery:** `EmailSender` interface — `ResendSender` (production, Resend's HTTP API) and `SmtpSender` (local dev, plain SMTP against a Mailpit container). Workers cannot send SMTP directly, which is why production goes through Resend's HTTP API instead.
- **External API:** TMDB (movies, shows, seasons, episodes, credits, images, videos, ratings)
- **Scheduled jobs:** Cloudflare Cron Triggers for nightly TMDB re-sync of in-production/airing shows and the daily notification sweep
- **Sync model:** Event-sourced tracking data (status changes, episode watched/unwatched, favorites, custom-entry creation) — see §7
- **Notifications:** Web Push API (VAPID) for episode/movie release alerts — see §10
- **Secrets:** none committed to the repo. Production secrets (TMDB API key, Resend API key, VAPID keypair, any future integration API keys) are Cloudflare Workers secrets (`wrangler secret put`), injected as bindings at runtime — never written into `wrangler.jsonc` or any tracked file. Local dev secrets live in a git-ignored `.dev.vars` (Wrangler's standard convention, auto-loaded by local dev); a `.dev.vars.example` with placeholder keys and no real values is committed as the template new contributors copy.

---

## 3. Local Development

**Layout**

```
src/routes           — pages + PWA shell (SvelteKit)
src/routes/api/...    — API endpoints, as +server.ts files (same app, same origin)
src/lib/server/db     — Drizzle ORM schema (drizzle-orm/d1)
src/lib/server/email  — EmailSender interface: ResendSender (prod) / SmtpSender (dev, via Mailpit)
docker-compose.yml    — root-level, just Mailpit (SMTP capture + web UI)
.dev.vars.example     — committed template for local secrets
.dev.vars             — actual local secrets (git-ignored)
```

**Database: one engine, one driver, everywhere**

- Local dev runs against a real local D1 instance via Wrangler / the Cloudflare Vite plugin (which `adapter-cloudflare` integrates with) — this is the same D1 engine Cloudflare runs in production, not an emulation, with data persisted across restarts under `.wrangler/state` (or a custom path via `--persist-to`).
- `env.DB` is therefore a genuine D1 binding in local dev too, so there is exactly one Drizzle client (`drizzle-orm/d1`) used everywhere — no dual-driver setup, no separate SQLite file to manage, no factory function branching on which environment is active.
- Migrations: `wrangler d1 migrations apply <db-name> --local` applies against the same local D1 instance used by local dev.
- This still means zero Cloudflare _account_ interaction for the daily dev loop — no login, no network calls, no deployed resources touched. It's Wrangler's local Workers runtime, running entirely on-device. The only actual cloud interaction is the one-time login required before the first deploy.
- D1 bills per row read in production, not per query — worth keeping indexes in mind as real usage grows, even though the same schema behaves identically (just without a cost signal) in local dev.

**Email**

- `SmtpSender` (dev) sends real SMTP to the local Mailpit container; `ResendSender` (prod) calls Resend's HTTP API. Magic-link emails are fully testable locally via Mailpit's web UI (default `http://localhost:8025`).
- Naming note: the interface is `EmailSender`, and the dev implementation is `SmtpSender` — it just happens to point at Mailpit locally. Keeping the class name generic (rather than `MailpitSender`) means it would work unchanged against any other local or self-hosted SMTP relay later.

**Auth needs no special setup**

- Auth is hand-rolled (no third-party auth library), so `sessions`/`login_tokens` are ordinary Drizzle queries like anything else in the schema — no auth-library adapter/driver compatibility to worry about.

---

## 4. UI & Design System

- **Styling:** Tailwind CSS v4
- **Component foundation:** Bits UI (headless, accessible primitives — dialogs, dropdowns, popovers, focus traps, keyboard nav) styled with Tailwind via **shadcn-svelte** as the starting point. shadcn-svelte's CLI copies component source directly into the repo rather than installing an opaque package — components are owned and customized from day one.
- **Component library:** lives in `src/lib/components`; every screen (lists, detail pages, search, timeline, settings) is built from this shared set rather than one-off markup, so behavior — focus states, loading states, empty states — stays consistent app-wide
- **Reactivity:** Svelte 5 runes (`$state`, `$derived`, `$effect`) at the component level; a small set of app-wide runes covers cross-cutting state (sync status, auth session, offline queue length)
- **Dark/light mode:** Settings control with three states — **Auto** (default, follows `prefers-color-scheme` via Tailwind's `dark:` variant), **Light**, **Dark** — stored client-side only, since it's a per-device display preference rather than tracking data (no DB column, no cross-device sync)
- **Navigation:** no persistent bottom tab bar. The home screen header carries three icons (Timeline, Settings, Search) plus the wordmark; other screens show a back arrow + screen title — keeps chrome minimal on a screen that's otherwise all content (posters, lists)
- **Design tokens:** shadcn-svelte's default theme is a starting point, not the final look — palette and type scale get a dedicated design pass (see Epic B) rather than shipping the unmodified default

---

## 5. Data Model

### `users`

- `id`, `email`, `created_at`

### `sessions`

- `id` (session token, or a hash of it — see §6), `user_id` (FK), `device_id`, `created_at`, `expires_at`, `last_used_at`

### `login_tokens`

- `id`, `user_id` (FK, nullable until first verified signup), `email`, `token_hash` (SHA-256 of the random token/code sent), `expires_at` (~15 min), `used_at` (nullable), `created_at`

### `media`

- `id` (internal PK, app-generated — **not** any external provider's id, so custom and external-linked entries share the same id space and tracking references never need to change on merge), `source` (`custom` | `linked` — "linked" means at least one row exists in `media_external_ids`), `type` (movie | show), `title`, `overview`, `year_start`, `year_end`, `year_precision` (`exact` | `approx` | `decade` | `century` | `range` — see §9 for how these are set; null for linked entries, which use `release_date` instead), `year_anchor` (nullable — the originally-typed year for `approx` entries, e.g. display "~1984" rather than a raw range), `poster_path` (null for unlinked custom entries — no custom image upload, see §9), `backdrop_path`, `release_date`, `tmdb_rating`, `in_production` (bool, shows only), `last_synced_at`, `raw_json` (full provider payload snapshot, optional)

### `media_external_ids`

- `media_id` (FK), `provider` (`tmdb` for now; schema supports adding others later without migration), `external_id`, `last_synced_at`

### `seasons`

- `id`, `media_id` (FK), `season_number`, `name`, `episode_count`, `last_synced_at`

### `episodes`

- `id` (internal PK), `season_id` (FK), `episode_number`, `name`, `overview`, `air_date`, `still_path` — `(season_id, episode_number)` doubles as a natural key used to remap custom episodes onto their TMDB equivalents on merge (see §9)

### `credits`

- `media_id` (FK), `person_id`, `name`, `character`, `profile_path`, `order`

### `videos` (trailers)

- `media_id` (FK), `key` (YouTube key), `type`, `name`

### `events` (append-only, source of truth for tracking data)

- `id` (client-generated UUID, primary key — enables safe replay/dedup), `user_id` (FK), `device_id`, `type` (media_status_changed | favorite_toggled | episode_watched | episode_unwatched | custom_media_created), `payload` (JSON: media_id/episode_id + new value, or full custom-entry data for `custom_media_created`), `client_timestamp` (when the action happened on-device), `server_seq` (autoincrement, assigned on arrival — used as the sync cursor)

### `user_media_status` (materialized view, derived from `events`)

- `user_id` (FK), `media_id` (FK), `status` (want_to_watch | watching | completed | dropped), `is_favorite` (bool), `updated_at`

### `user_episode_progress` (materialized view, derived from `events`)

- `user_id` (FK), `episode_id` (FK), `watched_at`

### `push_subscriptions`

- `id`, `user_id` (FK), `device_id`, `device_label` (e.g. "iPhone — Safari," auto-derived from user agent, editable by the user), `endpoint`, `p256dh_key`, `auth_key`, `created_at`, `last_used_at`

### `match_suggestions`

- `media_id` (FK, must be a `source = custom` row), `provider` (e.g. `tmdb`), `suggested_external_id`, `confidence` (rough score from the title/year match), `created_at`, `dismissed_at` (nullable — user said "not a match")

---

## 6. Passwordless Auth Flow

- **Request:** User submits email → generate random token (32 bytes) → store `sha256(token)` in `login_tokens` with a ~15 min expiry → send email via Resend containing a link (`/auth/verify?token=...`) and/or a 6-digit code for manual entry
- **Verify:** Incoming token/code is hashed and matched against `login_tokens` → check not expired, not already used → create user record if first login → issue a session token, insert a `sessions` row, set it as an `httpOnly`, `Secure`, `SameSite=Lax` cookie → mark login token `used_at` (or delete row)
- **Session transport is a plain cookie, not a bearer token** — set automatically by the browser on every request, never touches client-side JS (nothing for an XSS bug to steal), no manual header plumbing needed.
- Every request, a `hooks.server.ts` auth check looks up the cookie's session hash against `sessions`, checks `expires_at`, and updates `last_used_at`
- **Rate limiting:** Cap login-link requests per email/IP (e.g. 5 per hour) to prevent email-bombing an address
- **No password flow needed:** no "forgot password," no password_hash column, no bcrypt/argon2 CPU cost — keeps every auth-related request well under the Workers free tier's 10ms CPU limit

---

## 7. Offline-First Sync (Event Sourcing)

**Why event sourcing here:** tracking actions (mark watched, change status, favorite) are small, independent facts. Recording them as events — rather than overwriting a row — means two devices that were both offline can each contribute their own history without one silently clobbering the other, and replay/merge becomes a matter of applying events in order rather than reconciling arbitrary row diffs.

**Client-side (IndexedDB)**

- Every tracking action writes an event to a local IndexedDB `events` store immediately (works offline)
- Local materialized state (what the UI reads from) is updated optimistically at the same time, so the UI never waits on the network
- Each event gets a client-generated UUID + `client_timestamp` + the device's own `device_id` (generated once per install, stored in IndexedDB)

**Sync protocol**

- **Transport: polling, not WebSockets.** Persistent connections on Cloudflare Workers require Durable Objects (paid-tier, one instance per user to hold state/fan-out), disproportionate infrastructure for a personal app that already treats "eventual sync on reconnect" as sufficient (see Non-Goals). A stateless `POST /sync` call fits the free-tier Workers model used everywhere else in this spec.
- Sync is triggered at natural moments rather than a fixed background loop: on app open/foreground (`visibilitychange`), on reconnect (`navigator.onLine` transition or a retried request succeeding), and a light interval (e.g. every 2–5 min) while the app is open and online so a second open device picks up changes without a manual refresh
- On each trigger, the client calls `POST /sync` with its unsynced local events and its last known `server_seq` cursor
- Server appends new events (deduped by UUID — safe to retry), assigns each a `server_seq`, applies them to the materialized `user_media_status` / `user_episode_progress` tables
- Server responds with all events with `server_seq` greater than the client's cursor, plus the new cursor
- Client applies those into its local IndexedDB store and updates its materialized view, then advances its cursor

**Background sync without opening the app**

- On Android/Chrome: the service worker registers a **Background Sync** request whenever an event is queued while offline; the browser fires the sync event as soon as connectivity returns, even if the app isn't open, triggering the same `/sync` call
- On iOS Safari: the Background Sync API isn't implemented at all (WebKit has no background execution model beyond Push) — sync-on-foreground plus piggybacking a `/sync` call onto the daily push event handler (§10) covers the common cases there instead

**Conflict resolution**

- `episode_watched` / `episode_unwatched` and `media_status_changed`: latest `client_timestamp` wins for the final state, but the event history itself is never lost — "who marked it and when" is fully reconstructable if needed
- `favorite_toggled`: same last-write-wins rule
- Writes are idempotent (same UUID = same event, safe to resend), so retries after a dropped connection never risk double-applying an action

**Upcoming episodes cache (works offline, no TMDB call needed)**

- When a show is tracked, its known upcoming episodes (with `air_date`) are cached locally, not just server-side
- The app checks cached air dates against the current device clock — no network required — and surfaces a "New episode aired, mark as watched?" prompt the moment an episode's air date has passed
- Refreshed from the server (and TMDB, if stale) whenever the device has a connection

**Offline image caching (scoped, not full-catalogue)**

- Only images for items on the user's own lists are cached — poster only, via the Service Worker's Cache Storage API (cache-first, background-refreshed)
- Backdrops, cast photos, and trailer thumbnails are **not** cached for offline use — while offline these render as a simple placeholder, loading normally once connectivity returns
- `navigator.storage.persist()` on first successful cache so the browser doesn't silently evict it under storage pressure; prune poster images for items removed from all lists or dropped for >90 days

---

## 8. TMDB Sync Strategy

- **Search:** Hit TMDB search endpoint live, no caching (cheap, low value to cache, needs freshness)
- **Hydrate on select:** When a user adds a movie/show to a list for the first time, pull full details + credits + images + videos in one pass, store in `media`/`seasons`/`episodes`/`credits`/`videos`
- **Staleness rules:**
  - Movies: re-sync only if explicitly requested (movies rarely change)
  - Finished shows (`in_production = false`): re-sync if `last_synced_at` > 30 days
  - Airing shows (`in_production = true`): re-sync if `last_synced_at` > 1 day, plus nightly Cron sweep of all airing shows in the DB
- **Never block reads on sync:** always serve from D1 first; trigger a background re-sync if stale rather than making the user wait
- **Locale:** All TMDB calls request English (`en-US`) explicitly — no per-user locale support, keeps `media` single-locale with no cache-key complexity

---

## 9. Custom (Provider-Unlinked) Media Entries

**Goal:** let the user add a niche movie/show that isn't on TMDB (or hasn't been found yet) using just basic identifying text — title, a flexible year, type, optional description, optional season/episode structure — and later link it to real provider data once a match turns up, without losing any tracking history.

**Why the id decoupling matters here:** because `media.id` is an internal id rather than a provider's id, a custom entry can be created, tracked, and have episodes marked watched entirely offline, and later be "linked" to TMDB data by filling in `media_external_ids` and re-hydrating the row in place — `user_media_status` and `user_episode_progress` never need their foreign keys touched, since they point at the stable internal `media.id`, not at TMDB's id.

**Flexible year input**
People often don't remember an exact release year for obscure titles, so year is captured with a precision, not just a number:

| User types  | `year_precision` | `year_start` / `year_end` | `year_anchor` | Displayed as |
| ----------- | ---------------- | ------------------------- | ------------- | ------------ |
| `1984`      | `exact`          | 1984 / 1984               | —             | "1984"       |
| `~1984`     | `approx`         | 1982 / 1986 (±2, default) | 1984          | "~1984"      |
| `1980s`     | `decade`         | 1980 / 1989               | —             | "1980s"      |
| `1900s`     | `century`        | 1900 / 1999               | —             | "1900s"      |
| `1978-1986` | `range`          | 1978 / 1986               | —             | "1978–1986"  |

Detection is simple pattern-matching on input (a bare 4-digit number, a `~`-prefixed number, a number ending in `0s` or `00s`, or an explicit `start-end` range) — no free-text parsing beyond these few shapes. `year_start`/`year_end` are what background matching and any future filtering actually query against; `year_anchor` exists purely so `approx` entries can redisplay the number the person actually typed rather than a range.

**Creation (offline-safe)**

- A `custom_media_created` event (see §7) carries: client-generated `media_id`, `type`, `title`, the year fields above, `overview` (optional), and an optional season/episode structure (as sparse as "just a title" or as detailed as full seasons/episodes with names)
- No image is captured or expected for custom entries — `poster_path` stays null and the UI falls back to the same placeholder treatment already used for offline/uncached images (§7)
- This event replays through the same offline queue → `/sync` → server projection pipeline as any other tracking event, so a custom add works with zero connectivity and syncs whenever the device next has one

**Entry point: Search, not Discover**

- Custom-add lives in the unified Search flow (§11), as a "can't find it? add it manually" option that appears in the no-results state — one required field (title), everything else optional. Reference: `data-spec-ref="custom-entry-manual-link-button"` in the mockup for the linked variant of this flow, and the Search screen's own custom-add prompt for creation.
- Because search spans the crowdsourced catalogue (§11) for _linked_ titles, typing a name first surfaces any already-verified match before offering to create a custom entry. Custom entries themselves are never cross-user: an entry stays visible only to its creator, and duplicate custom entries for the same obscure title across different users are possible and accepted, as a trade-off against exposing unverified content to other users.

**Background matching (online only, since it needs to call TMDB)**

- Periodically (piggybacked on the same background/opportunistic sync moments described in §7, and on the daily Cron sweep), the server searches TMDB by title + the entry's `year_start`–`year_end` range for any custom entry without a `media_external_ids` row
- A found candidate is stored in `match_suggestions`, not auto-applied — the user reviews and confirms before anything changes, since a title/year search can produce false positives
- Dismissing a suggestion sets `dismissed_at` so the same bad match isn't repeatedly surfaced; the entry stays custom and eligible for future match attempts if new TMDB data ever appears

**Linking (merge) flow**

- On confirmation, `POST /media/:id/link` (online only): fetches full details/credits/images/videos for the chosen provider match, updates the existing `media` row in place (title, overview, poster, precise `release_date`, etc.), inserts the `media_external_ids` row, sets `source = linked`
- Seasons/episodes: custom entries with manually-entered episodes are reconciled against the provider's episode list using `(season_number, episode_number)` as the natural key (§5) — matching episodes get their metadata upgraded, `user_episode_progress` rows are preserved via the stable `episode.id`; any custom episodes with no provider counterpart are left as-is
- If the user later un-links, the row can be reset to `source = custom` and the `media_external_ids` row removed — no separate "undo" data model needed since nothing about tracking history depends on the link

---

## 10. Push Notifications

**Goal:** alert you when a tracked show's next episode airs, or a tracked movie releases — without needing the app open.

**Subscription flow**

- Permission request happens from inside the installed PWA (not on first page load) — e.g. prompted the first time a user marks a show as "watching"
- On grant, the browser creates a Push subscription (endpoint + keys); client sends it to the server and stores it in `push_subscriptions`, keyed by user + device
- A user can have multiple subscriptions (phone, laptop); notifications go to all active ones

**Subscription management** — reference: `data-spec-ref="settings-notifications-section"` in the mockup

- Settings page lists every active `push_subscriptions` row for the account (`device_label`, when it was created, when it was last used)
- Each entry has a one-tap "unsubscribe" — calls the browser's `PushSubscription.unsubscribe()` on the originating device if it's the current one, or simply deletes the server-side row (`DELETE /push/subscriptions/:id`) to stop sending to a device that isn't at hand

**Sending flow**

- Daily Cron Trigger queries: episodes with `air_date = today` belonging to shows any user is tracking (`want_to_watch` or `watching`), plus movies with `release_date = today` in any user's list
- For each match, send a Web Push message (VAPID-signed) to that user's active subscriptions
- Tapping the notification deep-links into the relevant show/episode or movie detail page
- Delivery is fire-and-forget; if a subscription has expired/unsubscribed, the push service returns an error and that row is pruned

**Platform notes**

- iOS Safari only supports Web Push for PWAs installed via "Add to Home Screen," and only from iOS 16.4+
- Desktop/Android Chrome, Firefox support standard Web Push with no special install requirement
- Sending VAPID-signed push from a Cloudflare Worker needs a Web Crypto–based implementation rather than the Node-only `web-push` npm package

---

## 11. Unified, Crowdsourced Search

- **One search box, both types:** a single search covers movies and shows together — no separate "search movies" vs. "search shows" UI. Reference: `data-spec-ref="list-type-genre-year-filters"` in the mockup for the analogous filter row on list views.
- Primary: TMDB search API, ~2–3s timeout
- On TMDB failure/timeout: fall back to `LIKE`-based search against the local `media` table
- **Crowdsourced fallback, scoped to verified data:** the fallback query is `WHERE source = 'linked'` — only titles matched against TMDB are shared across users. `media` has no `user_id`; linked entries are safe to share globally because their content is sourced from TMDB, not from a person.
- **The user's own custom entries are always part of their results, in every network condition** — merged alongside whichever external source is currently active (live TMDB, the shared linked-only fallback, or nothing). Network status changes what backs the _external_ portion of results; it never hides what the user already added themselves. Reference: `data-spec-ref="search-degraded-offline-banner"` in the mockup.
- **TMDB down vs. fully offline are different cases, with different banners:**
  - TMDB unreachable (device still online): fallback searches the shared `linked` catalogue + the user's own custom entries. Banner: "TMDB is unreachable — showing results from the shared library only."
  - Device itself offline: the shared/crowdsourced index isn't reachable either, so search drops to whatever's in the local IndexedDB cache — the user's own tracked items only, `linked` and `custom` alike. Banner: "You're offline — showing your own list only."
- No-results state offers the custom-add path described in §9, rather than a dead end, in every network condition above — custom-add is itself offline-safe (§7)

---

## 12. Discover & Browse _(deferred — see "Deferred / Post-v1" at the end of §16)_

- TMDB's "trending" (day/week) and "popular" endpoints would power a browse view, separate from the search-by-name flow in §11
- **Descoped from v1.** The no-results custom-add path in §11 already covers the original motivation (a fast way to add something not yet found), so Discover isn't load-bearing for anything else in the spec.

---

## 13. Upcoming Releases (Timeline)

- A single merged, scrollable timeline — episodes and movies together, sorted by date — in the style of Google Calendar's agenda/list view, not a month-grid calendar
- Built entirely from data already being cached (`episodes.air_date`, `media.release_date`) — no new TMDB calls beyond what §8 already does
- A read view on top of existing data, not a new sync/caching concern

---

## 14. Data Portability

**One-time TV Time import**

- TV Time supports exporting watch history (check current export format at time of building, as it may change)
- An import script parses the export, resolves each title against TMDB (by name/year, falling back to manual review for ambiguous matches), and creates the corresponding `media`/`user_media_status`/`user_episode_progress` rows (or synthesizes equivalent `events`, to stay consistent with the event-sourced model in §7)
- Run once, offline/manually (a CLI script or an admin-only endpoint), not part of the regular app UI

**Ongoing self-service export**

- An authenticated endpoint (e.g. `GET /account/export`) returns the user's own data as JSON: all list statuses, episode progress, favorites
- A lightweight insurance policy (get your data out any time) rather than a full backup/restore system — restoring from an export is not a v1 requirement

---

## 15. Jellyfin Integration _(deferred — exploratory, not scoped for v1)_

Two directions, both just an API surface — **this app does no media acquisition itself**:

- **Jellyfin → app:** a Jellyfin plugin (running on the user's own media server) calls a small authenticated endpoint whenever the user finishes playback of something in Jellyfin, marking the corresponding item watched here automatically.
- **App → Jellyfin:** the plugin polls a read-only endpoint listing what's on the user's Want to Watch list, so the operator's own downstream tooling can act on it.

**What this would need, if pursued:**

- A separate auth mechanism from user sessions — API keys/service tokens (hashed at rest like `login_tokens`), scoped per integration, generated and revocable from Settings, since a self-hosted plugin can't do the passwordless email flow
- Matching Jellyfin's library items to this app's `media` rows — likely by external ID (TMDB id, where Jellyfin already has a match) falling back to title+year matching similar to the TV Time import (§14)
- `POST /integrations/jellyfin/watched` — marks an item/episode watched, authenticated by API key rather than session cookie
- `GET /integrations/jellyfin/want-to-watch` — read-only list of tracked-but-unacquired items, for the plugin to poll

**Explicitly out of scope:** how media is found, sourced, or acquired. That's the plugin's own concern, running on infrastructure the user already controls — this app's role, if built, is limited to exposing watch-status and list data through a well-scoped API.

---

## 16. Epics (→ GitHub Issues)

### Epic A — Project Setup

1. Scaffold SvelteKit project with `adapter-cloudflare`, Wrangler config, D1 binding
2. `src/lib/server/db`: Drizzle schema against `drizzle-orm/d1`
3. `src/lib/server/email`: `EmailSender` interface with `ResendSender` (prod) and `SmtpSender` (dev) implementations
4. `docker-compose.yml`: Mailpit service for local dev
5. `.dev.vars.example` template + document `.dev.vars` (git-ignored) and `wrangler secret put` for production secrets (TMDB API key, Resend API key, VAPID keys)
6. Set up PWA manifest + service worker, verify "Add to Home Screen" install on iOS + Android
7. CI: lint/typecheck/build pipeline (GitHub Actions)

### Epic B — UI Foundation

8. Install & configure Tailwind CSS v4 + Bits UI + shadcn-svelte CLI
9. Establish `src/lib/components` structure; build core reusable primitives (button, input, dialog, dropdown, card, list item, empty/loading/error states) used across every other epic
10. Dark/light mode: Settings control with Auto (default) / Light / Dark, stored as a client-side-only preference — reference: `data-spec-ref="settings-appearance-section"`
11. Custom design token pass: deliberate palette + type scale rather than shipping shadcn-svelte's default theme unchanged

### Epic C — Auth

12. Set up Resend account + API integration for transactional email
13. Request-link endpoint: generate token, store hashed, send email (link + code), with rate limiting
14. Verify endpoint: validate token/code, create user on first login, issue session, insert `sessions` row, set `httpOnly` cookie
15. `hooks.server.ts`: validate session cookie against `sessions` on every request, update `last_used_at`
16. Basic account settings page (change email, delete account)

### Epic D — TMDB Integration Layer

17. TMDB API client wrapper (typed, single place for API key + base URL)
18. Search endpoint (live TMDB call, no cache)
19. Hydrate-on-select: fetch + persist media/seasons/episodes/credits/videos for a given TMDB id, writing the link into `media_external_ids` rather than a bare column
20. Staleness check + background re-sync logic
21. Cron Trigger: nightly re-sync of all `in_production = true` shows in DB

### Epic E — Offline & Sync

_(sequenced before Media & Tracking / Lists & Dashboard — those features write through this event pipeline from the start rather than as direct writes retrofitted later)_ 22. IndexedDB schema: local `events` store, materialized state store, upcoming-episodes cache, `device_id` generation 23. Event-writing layer: every tracking action (status change, favorite, episode watched) writes local event + updates local materialized state optimistically 24. `POST /sync` endpoint: accept client events (dedup by UUID), apply to server materialized tables, return events since client cursor 25. Client sync engine: trigger on app open/foreground, reconnect, and light polling interval while open — push unsynced events, pull + apply remote events, advance cursor, retry/backoff on failure 26. Background sync trigger: Background Sync API registration (Android/Chrome); on iOS, sync-on-foreground plus piggybacking a `/sync` call onto the daily push event handler 27. Offline "new episode aired" detection against cached air dates + mark-watched prompt 28. Offline poster caching via Service Worker Cache Storage (cache-first, scoped to tracked-list items only), placeholder rendering for backdrops/cast/trailers when offline, `navigator.storage.persist()` + cache pruning

### Epic F — Media & Tracking

29. Media detail page: overview, cast, images, trailer embed, TMDB rating
30. Show detail page: season/episode grid with per-episode watched toggle
31. "Mark season as watched" bulk action
32. Add/update `user_media_status` (want_to_watch / watching / completed / dropped) — writes through the event pipeline from Epic E
33. Favorite toggle (independent of status)
34. Collapse overview/cast/trailer behind a "Details" toggle, collapsed by default only when a show's status is `watching` — reference: `data-spec-ref="detail-collapsible-details-toggle"`. Movies and non-in-progress shows stay expanded.
35. One-tap "mark next episode watched" row on the show detail page, always visible regardless of the Details collapse state — reference: `data-spec-ref="detail-quick-mark-next-episode"`
36. Quick-mark control on the Continue Watching card (home screen): the progress ring doubles as the tap target, checkmark centered inside it — reference: `data-spec-ref="continue-watching-quickmark"`
37. Completion sequence when the last episode of an in-progress show is marked watched: brief "Completed!" state on the card (~0.9s), then the card fades/collapses out of Continue Watching (~0.5s), _then_ the show's status flips to `completed`

### Epic G — Lists & Dashboard

38. "My Lists" views: Want to Watch, Watching, Completed, Favorites — reference: `data-spec-ref="list-tabs"`
39. Dashboard: "next episode to watch" per in-progress show — reference: `data-spec-ref="continue-watching-section"`
40. Sorting/filtering within lists (title, date added, release date, type — movie/show, genre) — reference: `data-spec-ref="list-type-genre-year-filters"`

### Epic H — Notifications

41. Service worker: push event handler + notification display + click-to-deep-link
42. Permission request UI, triggered contextually (e.g. on first "watching" add), storing subscription via a `POST /push/subscribe` endpoint
43. VAPID key generation + Workers-compatible signing implementation
44. Daily Cron Trigger: query today's airing episodes + releasing movies across tracked lists, send push to matching subscriptions
45. Prune invalid/expired subscriptions on send failure
46. Subscription management settings page: list active subscriptions (`device_label`, created/last-used), one-tap unsubscribe — reference: `data-spec-ref="settings-notifications-section"`
47. `DELETE /push/subscriptions/:id` endpoint

### Epic I — Polish

48. Empty states, loading states, error states (including TMDB-down banner and offline/sync-pending indicators)
49. Responsive/mobile-first styling pass (this is a phone-first PWA)
50. Basic offline handling for uncached data (friendly "you're offline, this hasn't been downloaded yet" state)

### Epic J — Timeline View

51. Upcoming releases timeline page: merge tracked shows' upcoming episodes + tracked movies' release dates into a single agenda-style list, sorted by date

### Epic K — Data Portability

52. TV Time export parser + TMDB title-matching (with manual-review path for ambiguous matches)
53. Import script: create `media`/`user_media_status`/`user_episode_progress` rows (or synthesized `events`) from parsed import
54. `GET /account/export` endpoint: dump user's own tracking data as JSON

### Epic L — Custom Media & Linking

55. `media_external_ids` + `match_suggestions` tables; migrate `media` to internal-id/`source` model, including `year_start`/`year_end`/`year_precision`/`year_anchor` fields
56. Year-input parsing: detect exact/approx/decade/century/range patterns from free-text input, compute `year_start`/`year_end`/`year_anchor`
57. Custom entry creation form (title required, flexible year input, type/description/seasons/episodes optional) → `custom_media_created` event, offline-safe via existing event queue
58. Wire custom-add into Search's no-results state (§11)
59. Background match-check: search TMDB by title + `year_start`–`year_end` range for unlinked custom entries, write results to `match_suggestions` (piggybacked on daily Cron + opportunistic sync moments, never silently auto-applied)
60. Match review UI: accept/dismiss suggested match
61. `POST /media/:id/link`: hydrate provider data into existing row, reconcile seasons/episodes by natural key, preserve tracking FKs
62. Un-link path: reset a mistakenly-linked entry back to `source = custom`
63. Ensure search always merges the user's own custom entries into results regardless of network mode (§11) — reference: `data-spec-ref="search-degraded-offline-banner"`

---

### Deferred / Post-v1 (not scoped for initial issue creation)

**Discover & Browse** — descoped per §12; the no-results custom-add path in §11 already covers the original motivation

- Discover page: "Trending this week" + "Popular" rows via TMDB, short-lived cache (not fully hydrated until added)
- Wire Discover selection into the existing hydrate-on-select path

**Jellyfin Integration** — see §15 for the full shape

- API-key auth mechanism, separate from user sessions
- `POST /integrations/jellyfin/watched` and `GET /integrations/jellyfin/want-to-watch` endpoints
- Jellyfin-library-to-`media` matching (external ID first, title+year fallback)

---

## 17. Open Questions

- Do we want a "drop reason" or just a bare `dropped` status?
- Should favorites be filterable independently across all statuses, or only within "completed"?
- Any interest in letting TMDB's `raw_json` snapshot go stale intentionally to save D1 storage, vs. keeping it forever?
- Do we ever want to expose the raw event history to the user (e.g. "watch history timeline"), or is it purely an internal sync mechanism?
- Should notifications be a single daily digest ("3 new episodes today") vs. one push per item, once a user tracks a lot of shows?
- What TV Time export format is actually available at build time (CSV vs. JSON, what fields), since the import script depends on it
- Should high-confidence match suggestions (e.g. exact title + year match) ever auto-link without review, or should every link always require explicit confirmation?
- Beyond TMDB, is there a second provider actually worth wiring up later, or is `media_external_ids` just future-proofing with no near-term second provider planned?
- Excluding custom entries from crowdsourced search stops them being _found_ by other users, but doesn't by itself stop someone from guessing/enumerating another user's custom `media.id` directly — worth deciding whether custom-entry detail views need an explicit ownership check as a follow-up hardening step
- **Circuit breaker for TMDB requests:** currently spec'd as a flat per-request timeout (§8, §11) that falls back independently on every call. A real circuit breaker (trip to "open" after N consecutive failures, skip TMDB entirely for a cooldown window rather than paying a fresh timeout on every request during an outage) would behave better under a real outage, but it's added complexity for a personal-scale app where TMDB outages are rare and short. Worth revisiting once real usage patterns are known.
- **Jellyfin integration auth scoping:** if §15 gets built, how granular should API-key permissions be (read-only vs. write, single integration vs. multiple), and should keys be able to expire/rotate automatically?
