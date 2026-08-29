/**
 * The acceptance criterion for data portability: export an account, wipe it, import the file, and
 * get the same library back.
 *
 * Exercised end to end against the **real server projection** on in-memory SQLite with the
 * committed migrations applied — so this proves the document survives the same code path a live
 * import would take (client → `/api/sync` → projection), not just the client's own view of it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '$lib/server/db/test-db';
import { episodeWatches, tracking, users } from '$lib/server/db/schema';
import { tmdbExternalId, tmdbMediaId } from '$lib/sync/events';
import { applyEvents } from '$lib/server/sync/projection';
import type { ClientEpisodeWatch, ClientMedia, ClientTracking } from '$lib/client/idb';
import { buildExport } from './build';
import { parseExport } from './parse';
import { planImport } from './plan';

type Db = ReturnType<typeof createTestDb>;

const USER = 'user-1';
const DEVICE = '11111111-1111-1111-1111-111111111111';
const EXPORTED_AT = new Date('2026-08-01T14:22:03.451Z');

const SEVERANCE = tmdbMediaId('show', 95396);
const INCEPTION = tmdbMediaId('movie', 27205);

// Deliberately distinct: added long before watched, and each episode seen on its own day, so the
// round trip has to preserve dates rather than collapse them onto one clock.
const SEVERANCE_ADDED_AT = Date.UTC(2026, 0, 5, 9, 0, 0);
const SEVERANCE_EP_WATCHED_AT = [
	Date.UTC(2026, 1, 14, 20, 0, 0),
	Date.UTC(2026, 1, 21, 20, 30, 0),
	Date.UTC(2026, 2, 7, 22, 15, 0)
];
const SEVERANCE_COMPLETED_AT = Date.UTC(2026, 2, 7, 22, 20, 0);
const INCEPTION_ADDED_AT = Date.UTC(2025, 10, 2, 12, 0, 0);
const INCEPTION_WATCHED_AT = Date.UTC(2026, 5, 20, 18, 0, 0);

/** The library we'll export, destroy and restore. */
const ORIGINAL_TRACKING: ClientTracking[] = [
	{
		mediaId: SEVERANCE,
		status: 'watching',
		favorite: true,
		rating: 4,
		removed: false,
		statusUpdatedAt: SEVERANCE_COMPLETED_AT,
		favoriteUpdatedAt: SEVERANCE_COMPLETED_AT,
		ratingUpdatedAt: SEVERANCE_COMPLETED_AT,
		removedUpdatedAt: 0,
		addedAt: SEVERANCE_ADDED_AT
	},
	{
		mediaId: INCEPTION,
		status: 'completed',
		favorite: false,
		rating: 5,
		removed: false,
		statusUpdatedAt: INCEPTION_WATCHED_AT,
		favoriteUpdatedAt: INCEPTION_WATCHED_AT,
		ratingUpdatedAt: INCEPTION_WATCHED_AT,
		removedUpdatedAt: 0,
		addedAt: INCEPTION_ADDED_AT
	}
];

function media(id: string, type: 'movie' | 'show', title: string, external: string): ClientMedia {
	return {
		id,
		provider: 'tmdb',
		externalId: external,
		source: 'linked',
		type,
		title,
		year: 2022,
		posterPath: null,
		backdropPath: null,
		overview: '',
		genres: [],
		releaseDate: null,
		status: null,
		inProduction: null,
		firstAirDate: null,
		lastAirDate: null,
		version: 7,
		updatedAt: 1_700_000_000_000
	};
}

const ORIGINAL_MEDIA: ClientMedia[] = [
	media(SEVERANCE, 'show', 'Severance', tmdbExternalId('show', 95396)),
	media(INCEPTION, 'movie', 'Inception', tmdbExternalId('movie', 27205))
];

function watch(
	season: number,
	episode: number,
	updatedAt: number,
	watched = true
): ClientEpisodeWatch {
	return {
		id: `${SEVERANCE}::s${season}e${episode}`,
		mediaId: SEVERANCE,
		season,
		episode,
		watched,
		updatedAt
	};
}

