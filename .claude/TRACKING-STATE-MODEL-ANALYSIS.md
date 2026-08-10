# Tracked-title state model vs. the current implementation

Analysis basis: worktree at `origin/main` = `522ba9f`. All file:line refs are against that commit.
Live evidence pulled read-only from the `marquee-preview` D1 (the DB with the real personal library).

---

## 0. Executive summary

Bug 4 is real, currently reproducible with unmodified `main`, and **there is a row sitting in the bug
state in preview D1 right now**: *The Outsider*, `in_production = 0`, 10/10 aired episodes watched,
`tracking.status = 'want_to_watch'`. Its complete event log is 1 × `tracking.added` +
10 × `episode.watched` and **zero** `tracking.status_changed` — the reconciler ran and silently
declined to decide, because at that moment the client held no per-episode metadata.

Root cause, confirmed not assumed: `reconcileStatus()` derives status from the **episode list**
(`src/lib/tracking/reconcile.ts:26-27`), while `episodesToMark()` seeds watches from the **season
summaries** (`src/lib/tracking/actions.ts:189-192`). Those are two different data sources with two
different arrival times. The readiness gate (`hasSufficientEpisodeData`) deliberately opens on the
season-summary source (that's MRQ-130's whole point — mark-watched must work the instant a title is
added), but the reconciler cannot read that source, so it hits `if (total === 0) return;` and writes
nothing. Nothing ever re-runs it when the episode list arrives.

That is not a missing branch. It is the structural consequence of caching a derivation whose inputs
are asynchronous and partial. All four bugs are instances of one thing: **`tracking.status` is a
cached derivation that the code treats as a stored fact.**

---

## 1. The authoritative state model

### 1.1 Inputs, and where they come from

Two independent input planes, with different arrival guarantees:

| Plane | Source | Fields | Availability |
|---|---|---|---|
| **Event-derived** (authoritative, in the log) | `events` → `tracking` / `episode_watches` | `status`, `favorite`, `rating`, `removed`, per-`(season,episode)` `watched` | Always. Offline-complete. Converges by per-field LWW on `clientCreatedAt`. |
| **Metadata** (reference data, *not* in the log) | media channel `POST /api/media/sync` | season summaries (`seasonNumber`, `episodeCount`, `airDate`), per-episode `airDate`, `inProduction`, TMDB `status` string, `lastAirDate` | **Eventually.** May be absent, partial, or stale for hours. Server hydration is TTL-gated (12h for in-production shows; finished shows and movies never re-pull outside the nightly cron). |
| **Clock** | `todayIso()` (`actions.ts:112-114`) | `today` | Always, but *moves*: a state can change with no event and no metadata change. |

The critical property the current code does not model: **metadata has a confidence level**, and it is
not binary.

```
MetadataConfidence =
  | 'absent'    // no season summaries and no episodes locally
  | 'summary'   // season summaries known (episodeCount + season airDate), no per-episode air dates
  | 'partial'   // some seasons fully dated, others not
  | 'complete'  // every non-Specials season has episodeCount-many dated episode rows
```

### 1.2 Movies

Movies have no derived component at all. The state *is* the user's intent:

| State | Condition | Metadata required |
|---|---|---|
| `Untracked` | no `tracking` row, or `removed = true` | none |
| `WantToWatch` | `status = want_to_watch` | none |
| `Watching` | `status = watching` | none — **but this state should be unreachable for movies** (see §5 flags) |
| `Completed` | `status = completed` | none |
| `DidNotFinish` | `status = did_not_finish` | none |

Metadata absence/staleness must change nothing for a movie. `releaseDate` is used only for the
upcoming-timeline filter and the release-status facet, never for status. **The movie half of the
model is correct in the current code and has never been a source of bugs.** Everything below is about
series.

### 1.3 Series — the model

A series' user-facing state is a **pair**, and the current code collapses it into one field:

```
SeriesState = (Intent, Progress)

Intent   := want_to_watch | watching | completed | did_not_finish   // what the user asserted
Progress := f(watchedSet, episodeMetadata, today)                    // what the log + metadata imply
```

`Progress` is only defined when confidence is `complete`. Otherwise it is `Unknown`, and **`Unknown`
must not be collapsed to any concrete value** — that collapse is bug 4.

```
Progress =
  | Unknown                 // metadata confidence < 'complete'
  | NothingAired            // aired(non-specials) == 0
  | None                    // aired > 0, watched(aired) == 0
  | InProgress              // 0 < watched(aired) < aired
  | CaughtUpAiring          // watched(aired) == aired > 0  AND  moreEpisodesComing
  | CaughtUpFinished        // watched(aired) == aired > 0  AND !moreEpisodesComing

moreEpisodesComing := inProduction === true
                   || any non-specials episode with airDate === null or airDate > today
```

Derived display state (what every surface should render from):

| (Intent, Progress) | Derived state | Notes |
|---|---|---|
| any, `did_not_finish` intent | **Abandoned** | Sticky. Progress never overrides an explicit abandon. |
| `want_to_watch`, `None`/`NothingAired` | **On list** | |
| any, `InProgress` | **Watching** | Progress wins over a `want_to_watch` intent. |
| any, `CaughtUpAiring` | **Up to date** | *This state has no representation anywhere in the code today.* |
| any, `CaughtUpFinished` | **Watched** | |
| `completed` intent, `Unknown` | **Watched** | Trust intent when there is nothing to contradict it. |
| `want_to_watch`/`watching` intent, `Unknown` | **that intent, verbatim** | Suspend derivation; render intent; do **not** persist a decision. |

