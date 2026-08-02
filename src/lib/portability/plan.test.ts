import { describe, expect, it } from 'vitest';
import { tmdbExternalId, tmdbMediaId, validateEvent } from '$lib/sync/events';
import { planImport } from './plan';
import {
	EXPORT_FORMAT,
	EXPORT_SCHEMA_VERSION,
	type ExportedTitle,
	type MarqueeExport
} from './schema';

const DEVICE = '11111111-1111-1111-1111-111111111111';
const ADDED_AT_ISO = '2026-03-11T09:04:00.000Z';
const ADDED_AT_MS = Date.parse(ADDED_AT_ISO);
const WATCHED_AT_ISO = '2026-06-20T18:00:00.000Z';
const WATCHED_AT_MS = Date.parse(WATCHED_AT_ISO);

function title(overrides: Partial<ExportedTitle> = {}): ExportedTitle {
	return {
		mediaId: tmdbMediaId('show', 95396),
		provider: 'tmdb',
		externalId: tmdbExternalId('show', 95396),
		type: 'show',
		title: 'Severance',
		year: 2022,
		status: 'want_to_watch',
		favorite: false,
		rating: null,
		addedAt: ADDED_AT_ISO,
		statusChangedAt: ADDED_AT_ISO,
		watchedEpisodes: [],
		...overrides
	};
}

/** A watched episode with its own mark-date. */
function ep(season: number, episode: number, watchedAt = WATCHED_AT_ISO) {
	return { season, episode, watchedAt };
}

function doc(titles: ExportedTitle[]): MarqueeExport {
	return {
		format: EXPORT_FORMAT,
		schemaVersion: EXPORT_SCHEMA_VERSION,
		exportedAt: '2026-08-01T14:22:03.451Z',
		titleCount: titles.length,
		titles
	};
}