const ORIGINAL_WATCHES: ClientEpisodeWatch[] = [
	watch(1, 1, SEVERANCE_EP_WATCHED_AT[0]),
	watch(1, 2, SEVERANCE_EP_WATCHED_AT[1]),
	watch(1, 3, SEVERANCE_COMPLETED_AT, false), // started then un-marked — must not come back
	watch(2, 1, SEVERANCE_EP_WATCHED_AT[2])
];

describe('export → import round trip', () => {
	let db: Db;

	beforeEach(async () => {
		db = createTestDb();
		await db.insert(users).values({ id: USER, email: 'round@trip.test', status: 'enabled' });
	});

	/** Export the fixture library, serialise it, and read it back the way import would. */
	function exportAndReparse() {
		const doc = buildExport({
			tracking: ORIGINAL_TRACKING,
			media: ORIGINAL_MEDIA,
			watches: ORIGINAL_WATCHES,
			exportedAt: EXPORTED_AT
		});
		const result = parseExport(JSON.stringify(doc, null, 2));
		if (!result.ok) throw new Error(`export did not survive its own parser: ${result.reason}`);
		return result.doc;
	}

	it('restores every title with its status, rating and favorite', async () => {
		const plan = planImport(exportAndReparse(), DEVICE);
		await applyEvents(db, USER, plan.events);

		const rows = await db.select().from(tracking).where(eq(tracking.userId, USER));
		expect(rows).toHaveLength(2);

		const severance = rows.find((r) => r.mediaId === SEVERANCE);
		expect(severance).toMatchObject({ status: 'watching', favorite: true, rating: 4 });

		const inception = rows.find((r) => r.mediaId === INCEPTION);
		expect(inception).toMatchObject({ status: 'completed', favorite: false, rating: 5 });
	});

	it('restores episode progress without reviving un-watched episodes', async () => {
		const plan = planImport(exportAndReparse(), DEVICE);
		await applyEvents(db, USER, plan.events);

		const rows = await db.select().from(episodeWatches).where(eq(episodeWatches.userId, USER));

		const watched = rows
			.filter((r) => r.watched)
			.map((r) => `s${r.season}e${r.episode}`)
			.sort();
		expect(watched).toEqual(['s1e1', 's1e2', 's2e1']);
		expect(rows.some((r) => r.season === 1 && r.episode === 3)).toBe(false);
	});

	it('preserves the original date added rather than stamping the import time', async () => {
		const plan = planImport(exportAndReparse(), DEVICE);
		await applyEvents(db, USER, plan.events);

		const rows = await db.select().from(tracking).where(eq(tracking.userId, USER));
		expect(rows.find((r) => r.mediaId === SEVERANCE)?.addedAt).toEqual(
			new Date(SEVERANCE_ADDED_AT)
		);
		expect(rows.find((r) => r.mediaId === INCEPTION)?.addedAt).toEqual(
			new Date(INCEPTION_ADDED_AT)
		);
	});

	it("restores a movie's watch date, which is its completion clock", async () => {
		const plan = planImport(exportAndReparse(), DEVICE);
		await applyEvents(db, USER, plan.events);

		const rows = await db.select().from(tracking).where(eq(tracking.userId, USER));
		const inception = rows.find((r) => r.mediaId === INCEPTION);
		// Watched in June, added the previous November — the two must not collapse together.
		expect(inception?.statusUpdatedAt).toBe(INCEPTION_WATCHED_AT);
		expect(inception?.statusUpdatedAt).not.toBe(INCEPTION_ADDED_AT);
	});

	it('restores the date each episode was marked watched', async () => {
		const plan = planImport(exportAndReparse(), DEVICE);
		await applyEvents(db, USER, plan.events);

		const rows = await db.select().from(episodeWatches).where(eq(episodeWatches.userId, USER));
		const byCoord = new Map(rows.map((r) => [`s${r.season}e${r.episode}`, r.updatedAt]));
		expect(byCoord.get('s1e1')).toBe(SEVERANCE_EP_WATCHED_AT[0]);
		expect(byCoord.get('s1e2')).toBe(SEVERANCE_EP_WATCHED_AT[1]);
		expect(byCoord.get('s2e1')).toBe(SEVERANCE_EP_WATCHED_AT[2]);
	});

	it("restores a show's last-watched date as its newest episode watch", async () => {
		const plan = planImport(exportAndReparse(), DEVICE);
		await applyEvents(db, USER, plan.events);

		const rows = await db.select().from(episodeWatches).where(eq(episodeWatches.userId, USER));
		const newest = Math.max(...rows.filter((r) => r.watched).map((r) => r.updatedAt));
		expect(newest).toBe(Math.max(...SEVERANCE_EP_WATCHED_AT));
	});

	it('re-exports to an identical document after the round trip', async () => {
		const before = buildExport({
			tracking: ORIGINAL_TRACKING,
			media: ORIGINAL_MEDIA,
			watches: ORIGINAL_WATCHES,
			exportedAt: EXPORTED_AT
		});

		const plan = planImport(exportAndReparse(), DEVICE);
		await applyEvents(db, USER, plan.events);

		// Rebuild client-shaped rows from what the server now holds, then export those.
		const trackingRows = await db.select().from(tracking).where(eq(tracking.userId, USER));
		const watchRows = await db.select().from(episodeWatches).where(eq(episodeWatches.userId, USER));

		const after = buildExport({
			tracking: trackingRows.map((r) => ({
				mediaId: r.mediaId,
				status: r.status,
				favorite: r.favorite,
				rating: r.rating,
				removed: r.removed,
				statusUpdatedAt: r.statusUpdatedAt,
				favoriteUpdatedAt: r.favoriteUpdatedAt,
				ratingUpdatedAt: r.ratingUpdatedAt,
				removedUpdatedAt: r.removedUpdatedAt,
				addedAt: r.addedAt.getTime()
			})),
			// Media arrives on its own channel; the stubs carry the same identity fields.
			media: plan.media.map((m) => ({ ...m, updatedAt: 0 })),
			watches: watchRows.map((r) => ({
				id: r.id,
				mediaId: r.mediaId,
				season: r.season,
				episode: r.episode,
				watched: r.watched,
				updatedAt: r.updatedAt
			})),
			exportedAt: EXPORTED_AT
		});

		expect(after.titles).toEqual(before.titles);
	});

	it('seeds far fewer events than a user would have generated', async () => {
		const plan = planImport(exportAndReparse(), DEVICE);

		// 2 adds + 2 status changes (both titles were watched after being added) + 1 favorite
		// + 2 ratings + 3 watched episodes. No invented intermediate statuses, and no unwatch for
		// the episode that was un-marked before the export.
		expect(plan.events).toHaveLength(10);
		expect(plan.events.filter((e) => e.type === 'episode.unwatched')).toHaveLength(0);
	});
});