The last two rows are the entire fix. When confidence < `complete`, the correct behaviour is
"render the user's intent and decide nothing", **not** "compute a derivation from zeroes and cache it".

### 1.4 Behaviour under absent / partial / stale metadata — the rule

| Metadata condition | Correct behaviour |
|---|---|
| **Absent** (no seasons, no episodes) | Show intent. `Progress = Unknown`. Bulk-mark **must be disabled** (nothing to enumerate). No status write. |
| **Summary only** (season summaries, no episode dates) | Bulk-mark **may be enabled iff the show is known finished** (`inProduction === false`) — an aired season of a finished show has `episodeCount` aired episodes by definition. `Progress` stays `Unknown` (you cannot count aired episodes without dates). No status write. **This exact combination is the bug-4 window.** |
| **Partial** (some seasons dated) | Bulk-mark disabled for the undated seasons. `Progress = Unknown` for the series; a per-season progress may still be `complete`. |
| **Stale** (metadata older than reality: show ended, or a season was added) | `Progress` is computed from what is held; it is *provisional*. It must be recomputed the moment fresher metadata lands. **Never bake a stale-metadata derivation into the event log** — the log has no expiry and a wrong event outlives the stale read forever. |
| **`inProduction` unknown (`null`)** | Treat as `moreEpisodesComing = true` (conservative). Do **not** treat `null` as `false`. |

---

## 2. Series intermediate states, enumerated

Every row assumes `type = show`, tracked, not removed. "Should be" = derived display state per §1.3.

| # | Situation | Progress | Should be | UI should offer |
|---|---|---|---|---|
| 1 | Nothing watched, episodes known | `None` | **On list** | "Mark series watched"; per-episode checkboxes; next-episode row hidden. |
| 2 | Partially watched mid-season | `InProgress` | **Watching** | Next-episode quick-mark; "Mark season watched" for the current season; "Mark series watched"; appears in Continue Watching. |
| 3 | Caught up on everything aired, show still in production | `CaughtUpAiring` | **Up to date** | A distinct "Up to date — waiting on new episodes" affordance, *not* "Watched". Must **not** appear in Continue Watching (nothing to continue) but **must** stay in the Watching tab / notification scope. Upcoming timeline shows the next air date. |
| 4 | Caught up, show has ended | `CaughtUpFinished` | **Watched** | Button reads "Watched"; clicking steps back to On-list. Rating enabled. |
| 5 | All episodes watched **including Specials** | same as 4 (specials excluded from the computation) | **Watched** | Nothing extra. Specials must never *block* completion, and must never be *required*. Currently correct-by-exclusion, but there is no state that distinguishes "completionist" — acceptable, should be an explicit decision not an accident. |
| 6 | Watched everything aired, but **episode data incomplete locally** | `Unknown` | **the user's intent, unchanged** | Bulk-mark disabled with a "loading episodes" affordance (already exists). Status must **not** be written. When metadata lands, the state must **re-derive automatically** — no user action required. **This is bug 4 and the code fails it.** |
| 7 | A season is added after the user marked complete | `CaughtUpAiring` (new unaired eps) or `InProgress` (new aired eps) | **Up to date** / **Watching** respectively | Re-derive silently on metadata arrival; surface the new season. Must be automatic — the user has no reason to revisit the page. |
| 8 | An episode is removed upstream after being marked watched | orphan watch row ignored; recompute over the surviving list | whatever the surviving list implies (usually **Watched**) | Nothing. Self-correcting. Orphan `episode_watches` rows should be tolerated forever (never deleted — they are log-derived and a re-add upstream must restore them). |
| 9 | Show ends production while user is at `CaughtUpAiring` | `CaughtUpAiring` → `CaughtUpFinished` | **Watched** | Automatic transition on metadata refresh. **No event, no user action, no clock tick is involved** — only a metadata version bump. The current architecture has no trigger for this at all. |
| 10 | Tracked show with nothing aired yet (announced series) | `NothingAired` | **On list** | No mark-watched; upcoming timeline entry. |
| 11 | Explicit "didn't finish" with 100% watched | ignored | **Abandoned** | Sticky; only an explicit user action leaves it. Correct today (`actions.ts:288`). |

---

## 3. Current implementation, mapped against the model

### 3.1 The predicates (`src/lib/tracking/actions.ts`)

