/**
 * Time travel over the event log: replay it up to a cutoff, diff two replays, and turn the
 * difference into the events that would undo it.
 *
 * Pure and client-safe — no IndexedDB, no DOM — so both the app and the tests run it on a plain
 * event array. The projection here mirrors `#lib/client/idb/state.ts`: the same per-field
 * last-writer-wins clocks keyed by `clientCreatedAt`, so a replayed state matches what the app
 * shows. Replay is ordered by `(clientCreatedAt, id)` so two events stamped in the same millisecond
 * resolve the same way on every device, whatever order they arrived in.
 *
 * A state is only as complete as the log this device holds. The client stores every event it pulls
 * (see `putPulledEvents`), so the log replays exactly; events pulled before that were kept only as
 * projected state and can't be reached by rewinding.
 */
import type { EventEnvelope, TrackingStatus } from './events.js';
import type { EventSpec } from '#lib/client/idb/index.js';

/** The materialised state of one title at a cutoff, clocks stripped. */
export interface TitleSnapshot {
	status: TrackingStatus;
	favorite: boolean;
	/** 1–5, or null when unrated. */
	rating: number | null;
	/** A tombstone: the title is off the user's lists but its history is kept. */
	removed: boolean;
}

/** A watched episode, kept with its coordinates so a diff can turn it back into an event. */
export interface EpisodeWatchSnapshot {
	mediaId: string;
	season: number;
	episode: number;
}

/** What the library looked like at a moment — the shape `diffStates` and the panel read. */
export interface HistoryState {
	/** Every title the log asserted by the cutoff, tombstones included. */
	tracking: Record<string, TitleSnapshot>;
	/** Watched episodes only (`false` tombstones dropped), keyed as the client's store keys them. */
	episodes: Record<string, EpisodeWatchSnapshot>;
}

/** A title that differs between two states. Every field is a target value, not a delta. */
export interface TitleDiff {
	mediaId: string;
	/** The title isn't on the list now, so the restore re-asserts it with `tracking.added`. */
	readd: boolean;
	/** Target status; always set when `readd`, otherwise only when it differs. */
	status?: TrackingStatus;
	favorite?: boolean;
	rating?: number | null;
	/** The title must leave the list (`tracking.removed`). Episodes are left alone. */
	remove?: boolean;
	episodes: { watched: EpisodeWatchSnapshot[]; unwatched: EpisodeWatchSnapshot[] };
}

/** A rewind stop: how far back the dial is turned, with the label on its tick. */
export interface RewindStop {
	label: string;
	ms: number;
}

/** The user-facing name of each status, shared by the panel and the event wording. */
export const STATUS_LABELS: Record<TrackingStatus, string> = {
	want_to_watch: 'On list',
	watching: 'Watching',
	completed: 'Watched',
	did_not_finish: "Didn't finish"
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Now first, then ever coarser steps back — the time dial's snap points. */
export const REWIND_STOPS: readonly RewindStop[] = [
	{ label: 'Now', ms: 0 },
	{ label: '15m', ms: 15 * MINUTE },
	{ label: '1h', ms: HOUR },
	{ label: '6h', ms: 6 * HOUR },
	{ label: '1d', ms: DAY },
	{ label: '3d', ms: 3 * DAY },
	{ label: '1w', ms: 7 * DAY },
	{ label: '1mo', ms: 30 * DAY }
];

/** Largest unit first, for the "as of …" label. */
const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
	['month', 30 * DAY],
	['week', 7 * DAY],
	['day', DAY],
	['hour', HOUR],
	['minute', MINUTE]
];

/** "15 minutes ago" / "yesterday" / "now", in the user's locale. */
export function relativeAgo(ms: number): string {
	if (ms < MINUTE) return 'now';
	const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
	for (const [unit, size] of RELATIVE_UNITS) {
		if (ms >= size) return format.format(-Math.round(ms / size), unit);
	}
	return 'now';
}

