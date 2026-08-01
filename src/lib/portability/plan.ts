/**
 * Turns an export document into the writes that restore it: media stubs to seed, and the events
 * to replay. Pure — the device id is injected and every clock comes from the document — so the
 * whole translation unit-tests without IndexedDB or a network.
 *
 * Import deliberately produces **the fewest events that reconstruct the end state**, not a
 * plausible history: no intermediate statuses are invented, and favorite/rating events appear
 * only when they'd say something. A title in its default state costs exactly one event.
 *
 * The exception is dates. Every event is stamped with the clock the document recorded for it, and
 * a title that changed status after being added gets a second event to carry that later clock —
 * because those clocks *are* the watched dates the app derives and displays. Collapsing them
 * would restore a library where everything appears to have been watched on import day.
 */
import {
	createEvent,
	mediaId as deriveMediaId,
	type EventEnvelope,
	type MediaRecord
} from '$lib/sync/events';
import { mediaRecordFromSearch, parseTmdbExternalId } from '$lib/tracking/media-record';
import type { ExportedTitle, MarqueeExport } from './schema';

export interface ImportPlan {
	/** Behind-version stubs to write, so the media channel knows what to hydrate. */
	media: MediaRecord[];
	events: EventEnvelope[];
	counts: {
		/** Titles that will be restored. */
		titles: number;
		/** Episode watches among them. */
		episodes: number;
		/** Entries dropped because nothing in them identified a title. */
		skipped: number;
	};
}

/** Matches `crypto.randomUUID()` output — the only ids we'd trust from a file as an entity id. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The upper bound the event schema enforces on `clientCreatedAt` (Jan 1 2100), so a bogus clock
 * can't win every future merge. Mirrored here to reject a clock before minting it, rather than
 * having the server drop the event later.
 */
const MAX_CLOCK = 4102444800000;

/**
 * Our media id for an entry. Provider-backed titles re-derive it from `(provider, externalId)` —
 * the file's `mediaId` is untrusted and may be stale or hand-edited, and the derivation is
 * deterministic, so recomputing always beats copying. An entry with no provider identity falls
 * back to the exported id, which is all it has.
 */
function resolveMediaId(entry: ExportedTitle): string | null {
	if (entry.provider && entry.externalId) return deriveMediaId(entry.provider, entry.externalId);
	return UUID.test(entry.mediaId) ? entry.mediaId : null;
}

/** An exported ISO date as an event clock, or `fallback` when it isn't one we could use. */
function resolveClock(iso: string, fallback: number): number {
	const parsed = Date.parse(iso);
	if (!Number.isInteger(parsed) || parsed <= 0 || parsed >= MAX_CLOCK) return fallback;
	return parsed;
}

/**
 * A behind-version media stub for an entry, or null when we can't build one.
 *
 * These are not cosmetic. The media channel derives what to hydrate from the local `media` store
 * (`getLinkedMediaRefs`), and an event references a title only by an opaque derived id — so
 * without a stub carrying `(provider, externalId)`, the server can never learn what the title
 * *is*, and it stays unhydrated forever. `version: 0` marks the stub behind, so the next media
 * sync replaces it with the real row (genres, artwork, seasons, episodes, air dates).
 */
function mediaStub(entry: ExportedTitle): MediaRecord | null {
	if (entry.provider !== 'tmdb' || !entry.externalId) return null;
	const ref = parseTmdbExternalId(entry.externalId);
	if (!ref) return null;
	return mediaRecordFromSearch({
		tmdbId: ref.tmdbId,
		type: entry.type ?? ref.type,
		title: entry.title ?? '',
		year: entry.year,
		posterPath: null
	});
}

/** Build the writes that restore an export document. */
export function planImport(
	doc: MarqueeExport,
	deviceId: string,
	now: number = Date.now()
): ImportPlan {
	const media: MediaRecord[] = [];
	const events: EventEnvelope[] = [];
	let titles = 0;
	let episodes = 0;
	let skipped = 0;

	for (const entry of doc.titles) {
		const id = resolveMediaId(entry);
		if (!id) {
			skipped += 1;
			continue;
		}
		titles += 1;

		const addedAt = resolveClock(entry.addedAt, now);
		// The status clock can't precede the add — `addedAt` is the earliest clock the projection saw.
		const statusAt = Math.max(resolveClock(entry.statusChangedAt, addedAt), addedAt);

		events.push(createEvent('tracking.added', id, { status: entry.status }, deviceId, addedAt));
		// A second event only when the status moved after the add — that's what separates "added in
		// January" from "watched in June", and it's what the watched-date UI reads. Both carry the
		// final status: the export records where the title ended up, not the path it took, so
		// synthesising an intermediate status would be inventing history.
		if (statusAt > addedAt) {
			events.push(
				createEvent('tracking.status_changed', id, { status: entry.status }, deviceId, statusAt)
			);
		}
		// Favorite and rating have their own last-write-wins clocks, which the document doesn't
		// carry (nothing surfaces them). The status clock is the latest the title is known to have
		// moved, so it's the closest honest stamp — and it keeps them from losing to the status.
		if (entry.favorite) {
			events.push(
				createEvent('tracking.favorite_toggled', id, { favorite: true }, deviceId, statusAt)
			);
		}
		if (entry.rating !== null) {
			events.push(createEvent('tracking.rated', id, { rating: entry.rating }, deviceId, statusAt));
		}
		for (const ep of entry.watchedEpisodes) {
			// Each episode keeps its own mark-date, so a show watched over months doesn't come back
			// looking binged in a day.
			events.push(
				createEvent(
					'episode.watched',
					id,
					{ season: ep.season, episode: ep.episode },
					deviceId,
					resolveClock(ep.watchedAt, addedAt)
				)
			);
			episodes += 1;
		}

		const stub = mediaStub(entry);
		if (stub) media.push(stub);
	}

	return { media, events, counts: { titles, episodes, skipped } };
}