| Function | Lines | Verdict |
|---|---|---|
| `isAired` | 120-122 | ✅ Correct. `airDate !== null && airDate <= today`. Matches the model's null-is-unaired rule. |
| `mainEpisodes` / `airedEpisodes` | 125-134 | ✅ Correct. Specials excluded, sorted. |
| `nextEpisode` | 140-150 | ✅ Correct **given a complete episode list**. ⚠️ Returns `null` for an *empty* list, which callers read as "caught up" — see 3.3. |
| `isSeasonFullyWatched` / `isSeriesFullyWatched` | 199-219 | ✅ Correct. Both return `false` when nothing has aired, which is the right conservative answer. |
| `isStillAiring` | 258-267 | ⚠️ `if (inProduction) return true;` — `null` is falsy, so **unknown production status reads as "finished"**. Model §1.4 says unknown must be conservative. Combined with an empty episode list this returns `false`, i.e. "this show will never gain another episode", from *zero* evidence. |
| `episodesToMark` | 173-196 | ⚠️ Two-source enumeration. Dated branch (185-188) is correct. Count-fallback branch (189-192) gates on `!inProduction`, so **`null` takes the finished-show fallback** — the doc at 168-169 says `inProduction === false`. Same `null` divergence as MRQ-194, in the *write* path (MRQ-194 only claims the read path). |
| `hasSufficientEpisodeData` | 231-252 | ⚠️ **MRQ-194 confirmed.** Line 248 `if (inProduction !== true) continue;` treats `null` as resolvable; the doc at 226-228 explicitly says "Still in production (`true`, **or unknown**) … can't be enumerated". More importantly: this function answers *"can I enumerate the aired set for a bulk write?"*, and the code then reuses that answer as if it also meant *"is the aired set countable for a status derivation?"* — **it doesn't**, and that conflation is bug 4. |
| `reconciledStatus` | 282-294 | ✅ Pure, correct, well-tested — **for the inputs it is given**. `did_not_finish` sticky (288); `airedEpisodeCount === 0` → `null` (288); caught-up + finished → `completed` (290); caught-up + airing → collapses to `watching` (291-292), which is where the model's `CaughtUpAiring` state is destroyed. |

**Model states with no representation in this file:** `CaughtUpAiring` (collapsed into `watching` at
line 290-292) and `Unknown` (there is no third return value — `null` means both "no change needed"
and "cannot decide", and callers cannot tell them apart).

### 3.2 The reconciler (`src/lib/tracking/reconcile.ts`)

```ts
26  const total = airedEpisodes(episodes, today).length;
27  if (total === 0) return;                      // ← the bug-4 bail
28  const stillAiring = isStillAiring(episodes, inProduction, today);
...
38  const next = reconciledStatus(row.status, watchedCount, total, stillAiring);
39  if (next) await recordEvent('tracking.status_changed', mediaId, { status: next });
```

- Line 26-27: **`total` comes exclusively from `episodes`** — the per-episode metadata. It never
  consults the season summaries that the write path just used to seed 10 watch events. When
  `episodes` is empty this returns with no write, no error, no retry marker, and no signal to the
  caller. `Unknown` is silently rendered as "no action".
- Line 32-37: `watchedCount` filters watch rows through `airDateOf(episodes, …)`. With `episodes`
  empty every watch row resolves to `airDate: null` → un-aired → not counted. So even without the
  line-27 bail this would compute `0 / 0`.
- Line 39: **this mints a `tracking.status_changed` event that no user performed.** It is
  indistinguishable in the log from real user intent. This directly violates the stated invariant in
  AGENTS.md ("Events = user actions only") and is the reason the log cannot be used to recover
  intent later.
- ⚠️ There is **no `reconcile.test.ts`** in the repo. The only coverage of this composition is
  `actions.test.ts:472-480`, which hand-feeds `airedEpisodeCount = 6`:
  ```ts
  const seeded = episodesToMark(finished, [], false, TODAY);   // 6 coords from season summaries
  expect(reconciledStatus('watching', seeded.length, 6, false)).toBe('completed');
  //                                                    ^ hardcoded; production computes 0 here
  ```
  The test asserts exactly the scenario that fails in production, and passes, because it supplies by
  hand the number the real code cannot obtain. That is why bug 4 shipped green.

### 3.3 `TrackingState` (`src/lib/tracking/tracking.svelte.ts`)

| Member | Lines | Verdict |
|---|---|---|
| `#inProduction` | 42-43, 74 | ❌ **MRQ-193 confirmed.** `readonly`, captured once in the constructor. `#seasons` got `updateSeasons()` (79-81) for exactly this staleness pattern; `#inProduction` did not. |
| `episodes` | 45, 88-92 | ✅ Reactive, reloaded by `load()` on every `sync.revision` bump. **This is the key asymmetry**: the input that arrives late *is* reactive; the derivation that consumes it is not re-run. |
| `load()` | 84-101 | ⚠️ Reloads all inputs and **never reconciles**. This is the exact hook where bug 4 would self-heal, and it is the one place reconciliation is absent. |
| `setEpisodeWatched` | 210-219 | ✅ Reconciles (217) — but only on a user write. |
| `markSeasonWatched` | 222-228 | ⚠️ Seeds from `#markable()` (season summaries) then reconciles from `this.episodes`. Same two-source split. **This is the code path that produced *The Outsider*.** |
| `markSeriesWatched` | 247-253 | ⚠️ Identical shape post-#157. Reproduces bug 4 exactly. |
| `readyToMarkSeries` / `readyToMarkSeason` | 231-239, 260-262 | ⚠️ Correctly gate the *write*, and are misread as gating the *derivation*. They can return `true` while `this.episodes` is empty — that is not a bug in them, it is the missing distinction. |
| `#markable` | 265-273 | ⚠️ See `episodesToMark`. |
| `#reconcileStatus` | 290-292 | ⚠️ Passes `this.episodes` — empty in the bug window. Confirms the name asked about: it is `#reconcileStatus()`, delegating to the exported `reconcileStatus()` in `reconcile.ts`. |