/** The client's episode-watch key (`${mediaId}::s{S}e{E}`), so a replay matches the store's rows. */
export function episodeWatchKey(mediaId: string, season: number, episode: number): string {
	return `${mediaId}::s${season}e${episode}`;
}

/** What one log event did, in the words the dial's panel uses. */
export function eventSummary(event: EventEnvelope): string {
	switch (event.type) {
		case 'tracking.added':
			return `Added · ${STATUS_LABELS[(event.payload as { status: TrackingStatus }).status]}`;
		case 'tracking.status_changed':
			return `Status → ${STATUS_LABELS[(event.payload as { status: TrackingStatus }).status]}`;
		case 'tracking.favorite_toggled':
			return (event.payload as { favorite: boolean }).favorite ? 'Favorited' : 'Unfavorited';
		case 'tracking.rated': {
			const { rating } = event.payload as { rating: number | null };
			return rating === null ? 'Rating cleared' : `Rated ${rating}`;
		}
		case 'tracking.removed':
			return 'Removed from your lists';
		case 'episode.watched':
		case 'episode.unwatched': {
			const { season, episode } = event.payload as { season: number; episode: number };
			const label = `S${season}E${episode}`;
			return event.type === 'episode.watched' ? `${label} watched` : `${label} unwatched`;
		}
		case 'media.linked':
			return 'Linked to a match';
		case 'media.unlinked':
			return 'Match removed';
		case 'media.match_declined':
			return 'Match declined';
		case 'media.deleted':
			return 'Custom entry deleted';
	}
}

/**
 * Detents the arc can address comfortably. The dial covers the whole log at this resolution: one
 * event per detent near now, decimating by distance so a long history compresses instead of
 * overflowing the arc.
 */
export const DETENT_CAPACITY = 120;

/** Events one detent covers, `distance` events back. `fine` always means a single event. */
export function densityFor(distance: number, fine = false): number {
	if (fine) return 1;
	return Math.max(1, Math.round(Math.abs(distance) / DETENT_CAPACITY));
}

/** Moving `back` one detent further back (+1) or towards now (−1), clamped to the log's ends. */
export function backStep(length: number, back: number, direction: 1 | -1, fine = false): number {
	const next = back + direction * densityFor(back, fine);
	return Math.max(0, Math.min(length, next));
}

/**
 * The detent nearest a dial position (0 = now, 1 = the far end of the log). Detents are spaced by
 * the density at that distance, so they line up with the steps `backStep` walks.
 */
export function backFromProgress(length: number, progress: number, fine = false): number {
	if (length <= 0) return 0;
	const target = Math.round(Math.max(0, Math.min(1, progress)) * length);
	const density = densityFor(target, fine);
	return Math.max(0, Math.min(length, Math.round(target / density) * density));
}

/** Mutable accumulator — the LWW clocks never leave this module. */
type TitleRow = TitleSnapshot & {
	statusUpdatedAt: number;
	favoriteUpdatedAt: number;
	ratingUpdatedAt: number;
	removedUpdatedAt: number;
};

function titleRow(replay: Replay, mediaId: string): TitleRow {
	const existing = replay.titles.get(mediaId);
	if (existing) return existing;
	const row: TitleRow = {
		status: 'want_to_watch',
		favorite: false,
		rating: null,
		removed: false,
		statusUpdatedAt: 0,
		favoriteUpdatedAt: 0,
		ratingUpdatedAt: 0,
		removedUpdatedAt: 0
	};
	replay.titles.set(mediaId, row);
	return row;
}

interface Replay {
	titles: Map<string, TitleRow>;
	/** Presence is a `watched` verdict; the coordinates are kept so a diff can re-emit the event. */
	episodes: Map<string, { episode: EpisodeWatchSnapshot; watched: boolean; clock: number }>;
}