describe('planImport', () => {
	it('seeds a single tracking.added for a title in its default state', () => {
		const plan = planImport(doc([title({ status: 'watching' })]), DEVICE);

		expect(plan.events).toHaveLength(1);
		expect(plan.events[0].type).toBe('tracking.added');
		expect(plan.events[0].payload).toEqual({ status: 'watching' });
	});

	it('never invents an intermediate status the user never had', () => {
		const plan = planImport(
			doc([title({ status: 'completed', statusChangedAt: WATCHED_AT_ISO })]),
			DEVICE
		);

		// Both events carry the final status: the export records where the title ended up, not the
		// path it took, so restoring a plausible-looking "want to watch → watching" trail would be
		// inventing history.
		const statuses = plan.events
			.filter((e) => e.type === 'tracking.added' || e.type === 'tracking.status_changed')
			.map((e) => (e.payload as { status: string }).status);
		expect(statuses).toEqual(['completed', 'completed']);
	});

	it('seeds a favorite event only when the title is favorited', () => {
		const plain = planImport(doc([title({ favorite: false })]), DEVICE);
		expect(plain.events.map((e) => e.type)).not.toContain('tracking.favorite_toggled');

		const starred = planImport(doc([title({ favorite: true })]), DEVICE);
		const favorite = starred.events.find((e) => e.type === 'tracking.favorite_toggled');
		expect(favorite?.payload).toEqual({ favorite: true });
	});

	it('seeds a rating event only when the title is rated', () => {
		const unrated = planImport(doc([title({ rating: null })]), DEVICE);
		expect(unrated.events.map((e) => e.type)).not.toContain('tracking.rated');

		const rated = planImport(doc([title({ rating: 4 })]), DEVICE);
		const rating = rated.events.find((e) => e.type === 'tracking.rated');
		expect(rating?.payload).toEqual({ rating: 4 });
	});

	it('seeds one episode.watched per watched episode', () => {
		const plan = planImport(doc([title({ watchedEpisodes: [ep(1, 1), ep(1, 2)] })]), DEVICE);

		const watched = plan.events.filter((e) => e.type === 'episode.watched');
		expect(watched).toHaveLength(2);
		expect(watched.map((e) => e.payload)).toEqual([
			{ season: 1, episode: 1 },
			{ season: 1, episode: 2 }
		]);
		expect(plan.counts.episodes).toBe(2);
	});

	it('clocks each episode with its own watched date, not the title clock', () => {
		const first = '2026-04-01T12:00:00.000Z';
		const second = '2026-05-02T20:30:00.000Z';
		const plan = planImport(
			doc([title({ watchedEpisodes: [ep(1, 1, first), ep(1, 2, second)] })]),
			DEVICE
		);

		const watched = plan.events.filter((e) => e.type === 'episode.watched');
		expect(watched.map((e) => e.clientCreatedAt)).toEqual([Date.parse(first), Date.parse(second)]);
		// Not the title's addedAt — otherwise every episode would look watched on the same day.
		expect(watched.map((e) => e.clientCreatedAt)).not.toContain(ADDED_AT_MS);
	});

	it('falls back to the title clock when an episode date is unusable', () => {
		const plan = planImport(doc([title({ watchedEpisodes: [ep(1, 1, 'nonsense')] })]), DEVICE);

		const watched = plan.events.find((e) => e.type === 'episode.watched');
		expect(watched?.clientCreatedAt).toBe(ADDED_AT_MS);
	});

	it('seeds a status_changed so a completion date survives separately from the add', () => {
		const plan = planImport(
			doc([title({ status: 'completed', statusChangedAt: WATCHED_AT_ISO })]),
			DEVICE
		);

		const added = plan.events.find((e) => e.type === 'tracking.added');
		expect(added?.clientCreatedAt).toBe(ADDED_AT_MS);

		const changed = plan.events.find((e) => e.type === 'tracking.status_changed');
		expect(changed?.clientCreatedAt).toBe(WATCHED_AT_MS);
		expect(changed?.payload).toEqual({ status: 'completed' });
	});

	it('omits the status_changed when the status never moved after the add', () => {
		const plan = planImport(
			doc([title({ status: 'watching', statusChangedAt: ADDED_AT_ISO })]),
			DEVICE
		);

		expect(plan.events).toHaveLength(1);
		expect(plan.events[0].type).toBe('tracking.added');
	});

	it('clocks favorite and rating at the status date, the latest the title is known to have moved', () => {
		const plan = planImport(
			doc([
				title({
					status: 'completed',
					statusChangedAt: WATCHED_AT_ISO,
					favorite: true,
					rating: 5
				})
			]),
			DEVICE
		);

		const favorite = plan.events.find((e) => e.type === 'tracking.favorite_toggled');
		const rating = plan.events.find((e) => e.type === 'tracking.rated');
		expect(favorite?.clientCreatedAt).toBe(WATCHED_AT_MS);
		expect(rating?.clientCreatedAt).toBe(WATCHED_AT_MS);
	});

	it('re-derives the media id from provider and external id, ignoring the file', () => {
		const plan = planImport(doc([title({ mediaId: 'a-forged-or-stale-id' })]), DEVICE);

		const expected = tmdbMediaId('show', 95396);
		expect(expected).not.toBe('a-forged-or-stale-id');
		expect(plan.events[0].entityId).toBe(expected);
		expect(plan.media[0].id).toBe(expected);
	});

	it('clocks events with the exported dates so restored dates and LWW survive', () => {
		const plan = planImport(doc([title({ favorite: true, rating: 3 })]), DEVICE);

		expect(plan.events.every((e) => e.clientCreatedAt === ADDED_AT_MS)).toBe(true);
	});

	it('falls back to now when addedAt is unusable as a clock', () => {
		const before = Date.now();
		const plan = planImport(doc([title({ addedAt: 'not a date' })]), DEVICE);
		const after = Date.now();

		expect(plan.events[0].clientCreatedAt).toBeGreaterThanOrEqual(before);
		expect(plan.events[0].clientCreatedAt).toBeLessThanOrEqual(after);
	});

	it('falls back to now when addedAt is beyond the clock bound the server enforces', () => {
		const plan = planImport(doc([title({ addedAt: '2200-01-01T00:00:00.000Z' })]), DEVICE);

		expect(plan.events[0].clientCreatedAt).toBeLessThan(4102444800000);
	});

	it('produces events the real event schema accepts', () => {
		const plan = planImport(
			doc([
				title({ favorite: true, rating: 5, watchedEpisodes: [ep(0, 1)] }),
				title({
					mediaId: tmdbMediaId('movie', 27205),
					externalId: tmdbExternalId('movie', 27205),
					type: 'movie',
					title: 'Inception',
					status: 'completed'
				})
			]),
			DEVICE
		);

		expect(plan.events.length).toBeGreaterThan(0);
		for (const event of plan.events) expect(validateEvent(event)).not.toBeNull();
	});

	it('seeds a behind (version 0) media stub so the channel hydrates the real row', () => {
		const plan = planImport(doc([title()]), DEVICE);

		expect(plan.media).toHaveLength(1);
		expect(plan.media[0]).toMatchObject({
			id: tmdbMediaId('show', 95396),
			provider: 'tmdb',
			externalId: 'show/95396',
			source: 'linked',
			type: 'show',
			title: 'Severance',
			year: 2022,
			version: 0,
			seasons: null,
			episodes: null
		});
	});

	it('keeps a title with no metadata, seeding its events but no media stub', () => {
		const mediaId = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
		const plan = planImport(
			doc([
				title({ mediaId, provider: null, externalId: null, type: null, title: null, year: null })
			]),
			DEVICE
		);

		expect(plan.events).toHaveLength(1);
		expect(plan.events[0].entityId).toBe(mediaId);
		expect(plan.media).toHaveLength(0);
		expect(plan.counts.titles).toBe(1);
		expect(plan.counts.skipped).toBe(0);
	});

	it('skips an entry that has neither a usable external id nor a usable media id', () => {
		const plan = planImport(
			doc([
				title({ mediaId: 'nonsense', provider: null, externalId: null, type: null }),
				title({ status: 'watching' })
			]),
			DEVICE
		);

		expect(plan.counts.skipped).toBe(1);
		expect(plan.counts.titles).toBe(1);
		expect(plan.events).toHaveLength(1);
	});

	it('stamps every event with the given device and a unique id', () => {
		const plan = planImport(
			doc([title({ favorite: true, rating: 2, watchedEpisodes: [ep(1, 1)] })]),
			DEVICE
		);

		expect(plan.events.every((e) => e.deviceId === DEVICE)).toBe(true);
		expect(new Set(plan.events.map((e) => e.id)).size).toBe(plan.events.length);
	});
});