### 3.4 Construction / reactivity (`src/routes/title/[type]/[id]/title-detail.svelte`)

```
101-104  const tracking = $derived.by(() => { const id = mediaId;
             return untrack(() => new TrackingState(id, mediaRecord, detail.seasons)); });
105-108  $effect(() => { void sync.revision; tracking.load(); });
111-113  $effect(() => { tracking.updateSeasons(detail.seasons); });
```

- 101-104: instance identity is keyed on `mediaId` only; the base→enriched `detail` upgrade does not
  rebuild it (deliberate — a rebuild would reset `view`/`ready`/`watched` and reflow the action row).
- 111-113: `#seasons` is re-pushed on every `detail` change. ✅
- **There is no equivalent line for `inProduction`.** ❌ MRQ-193.
- 105-108: `load()` fires on every sync revision, so `episodes` refreshes. But `load()` does not
  reconcile, so **the one effect that observes late-arriving metadata does nothing with it.**

### 3.5 UI derivation (`src/lib/components/media/tracking-controls.svelte`)

```
40-47  done        = tracked && (show ? status==='completed' && (episodes.length===0 || isSeriesFullyWatched(...)) : status==='completed')
74-76  caughtUp    = show && tracked && watched.size > 0 && nextEpisode() === null
77     watchedState= done || (caughtUp && tracked && status === 'watching')
80-82  seriesNotReady = show && !watchedState && !readyToMarkSeries()
```

- Line 40-47: this is the #157 fix, and it is **a read-time derivation bolted onto one component**.
  It is the right instinct in the wrong place — no other surface (library tabs, poster badges,
  Continue Watching, the push digest) shares it, so they all disagree.
- Line 74-77: `caughtUp` is the *only* representation of the model's `CaughtUpAiring` state in the
  entire codebase, and line 77 gates it on `status === 'watching'`. For *The Outsider*
  (`status = want_to_watch`, 10/10 watched) `watchedState` is therefore `false` — the show is fully
  watched and the button still says "Mark series watched".
- Line 74: `nextEpisode()` returns `null` for an **empty** episode list, so during the bug-4 window
  (`episodes = []`, `watched.size = 10`) `caughtUp` is `true` from zero evidence. If
  `#ensureTracked` had set `watching`, the button would read "Watched" while the persisted status is
  `watching` — the UI lies in the user's favour and hides the divergence until they open the lists.

### 3.6 Library / server surfaces

- `src/lib/tracking/library.svelte.ts:87-103` `markNext()` reconciles (95) — same write-only trigger.
  `load()` (26-78) loads episodes + watched per item and **never reconciles**.
- `src/lib/tracking/library.ts:167-172` `continueWatching` requires `status === 'watching'`; a
  caught-up-but-airing show is correctly excluded (its `next` is `null`), but a bug-4 show stuck at
  `want_to_watch` is excluded for the wrong reason and appears in the wrong tab.
- `src/lib/tracking/library.ts:99-134` `filterUpcoming` requires `status === 'watching'` — so a
  bug-4 show at `want_to_watch` **silently drops off the upcoming timeline**.
- `src/lib/server/push/digest.ts:103,135` filters `tracking.status IN ('want_to_watch','watching')`
  server-side. This is the one consumer that cannot cheaply re-derive today, and it constrains the
  §5 recommendation.
- `src/lib/server/sync/projection.ts:119-129` and `src/lib/client/idb/state.ts:73-79` project
  `status_changed` identically under per-field LWW. ✅ Both are correct and neither needs to change.