function applyEvent(replay: Replay, event: EventEnvelope): void {
	const clock = event.clientCreatedAt;
	const entityId = event.entityId;

	switch (event.type) {
		case 'tracking.added': {
			const { status } = event.payload as { status: TrackingStatus };
			const row = titleRow(replay, entityId);
			// Status and revival are independent LWW fields, exactly as the live projection treats them.
			if (clock >= row.statusUpdatedAt) {
				row.status = status;
				row.statusUpdatedAt = clock;
			}
			if (clock >= row.removedUpdatedAt) {
				row.removed = false;
				row.removedUpdatedAt = clock;
			}
			return;
		}
		case 'tracking.status_changed': {
			const { status } = event.payload as { status: TrackingStatus };
			const row = titleRow(replay, entityId);
			if (clock >= row.statusUpdatedAt) {
				row.status = status;
				row.statusUpdatedAt = clock;
			}
			return;
		}
		case 'tracking.favorite_toggled': {
			const { favorite } = event.payload as { favorite: boolean };
			const row = titleRow(replay, entityId);
			if (clock >= row.favoriteUpdatedAt) {
				row.favorite = favorite;
				row.favoriteUpdatedAt = clock;
			}
			return;
		}
		case 'tracking.rated': {
			const { rating } = event.payload as { rating: number | null };
			const row = titleRow(replay, entityId);
			if (clock >= row.ratingUpdatedAt) {
				row.rating = rating;
				row.ratingUpdatedAt = clock;
			}
			return;
		}
		case 'tracking.removed': {
			const row = titleRow(replay, entityId);
			if (clock >= row.removedUpdatedAt) {
				row.removed = true;
				row.removedUpdatedAt = clock;
			}
			return;
		}
		case 'episode.watched':
		case 'episode.unwatched': {
			const { season, episode } = event.payload as { season: number; episode: number };
			const key = episodeWatchKey(entityId, season, episode);
			const existing = replay.episodes.get(key);
			if (existing && clock < existing.clock) return;
			replay.episodes.set(key, {
				episode: { mediaId: entityId, season, episode },
				watched: event.type === 'episode.watched',
				clock
			});
			return;
		}
		default:
			// `media.*` events change identity and reference data, never tracking or watch state.
			return;
	}
}

/** The log in replay order — the order both the cutoff and the event dial walk it in. */
export function orderedLog(events: readonly EventEnvelope[]): EventEnvelope[] {
	return [...events].sort(
		(a, b) => a.clientCreatedAt - b.clientCreatedAt || a.id.localeCompare(b.id)
	);
}

/** Flattens a replay accumulator into the public, clock-free shape. */
function snapshot(replay: Replay): HistoryState {
	const tracking: Record<string, TitleSnapshot> = {};
	for (const [mediaId, row] of replay.titles) {
		tracking[mediaId] = {
			status: row.status,
			favorite: row.favorite,
			rating: row.rating,
			removed: row.removed
		};
	}
	const episodes: Record<string, EpisodeWatchSnapshot> = {};
	for (const [key, entry] of replay.episodes) {
		if (entry.watched) episodes[key] = entry.episode;
	}
	return { tracking, episodes };
}

/** Replays an already-ordered slice of the log. */
function project(events: readonly EventEnvelope[]): HistoryState {
	const replay: Replay = { titles: new Map(), episodes: new Map() };
	for (const event of events) applyEvent(replay, event);
	return snapshot(replay);
}

/**
 * The library as it stood at `cutoff` (epoch ms), replaying every event stamped at or before it.
 * An empty log is an empty library.
 */
export function stateAt(events: readonly EventEnvelope[], cutoff: number): HistoryState {
	return project(orderedLog(events).filter((event) => event.clientCreatedAt <= cutoff));
}

/**
 * The library after the first `step` events of the ordered log — the event dial's position.
 * `step = log.length` is now, `step = 0` is an empty library.
 */
export function stateAtStep(log: readonly EventEnvelope[], step: number): HistoryState {
	return project(log.slice(0, Math.max(0, Math.min(step, log.length))));
}

