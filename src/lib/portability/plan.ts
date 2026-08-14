/**
 * Turns an export document into the writes that restore it: media stubs to seed, events to replay.
 * Pure (device id injected, clocks from the document), so it tests without IndexedDB.
 *
 * Produces **the fewest events that reconstruct the end state**, not a plausible history — no
 * intermediate statuses are invented. Dates are the exception: each event carries its recorded
 * clock, since those clocks are the watched dates the app displays.
 */
import {
	createEvent,
	isHydratableProvider,
	mediaId as deriveMediaId,
	type EventEnvelope,
	type MediaRecord
} from '$lib/sync/events';
import { createCustomMedia } from '$lib/custom-media';
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
 * deterministic, so recomputing always beats copying. An entry with no provider identity (a custom
 * entry, or one exported before its media synced) falls back to the exported id, which is all it has.
 */
function resolveMediaId(entry: ExportedTitle): string | null {
	if (isHydratableProvider(entry.provider) && entry.externalId) {
		return deriveMediaId(entry.provider, entry.externalId);
	}
	return UUID.test(entry.mediaId) ? entry.mediaId : null;
}

/** An exported ISO date as an event clock, or `fallback` when it isn't one we could use. */
function resolveClock(iso: string, fallback: number): number {
	const parsed = Date.parse(iso);
	if (!Number.isInteger(parsed) || parsed <= 0 || parsed >= MAX_CLOCK) return fallback;
	return parsed;
}

/**
 * A behind-version media stub for an entry, or null when we can't build one. Required, not
 * cosmetic: the media channel derives what to hydrate from the local `media` store, and an event
 * names a title only by an opaque derived id — without a stub carrying `(provider, externalId)`
 * the server never learns what the title is. `version: 0` makes the next sync replace it.
 *
 * A user-authored entry is the opposite case: nothing will ever hydrate it, so the file *is* the
 * source and the record is rebuilt whole from what it carries.
 */
function mediaStub(entry: ExportedTitle, id: string, now: number): MediaRecord | null {
	if (entry.source === 'custom') {
		return createCustomMedia(
			{
				title: entry.title ?? '',
				type: entry.type ?? 'movie',
				year: entry.year,
				overview: entry.overview ?? '',
				seasons: entry.type === 'show' ? (entry.seasons ?? []) : [],
				// No `personId`: the exported ids belong to the account that minted them, so the import
				// mints its own. The name is the part that carries meaning across accounts.
				credits: (entry.credits ?? []).map((c) => ({
					role: c.role,
					name: c.name,
					character: c.character ?? ''
				}))
			},
			// The exported id, so the restored entry is the same title the events already name.
			{ id, now }
		);
	}
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
		// A second event only when the status moved after the add — that separates "added in January"
		// from "watched in June". Both carry the final status; the path taken wasn't exported.
		if (statusAt > addedAt) {
			events.push(
				createEvent('tracking.status_changed', id, { status: entry.status }, deviceId, statusAt)
			);
		}
		// Their own LWW clocks aren't exported (nothing surfaces them), so use the status clock —
		// the latest the title is known to have moved.
		if (entry.favorite) {
			events.push(
				createEvent('tracking.favorite_toggled', id, { favorite: true }, deviceId, statusAt)
			);
		}
		if (entry.rating !== null) {
			events.push(createEvent('tracking.rated', id, { rating: entry.rating }, deviceId, statusAt));
		}
		for (const ep of entry.watchedEpisodes) {
			// Own mark-date, so a show watched over months doesn't come back looking binged in a day.
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

		const stub = mediaStub(entry, id, now);
		if (stub) media.push(stub);
	}

	return { media, events, counts: { titles, episodes, skipped } };
}