- `media.status` (TMDB's `"Ended"` / `"Returning Series"` / `"Canceled"`) is hydrated
  (`src/lib/server/media/hydrate.ts:180`), stored, and synced — and **read by nothing**. It is a
  strictly better and more stable "will this show gain episodes" signal than `in_production`, and it
  is already in every client's IndexedDB.

### 3.7 Model coverage scorecard

| Model state (§2) | Reached correctly today? |
|---|---|
| 1 Nothing watched | ✅ |
| 2 Partially watched | ✅ |
| 3 Caught up, still in production | ⚠️ Persisted as `watching` (model-acceptable), but only `tracking-controls.svelte:74-77` knows it, and only when `status === 'watching'`. No "waiting on new episodes" affordance anywhere. Not represented in the library, badges, or timeline. |
| 4 Caught up, ended | ✅ **iff** episode metadata was present at the moment of the last write. ❌ otherwise. |
| 5 All watched incl. Specials | ✅ by exclusion (never blocks, never required). |
| 6 Everything aired watched, metadata incomplete | ❌ **Bug 4.** Status frozen at whatever it was; never re-derived. |
| 7 Season added after complete | ❌ No re-derivation trigger. Row stays `completed` until an unrelated user write, which then silently demotes it to `watching` via `actions.ts:291`. |
| 8 Episode removed upstream | ✅ Orphan excluded by `reconcile.ts:36` + `airDateOf`. Minor: `tracking-controls.svelte:75` counts orphans in `watched.size`. |
| 9 Production ends while caught up | ❌ No trigger. *Las Fierbinţi* (766/766, `in_production = 1`) will stick at `watching` forever once it ends. |
| 10 Nothing aired yet | ✅ |
| 11 Explicit DNF | ✅ |

---

## 4. Bug 4, diagnosed

### 4.1 Live evidence

`marquee-preview` D1, all tracked shows (watched / aired):

```
Breaking Bad         ip=0  completed        62/62     ✅
Better Call Saul     ip=0  completed        63/63     ✅
The Handmaid's Tale  ip=0  completed        66/66     ✅
Top Gear             ip=1  completed      230/230     ⚠️ model says "Up to date", legacy forced write
Severance            ip=1  completed        19/19     ⚠️ same
Twin Peaks           ip=0  want_to_watch     0/48     ✅
Loki                 ip=0  watching          7/12     ✅
Good Guys            ip=0  completed          8/8     ✅
The Outsider         ip=0  want_to_watch   10/10     ❌ BUG 4, LIVE
Las Fierbinţi        ip=1  watching       766/766     ✅ (correct today; will stick when it ends — state 9)
Seven Days           ip=0  want_to_watch     0/66     ✅
Timeless             ip=0  completed        26/26     ✅
```

*The Outsider* — complete event log for `entity_id = e04a2c5f-545f-5a5d-b4d5-b5ed27564247`:

```
seq 2064  tracking.added    {"status":"want_to_watch"}   2026-08-03T21:17:21.531Z
seq 2065  episode.watched   {"season":1,"episode":1}     2026-08-03T21:17:32.071Z
seq 2066..2074  episode.watched  s1e2 … s1e10            …21:17:32.074 → .086Z   (15 ms span)
--- end of log. No tracking.status_changed. Ever. ---
```

Supporting rows:

```
tracking.status_updated_at = 1785791841531  (= the tracking.added clock; never moved)
media.updated_at           = 1785866378533  (2026-08-04T17:59:38Z — hydrated ~20.7 h LATER)
episodes rows for this media = 10           (they exist now)
```

Three facts fall out and each one is load-bearing:

1. **The 10 watch events span 15 ms** → a bulk seed (`#seedWatched`, `tracking.svelte.ts:283-287`),
   not manual marking.
2. **Zero `tracking.status_changed` events** → `reconcileStatus` was called (it always is, at
   `tracking.svelte.ts:226` / `:251`) and returned without writing. The only path that does that with
   `did_not_finish` absent is `reconcile.ts:27`.
3. **`media.updated_at` is 20.7 hours *after* the events** → the server had not even hydrated the
   media row when the user marked. The client's `episodes` object store was necessarily empty, and
   the seed came from `detail.seasons` (live TMDB, network) via the count-fallback branch.

The events post-date the #157 fix (`85db686`, committed `2026-08-01T21:19:51Z`) by ~2 days.
**This is current code, not a legacy artifact.**

### 4.2 The failing sequence, step by step

User opens a never-tracked, finished show. `detail` comes from the network (`/api/title/...`), so
`detail.seasons = [{seasonNumber: 1, episodeCount: 10, airDate: <past>}]` and
`detail.inProduction = false`. IndexedDB has no `media`/`seasons`/`episodes` rows for it.

| Step | Location | What happens |
|---|---|---|
| 1 | `title-detail.svelte:101-104` | `new TrackingState(id, mediaRecord, detail.seasons)`. `#inProduction = false` (74), `#seasons = [{1, 10, past}]` (75). |
| 2 | `tracking.svelte.ts:88-92` | `load()` → `getEpisodes(mediaId)` → **`[]`** (`src/lib/client/idb/media.ts:83-85`; no rows yet). `this.episodes = []`. |
| 3 | User taps "Add to list" | `add()` (151-157) → `tracking.added {want_to_watch}`. |
| 4 | `tracking-controls.svelte:80-82` | `seriesNotReady = !readyToMarkSeries()`. → |
| 5 | `actions.ts:243-251` | `hasSufficientEpisodeData([{1,10,past}], [], false, today)`: seasonsToCheck non-empty (243 passes); season aired so 245 doesn't skip; `seasonDated.length (0) >= 10`? no; **`inProduction !== true`** → `false !== true` → **`continue`** (248). Loop ends → **`return true`**. Gate **opens**. *(This is correct and deliberate — MRQ-130.)* |
| 6 | User taps "Mark series watched" → `tracking.svelte.ts:247-253` | |
| 6a | `:249` → `#ensureTracked('watching')` (276-281) | `this.view.tracked` is already `true` (step 3) → **no-op. Status stays `want_to_watch`.** |
| 6b | `:250` → `#seedWatched(#markable())` | `episodesToMark([{1,10,past}], [], false, today)`: `seasonDated.length === 0` so the dated branch (185-188) is skipped; **`!inProduction && s.airDate <= today`** (189) → true → emits `{1,1}…{1,10}` (190-192). 10 × `episode.watched`. ✅ correct write. |
| 6c | `:251` → `#reconcileStatus()` (290-292) | calls `reconcileStatus(mediaId, **this.episodes = []**, false)`. |
| 6d | **`reconcile.ts:26`** | `total = airedEpisodes([], today).length` → **`0`**. |
| 6e | **`reconcile.ts:27`** | **`if (total === 0) return;`** ← **the failure.** No `reconciledStatus` call, no event, no error. |

Persisted result: `status = 'want_to_watch'`, `status_updated_at` still the add clock, 10 watch rows.
Exactly the D1 row above.

### 4.3 Why it never heals

The question posed — *"is the root cause that nothing re-derives status when the missing data arrives
later, given `TrackingState` is frozen at mount?"* — is **half right, and the half that's wrong
matters.**

- ✅ **"Nothing re-derives when the data arrives later" — CONFIRMED.** ~20.7 h later the media
  channel pulled 10 episode rows. `sync.revision` bumped (`engine.svelte.ts:263`). If the page were
  open, `title-detail.svelte:105-108` would fire `tracking.load()` and `this.episodes` would fill
  with all 10 dated episodes. **`load()` (tracking.svelte.ts:84-101) does not call
  `#reconcileStatus()`.** There is no other trigger: `reconcileStatus` is called from exactly three
  places, all user writes — `tracking.svelte.ts:217`, `:226`, `:251` — plus
  `library.svelte.ts:95` (also a user write). `LibraryState.load()` doesn't reconcile either.
  Nothing on the server re-derives. So the status is frozen until the user happens to perform another
  episode write on that title. Result: **permanently stuck**, confirmed by the row still being wrong
  three days later.

- ❌ **"Because `TrackingState` is frozen at mount" — REFUTED as the cause of *this* bug.** The
  frozen-at-mount problem is real and is MRQ-193, but it applies to `#inProduction` only.
  `this.episodes` is *not* frozen (`tracking.svelte.ts:45`, refreshed at `:88-92` on every
  `sync.revision`), and `#seasons` is not frozen either (`:69`, `:79-81`). The stale input in bug 4
  is not stale — it is **absent at the single instant the derivation runs, and the derivation is
  never run again.** Freezing `#inProduction` would have made no difference here: `false` was correct
  at construction and stayed correct.

  Worth stating plainly, because it changes the fix: **adding `updateInProduction()` (MRQ-193) does
  not fix bug 4.** Patching the fourth field is once again the wrong lever.

### 4.4 Secondary observations on bug 4

- **The seed and the derivation read different sources.** `episodesToMark` reads `#seasons`;
  `reconcileStatus` reads `episodes`. Two sources, two arrival times, no coupling. Even a "reconcile
  again later" patch leaves this: the reconciler still can't count a finished show's aired episodes
  from summaries alone, which it demonstrably can do (the seeder does exactly that at
  `actions.ts:189-192`).
- **The UI masks it inconsistently.** With `#ensureTracked` firing (untracked title) the status
  becomes `watching`, `caughtUp` is `true` (`tracking-controls.svelte:74-76`, because
  `nextEpisode()` is `null` on an empty list) and `watchedState` is `true` → the button reads
  "Watched" while D1 says `watching`. With the title pre-added (The Outsider) the status stays
  `want_to_watch`, line 77's `status === 'watching'` guard fails, and the button reads "Mark series
  watched" — clicking it *does* fix the row (re-seed + reconcile, now with episodes present), so the
  state is technically recoverable, but only by accident and with no indication anything was wrong.
- **Recovery is not reachable from the other branch.** If the status did land on `watching`, the
  button reads "Watched" and `markWatched()` (`tracking-controls.svelte:84-92`) routes to
  `setStatus('want_to_watch')` — stepping *back*. The user must step back and re-mark to repair it.
  This is precisely the "UI gate hides the broken state" failure #157 set out to fix, resurfacing
  through a different field.

---

## 5. Recommendation

### 5.1 Verdict

**Move status derivation to read time.** Keep `tracking.status` as a persisted column — it is needed
by `digest.ts:103,135` and by the LWW projection — but **redefine it as *user intent*, and stop
writing derived values into it.** Everything the user sees, and every decision the app makes, comes
from a single pure function evaluated where the data is read.

The decisive argument is not elegance. It is that **write-time derivation puts a provisional
computation into an append-only log that has no expiry.** Metadata arrives late, arrives partial, and
changes retroactively (a season is added; a show ends). A derivation over those inputs is only ever
valid *as of a moment*. The event log is the one place in this system where a value can never be
corrected without either a new event or a history rewrite — so it is the worst possible cache. And
because `reconcile.ts:39` mints `tracking.status_changed` events, the log currently cannot even
distinguish "the user said completed" from "a device with incomplete metadata guessed completed".

### 5.2 What changes for each approach

**Option A — stay write-time, add re-derivation triggers**

Concretely:
1. Call `#reconcileStatus()` at the end of `TrackingState.load()` (`tracking.svelte.ts:84-101`) and
   after `LibraryState.load()` (`library.svelte.ts:26-78`).
2. Add a post-media-sync sweep over affected media ids in `engine.svelte.ts` near line 263.
3. Teach `reconcileStatus` a third outcome, `Unknown`, so `reconcile.ts:27` becomes "cannot decide"
   rather than "no change", and give it the season-summary fallback the seeder already has.
4. Add `updateInProduction()` (MRQ-193) and fix the `null` handling (MRQ-194) — otherwise a sweep
   would now *persist* the stale/unknown-metadata mistakes those bugs cause, making them worse.

Costs and risks:
- **Multi-device event storms.** A background sweep mints events. Device A (fresh metadata) writes
  `completed`; device B (12h-stale metadata, `in_production` still `1`) syncs, sweeps, and writes
  `watching` via `actions.ts:291`; A pulls, sweeps, writes `completed`. LWW by `clientCreatedAt`
  resolves each round but does not damp the oscillation, and each round is real rows in `events`.
  Requires a suppression rule (only reconcile when metadata `version` ≥ the version that produced
  the current status) — which means **storing metadata provenance on the tracking row**, i.e.
  reinventing cache invalidation inside the event log.
- Permanently entrenches derived events in an "events = user actions only" log.
- Every future input to the derivation (TMDB `status` string, per-region air dates, a new
  `moreEpisodesComing` signal) becomes another trigger to wire and another storm vector.

**Option B — read-time derivation (recommended)**

Concretely:
1. **New pure module**, e.g. `src/lib/tracking/derive.ts`:
   `deriveSeriesState(intent, watchedSet, seasons, episodes, inProduction, tmdbStatus, today)
   → { display: 'on_list'|'watching'|'up_to_date'|'watched'|'abandoned', progress, confidence }`.
   Fold in the season-summary fallback so a finished show is countable from summaries alone — that
   single change closes the seed/derive source split.
2. **Delete the derived write.** `reconcile.ts:39` stops recording `tracking.status_changed`.
   `reconcileStatus` either disappears or becomes the read-time function's caller-free core.
   `tracking.svelte.ts:217,226,251` and `library.svelte.ts:95` lose their reconcile calls.
   `tracking.added`/`status_changed` remain, emitted **only** from explicit user actions
   (`setStatus`, `add`, `#ensureTracked`).
3. **Point every read surface at it.** `tracking-controls.svelte:40-82` (replaces the ad-hoc
   `done`/`caughtUp`/`watchedState` trio), the library tabs
   (`library.ts:196-228` `filterAndSortLibrary`), `continueWatching` (167-172), `filterUpcoming`
   (99-134), poster badges, `canRate` (`actions.ts:51-55`).
   `LibraryState.load()` already fetches `episodes` + `watched` per item
   (`library.svelte.ts:37-50`), so no extra I/O.
4. **Server side.** `digest.ts:103,135` is the only server consumer of `tracking.status`. Two
   options: (a) leave it filtering on intent — a caught-up-but-airing show has intent `watching`, so
   the digest keeps working and only over-notifies for a `completed`-intent show that gained a season
   (arguably *desired*); or (b) derive it in SQL — the server holds `episodes.air_date` and
   `episode_watches` already. **Start with (a);** it requires zero server change.
5. **`did_not_finish` and explicit `completed` on movies stay pure intent** and pass through
   unchanged.

Migration cost: **zero.** No schema change, no `sequence` renumbering, no LWW change, no history
rewrite. Existing `status` values are simply reinterpreted as intent, and every historical
derived-status event becomes a (harmless, if occasionally odd) recorded intent. Existing bad rows
self-heal on first render:
- *The Outsider*: intent `want_to_watch`, progress `CaughtUpFinished` → renders **Watched**. Fixed
  with no write.
- *Top Gear* / *Severance*: intent `completed`, progress `CaughtUpAiring` → renders **Up to date**.
  A visible change, and the model-correct one.
- *Las Fierbinţi*: intent `watching`, progress `CaughtUpAiring` → **Up to date** today, and flips to
  **Watched** automatically the day TMDB reports it ended. State 9 solved for free.

### 5.3 Which of the four bugs each approach prevents

These are **not the same failure mode** and it matters:

| Bug | Failure mode | Option A (write-time + triggers) | Option B (read-time) |
|---|---|---|---|
| **1** — `markSeriesWatched` forced `completed` on a partial seed; UI gate keyed off raw `status`, so unrecoverable | *Unconditional write* + *no read-time cross-check* | ⚠️ **Partially.** A sweep would eventually correct the row once metadata landed. It would **not** have prevented the unrecoverable UI gate — that half was fixed by adding a read-time check (`tracking-controls.svelte:40-47`), i.e. by doing a bit of Option B. | ✅ **Fully.** No cached status exists to be forced. A partial seed reads as `InProgress` and the UI follows automatically. |
| **2** — `#inProduction` frozen at mount (MRQ-193) | *Stale input to a derivation* — a reactivity/plumbing bug | ❌ **No.** Orthogonal; needs `updateInProduction()` either way. **And A makes it worse**: a background sweep would persist the stale-`inProduction` verdict into the log, converting a transient wrong render into a permanent wrong event. | ⚠️ **No, but it defuses it.** Still needs the plumbing fix, but a stale read is a wrong *frame*, not a wrong *event*: the next render with fresh metadata corrects itself. Blast radius drops from permanent to transient. |
| **3** — `hasSufficientEpisodeData` treats `inProduction: null` as finished (MRQ-194) | *Predicate contradicts its own spec* | ❌ **No.** Independent spec bug in a write gate. | ⚠️ **No, but it shrinks it.** Under B this predicate's only remaining job is enabling the bulk-write button; it stops being (mis)used as the derivation's readiness signal. The model's explicit `MetadataConfidence` also replaces the `boolean \| null` that is currently read three inconsistent ways (`actions.ts:189` `!inProduction`, `:248` `!== true`, `:262` truthy). |
| **4** — status never flips after a pre-metadata seed | *A derivation was evaluated with absent inputs, the non-decision was cached, and nothing re-ran it* | ✅ **Yes**, if the sweep is wired *and* `reconcileStatus` learns the season-summary fallback. Both are required — a sweep alone still bails at `reconcile.ts:27` until the episode rows land, which for a finished show may be many hours. | ✅ **Yes, structurally.** There is no cache to go stale; the state is recomputed from whatever is currently known, every render. |

Net: Option A prevents 1 (partially) and 4. Option B prevents 1 and 4 outright and materially reduces
the damage from 2 and 3. Neither substitutes for fixing MRQ-193/194 — but under B those become
cosmetic-severity, whereas under A they become log-corrupting.

### 5.4 Constraint compliance

- `sequence` ordering: untouched. No renumbering, no reordering, no backfill.
- Epoch-ms per-field LWW: untouched. `projection.ts:69-92` and `state.ts:24-52` are unchanged.
- History: not rewritten. Historical derived `status_changed` events remain in the log and project
  as before; they are simply reinterpreted as intent.
- Option B **reduces** future log volume: no derived `status_changed` per bulk mark (the
  *Las Fierbinţi* 766-episode seed currently also mints status events).
- One-way door check: none. If read-time derivation proves wrong, the derived write can be
  reinstated at any point, because the log is unchanged.

---

## 6. Flags

### 6.1 States the model requires that the code has no representation of

1. **`CaughtUpAiring` — "in production but caught up."** Collapsed into `watching` at
   `actions.ts:290-292`. The only trace is a display-only `caughtUp` in one component
   (`tracking-controls.svelte:74-76`), gated on `status === 'watching'` (line 77), so it disappears
   for any other intent. No library tab, badge, sort, timeline entry, or notification rule knows this
   state exists. **There is no "waiting on new episodes" affordance anywhere in the app.** This is
   the single largest modelling gap and the reason states 3, 7 and 9 all fail.
2. **`Unknown` / metadata confidence.** `reconciledStatus` returns `TrackingStatus | null` where
   `null` conflates "already correct" and "cannot determine". `reconcile.ts:27` returns for the same
   two reasons. Callers cannot distinguish, so they cannot retry, defer, or surface uncertainty.
3. **Provenance of a derived status.** Nothing records *which metadata version* produced a given
   `status`, so no consumer can tell a fresh derivation from a 20-hour-old one, and no safe
   background re-derivation is possible (see 5.2 Option A risk).
4. **TMDB `status` string is stored and never read.** `hydrate.ts:180` → `media.status`
   (`"Ended"` / `"Returning Series"` / `"Canceled"`), synced to every client, referenced only by the
   offline detail passthrough (`offline-detail.ts:97`) and the record builder
   (`title-detail.svelte:87`). It is a more stable `moreEpisodesComing` signal than
   `in_production` — a mini-series can read `in_production: false` mid-run — and it is free.
5. **Specials have no modelled position.** Excluded from every computation
   (`actions.ts:102-104,125-129`, `reconcile.ts:34`) and never required, which is defensible, but it
   is implicit. There is no "watched everything including Specials" state, and no way for a user to
   express that they want Specials to count.

### 6.2 States the code can reach that the model says are unreachable

1. **`want_to_watch` with 100% of aired episodes watched.** Live: *The Outsider*. Unreachable in the
   model (`InProgress`/`CaughtUp*` always dominate a `want_to_watch` intent). Consequences beyond the
   wrong label: dropped from the upcoming timeline (`library.ts:103`) and from Continue Watching
   (`library.ts:169`).
2. **`completed` on a show still in production with unaired episodes.** Live: *Top Gear* (230/230,
   `in_production = 1`), *Severance* (19/19, `in_production = 1`). Produced by the pre-#157 forced
   write. Current code can no longer *create* it — but `actions.ts:291` will silently **demote it to
   `watching`** on the user's next episode toggle, with no explanation and no undo. A user who
   deliberately marked a returning series complete will find it back in Watching.
3. **`completed` with zero episode-watch rows.** The original bug-1 artifact. No longer producible;
   none currently in preview D1; no cleanup path exists if any survive elsewhere.
   `tracking-controls.svelte:40-47` deliberately renders these as "Watched" (trust status when
   episode data is absent), which is right for a clean device and wrong for a genuinely stuck row —
   the two are indistinguishable without provenance (6.1 #3).
4. **`watching` / `did_not_finish` on a movie.** `setStatus` (`tracking.svelte.ts:160-167`) accepts
   any `TrackingStatus` for any type, and the import path (MRQ-171) replays arbitrary events. The
   movie UI can't produce `watching`, but `canRate` (`actions.ts:51-55`) explicitly handles the case,
   so it is anticipated without being prevented. Should be either rejected at the boundary or
   accepted in the model, not both.
5. **`caughtUp === true` from an orphan watch row.** `tracking-controls.svelte:74-76` requires
   `watched.size > 0 && nextEpisode() === null`. A single watch row for an episode that no longer
   exists upstream, with an empty local `episodes` list, satisfies both. Narrow, but it is the same
   "empty list reads as complete" hazard as `reconcile.ts:27`, in a different sign.