describe('a user-authored entry survives the round trip', () => {
	const CUSTOM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
	const CUSTOM_ADDED_AT = Date.UTC(2025, 3, 2, 10, 0, 0);
	const CUSTOM_WATCHED_AT = Date.UTC(2025, 3, 9, 21, 0, 0);

	/** As `createCustomMedia` would have written it: `local` provider, no external id, past dates. */
	const customMedia: ClientMedia = {
		id: CUSTOM_ID,
		provider: 'local',
		externalId: null,
		source: 'custom',
		type: 'show',
		title: 'Midnight Cassette Club',
		year: 1986,
		posterPath: null,
		backdropPath: null,
		overview: 'Two seasons nobody catalogued.',
		genres: [],
		releaseDate: null,
		status: null,
		inProduction: false,
		firstAirDate: null,
		lastAirDate: null,
		version: 1,
		updatedAt: 0
	};

	const customTracking: ClientTracking = {
		mediaId: CUSTOM_ID,
		status: 'watching',
		favorite: true,
		rating: 3,
		removed: false,
		statusUpdatedAt: CUSTOM_WATCHED_AT,
		favoriteUpdatedAt: CUSTOM_WATCHED_AT,
		ratingUpdatedAt: CUSTOM_WATCHED_AT,
		removedUpdatedAt: 0,
		addedAt: CUSTOM_ADDED_AT
	};

	const customWatch: ClientEpisodeWatch = {
		id: `${CUSTOM_ID}::s1e1`,
		mediaId: CUSTOM_ID,
		season: 1,
		episode: 1,
		watched: true,
		updatedAt: CUSTOM_WATCHED_AT
	};

	function exportDoc() {
		return buildExport({
			tracking: [customTracking],
			media: [customMedia],
			watches: [customWatch],
			customSeasons: new Map([
				[
					CUSTOM_ID,
					[
						{ seasonNumber: 1, episodeCount: 2 },
						{ seasonNumber: 2, episodeCount: 3 }
					]
				]
			]),
			customCredits: new Map([
				[
					CUSTOM_ID,
					[
						{ role: 'cast' as const, name: 'Tomas Ilie', character: 'The Courier' },
						{ role: 'creator' as const, name: 'Ana Petrescu', character: null }
					]
				]
			]),
			exportedAt: EXPORTED_AT
		});
	}

	it('carries what nothing else could supply: the title, its description, seasons and credits', () => {
		// A provider-backed title only needs its identity in the file — the metadata is re-fetched.
		// Nothing will ever re-fetch this one, so the file has to be the source.
		const [entry] = exportDoc().titles;
		expect(entry).toMatchObject({
			mediaId: CUSTOM_ID,
			source: 'custom',
			externalId: null,
			title: 'Midnight Cassette Club',
			overview: 'Two seasons nobody catalogued.',
			year: 1986,
			seasons: [
				{ seasonNumber: 1, episodeCount: 2 },
				{ seasonNumber: 2, episodeCount: 3 }
			],
			credits: [
				{ role: 'cast', name: 'Tomas Ilie', character: 'The Courier' },
				{ role: 'creator', name: 'Ana Petrescu', character: null }
			]
		});
	});

	it('restores the cast and crew, re-minting the person ids the file could not carry', () => {
		const parsed = parseExport(JSON.stringify(exportDoc()));
		if (!parsed.ok) throw new Error('expected the document to parse');
		const [record] = planImport(parsed.doc, DEVICE).media;

		expect(record.credits).toMatchObject([
			{ role: 'cast', name: 'Tomas Ilie', character: 'The Courier', externalId: null },
			{ role: 'creator', name: 'Ana Petrescu', character: null }
		]);
		// A person id belongs to the account that minted it and means nothing anywhere else, so the
		// import mints its own rather than restoring the exporter's.
		expect(record.credits?.every((c) => c.personId.length > 0)).toBe(true);
	});

	it('rebuilds the entry whole, keeping the id the events name it by', () => {
		const parsed = parseExport(JSON.stringify(exportDoc()));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;

		const plan = planImport(parsed.doc, DEVICE);
		const [record] = plan.media;
		expect(record).toMatchObject({
			id: CUSTOM_ID,
			provider: 'local',
			source: 'custom',
			externalId: null,
			type: 'show',
			title: 'Midnight Cassette Club',
			overview: 'Two seasons nobody catalogued.',
			year: 1986,
			inProduction: false
		});
		// Seasons and their episodes are regenerated from the counts, with dates in the past so the
		// restored watch history lands on episodes that read as aired.
		expect(record.seasons).toHaveLength(2);
		expect(record.episodes).toHaveLength(5);
		expect(record.episodes?.every((e) => e.airDate !== null)).toBe(true);
		// Every event names the entry by the exported id, which is the only identity it has.
		expect(plan.events.every((e) => e.entityId === CUSTOM_ID)).toBe(true);
	});

	it('preserves the dates the entry was added and watched', () => {
		const parsed = parseExport(JSON.stringify(exportDoc()));
		if (!parsed.ok) throw new Error('expected the document to parse');
		const plan = planImport(parsed.doc, DEVICE);

		const added = plan.events.find((e) => e.type === 'tracking.added');
		const watched = plan.events.find((e) => e.type === 'episode.watched');
		expect(added?.clientCreatedAt).toBe(CUSTOM_ADDED_AT);
		expect(watched?.clientCreatedAt).toBe(CUSTOM_WATCHED_AT);
	});

	it('still reads a v1 file, which had no custom entries to carry', () => {
		const doc = exportDoc();
		// A file written before the fields existed: same shape, minus the v2 additions.
		const v1 = {
			...doc,
			schemaVersion: 1,
			titles: doc.titles.map((title) => {
				const stripped: Record<string, unknown> = { ...title };
				delete stripped.source;
				delete stripped.overview;
				delete stripped.seasons;
				delete stripped.credits;
				return stripped;
			})
		};
		const parsed = parseExport(JSON.stringify(v1));
		expect(parsed.ok).toBe(true);
	});
});