/** The event a step sits just after — the newest one `stateAtStep(log, step)` includes. */
export function eventAtStep(
	log: readonly EventEnvelope[],
	step: number
): EventEnvelope | undefined {
	return step <= 0 ? undefined : log[Math.min(step, log.length) - 1];
}

/** One title's state after the first `upto` events — the cheap half of an event's own diff. */
function titleStateAt(log: readonly EventEnvelope[], mediaId: string, upto: number): HistoryState {
	const replay: Replay = { titles: new Map(), episodes: new Map() };
	for (let i = 0; i < Math.min(upto, log.length); i++) {
		if (log[i].entityId === mediaId) applyEvent(replay, log[i]);
	}
	return snapshot(replay);
}

/**
 * Undoing one event. It diffs the title's state *now* against its state just before `step`'s event,
 * so the write pulls the present back over that event — and is empty when a later event already
 * undid it. Null too for an identity event, which projects no tracking state.
 */
export function eventDiff(log: readonly EventEnvelope[], step: number): TitleDiff | null {
	const event = eventAtStep(log, step);
	if (!event || event.type.startsWith('media.')) return null;
	const before = titleStateAt(log, event.entityId, step - 1);
	const now = titleStateAt(log, event.entityId, log.length);
	return diffStates(now, before)[0] ?? null;
}

/** A title is on the user's lists when it has a row that isn't tombstoned. */
export function isOnList(state: HistoryState, mediaId: string): boolean {
	const row = state.tracking[mediaId];
	return row !== undefined && !row.removed;
}

/** Episode entries grouped by title, so a diff never rescans the whole watch set per title. */
function episodesByMedia(state: HistoryState): Map<string, EpisodeWatchSnapshot[]> {
	const byMedia = new Map<string, EpisodeWatchSnapshot[]>();
	for (const episode of Object.values(state.episodes)) {
		const list = byMedia.get(episode.mediaId);
		if (list) list.push(episode);
		else byMedia.set(episode.mediaId, [episode]);
	}
	return byMedia;
}

/**
 * What has to change for `from` to look like `to`. Ordered by media id so the compensating events
 * come out in the same order every run.
 */
export function diffStates(from: HistoryState, to: HistoryState): TitleDiff[] {
	const fromEpisodes = episodesByMedia(from);
	const toEpisodes = episodesByMedia(to);
	const mediaIds = [
		...new Set([...Object.keys(from.tracking), ...Object.keys(to.tracking)])
	].sort();

	const diffs: TitleDiff[] = [];
	for (const mediaId of mediaIds) {
		const wasOn = isOnList(from, mediaId);
		const willBeOn = isOnList(to, mediaId);
		const target = to.tracking[mediaId];

		if (wasOn && !willBeOn) {
			diffs.push({ mediaId, readd: false, remove: true, episodes: { watched: [], unwatched: [] } });
			continue;
		}
		if (!willBeOn) continue; // off the list before and after — a tombstone difference changes nothing

		// A title coming back is compared against the defaults: `tracking.added` carries only the
		// status, so a favorite or a rating the past had needs its own event.
		const before = wasOn ? from.tracking[mediaId] : undefined;
		const hadWatched = fromEpisodes.get(mediaId) ?? [];
		const wasWatched = new Set(hadWatched.map(episodeWatchKeyOf));
		const watched = (toEpisodes.get(mediaId) ?? []).filter(
			(e) => !wasWatched.has(episodeWatchKeyOf(e))
		);
		const unwatched = hadWatched.filter((e) => !to.episodes[episodeWatchKeyOf(e)]);

		const statusDiffers = !wasOn || before?.status !== target.status;
		const favoriteDiffers = !wasOn ? target.favorite : before?.favorite !== target.favorite;
		const ratingDiffers = !wasOn ? target.rating !== null : before?.rating !== target.rating;
		if (
			!statusDiffers &&
			!favoriteDiffers &&
			!ratingDiffers &&
			!watched.length &&
			!unwatched.length
		)
			continue;

		diffs.push({
			mediaId,
			readd: !wasOn,
			...(statusDiffers ? { status: target.status } : {}),
			...(favoriteDiffers ? { favorite: target.favorite } : {}),
			...(ratingDiffers ? { rating: target.rating } : {}),
			episodes: { watched, unwatched }
		});
	}
	return diffs;
}

function episodeWatchKeyOf(episode: EpisodeWatchSnapshot): string {
	return episodeWatchKey(episode.mediaId, episode.season, episode.episode);
}

/** Titles and watched-episode counts for the "as of …" panel. */
export function summarize(state: HistoryState): { titles: number; episodes: number } {
	const listIds = new Set(Object.keys(state.tracking).filter((id) => isOnList(state, id)));
	const episodes = Object.values(state.episodes).filter((e) => listIds.has(e.mediaId)).length;
	return { titles: listIds.size, episodes };
}

/**
 * The titles the log touched strictly after `cutoff` (up to `now`), newest first — the film strip's
 * running order. Identity events aren't a library change, so they're skipped.
 */
/**
 * The titles the ordered log touched after `step`, newest first — the event dial's film strip.
 * Identity events aren't a library change, so they're skipped.
 */
export function touchedAfterStep(log: readonly EventEnvelope[], step: number): string[] {
	const seen = new Set<string>();
	for (let i = log.length - 1; i >= Math.max(0, step); i--) {
		if (!log[i].type.startsWith('media.')) seen.add(log[i].entityId);
	}
	return [...seen];
}

export function touchedSince(
	events: readonly EventEnvelope[],
	cutoff: number,
	now: number
): string[] {
	const latest = new Map<string, number>();
	for (const event of events) {
		if (event.type.startsWith('media.')) continue;
		if (event.clientCreatedAt <= cutoff || event.clientCreatedAt > now) continue;
		const seen = latest.get(event.entityId);
		if (seen === undefined || event.clientCreatedAt > seen) {
			latest.set(event.entityId, event.clientCreatedAt);
		}
	}
	return [...latest.entries()].sort((a, b) => b[1] - a[1]).map(([mediaId]) => mediaId);
}

/**
 * The events that turn a `from` state into a `to` one. The caller stamps them now, so each
 * compensating write wins the LWW merge and reaches the user's other devices through the normal
 * sync path — a rewind is a forward write, never a deletion.
 */
export function compensatingEvents(diffs: readonly TitleDiff[]): EventSpec[] {
	const specs: EventSpec[] = [];
	for (const diff of diffs) {
		if (diff.remove) {
			specs.push({ type: 'tracking.removed', entityId: diff.mediaId, payload: {} });
			continue;
		}
		if (diff.readd) {
			specs.push({
				type: 'tracking.added',
				entityId: diff.mediaId,
				payload: { status: diff.status ?? 'want_to_watch' }
			});
		} else if (diff.status) {
			specs.push({
				type: 'tracking.status_changed',
				entityId: diff.mediaId,
				payload: { status: diff.status }
			});
		}
		if (diff.favorite !== undefined) {
			specs.push({
				type: 'tracking.favorite_toggled',
				entityId: diff.mediaId,
				payload: { favorite: diff.favorite }
			});
		}
		if (diff.rating !== undefined) {
			specs.push({
				type: 'tracking.rated',
				entityId: diff.mediaId,
				payload: { rating: diff.rating }
			});
		}
		for (const { season, episode } of diff.episodes.watched) {
			specs.push({ type: 'episode.watched', entityId: diff.mediaId, payload: { season, episode } });
		}
		for (const { season, episode } of diff.episodes.unwatched) {
			specs.push({
				type: 'episode.unwatched',
				entityId: diff.mediaId,
				payload: { season, episode }
			});
		}
	}
	return specs;
}

/** Event count a restore would write — what the UI states before the user commits. */
export function compensatingEventCount(diffs: readonly TitleDiff[]): number {
	return compensatingEvents(diffs).length;
}
