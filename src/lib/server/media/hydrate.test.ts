import { describe, expect, it } from 'vitest';
import { eq, getTableName } from 'drizzle-orm';
import { createTestDb } from '$lib/server/db/test-db';
import { episodes, episodeWatches, seasons, tracking, users } from '$lib/server/db/schema';
import { mediaId, trackingKey } from '$lib/sync/events';
import type { MediaDetail, SeasonDetail } from '$lib/server/tmdb';
import { needsRefresh, parseTmdbExternalId, refreshMedia } from './hydrate';

type Db = ReturnType<typeof createTestDb>;

/**
 * Monkey-patches insert/update/delete on `db` to record which table each call targets, so a test
 * can assert on write volume (not just end state) — e.g. "an unchanged refresh writes zero rows".
 * Calls through to the real implementation; only observes.
 */
function trackWrites(db: Db): { op: 'insert' | 'update' | 'delete'; table: string }[] {
	const writes: { op: 'insert' | 'update' | 'delete'; table: string }[] = [];
	const target = db as unknown as Record<string, (...args: unknown[]) => unknown>;
	for (const op of ['insert', 'update', 'delete'] as const) {
		const original = target[op].bind(db);
		target[op] = (...args: unknown[]) => {
			writes.push({ op, table: getTableName(args[0] as never) });
			return original(...args);
		};
	}
	return writes;
}

const T0 = Date.UTC(2026, 6, 24); // fixed "now" for deterministic TTL tests
const USER = 'user-1';

async function seedTracker(
	db: ReturnType<typeof createTestDb>,
	mediaId: string,
	status: 'watching' | 'completed'
) {
	await db
		.insert(users)
		.values({ id: USER, email: 'u1@x.com', status: 'enabled' })
		.onConflictDoNothing();
	await db
		.insert(tracking)
		.values({ id: trackingKey(USER, mediaId), userId: USER, mediaId, status });
}

async function markWatched(
	db: ReturnType<typeof createTestDb>,
	mediaId: string,
	season: number,
	episode: number
) {
	await db
		.insert(episodeWatches)
		.values({
			id: `${USER}::${mediaId}::s${season}e${episode}`,
			userId: USER,
			mediaId,
			season,
			episode,
			watched: true
		});
}

async function trackerStatus(
	db: ReturnType<typeof createTestDb>,
	mediaId: string
): Promise<string> {
	const [row] = await db
		.select({ status: tracking.status })
		.from(tracking)
		.where(eq(tracking.id, trackingKey(USER, mediaId)));
	return row.status;
}

const movieDefaults: MediaDetail = {
	tmdbId: 603,
	type: 'movie',
	title: 'The Matrix',
	year: 1999,
	overview: 'Neo.',
	posterPath: '/poster.jpg',
	backdropPath: '/backdrop.jpg',
	rating: 8.3,
	voteCount: 100,
	runtime: 136,
	genres: ['Action'],
	cast: [],
	director: null,
	writers: [],
	producers: [],
	creators: [],
	trailer: null,
	releaseDate: '1999-03-31',
	status: null,
	inProduction: null,
	firstAirDate: null,
	lastAirDate: null,
	seasons: [],
	similar: []
};

/** A movie TMDB stub exposing getDetails + getSeason, counting detail calls. */
function movieStub(overrides: Partial<MediaDetail> = {}) {
	let detailCalls = 0;
	return {
		detailCalls: () => detailCalls,
		client: {
			async getDetails(type: 'movie' | 'show', id: number): Promise<MediaDetail> {
				detailCalls++;
				return { ...movieDefaults, tmdbId: id, type, ...overrides };
			},
			async getSeason(): Promise<SeasonDetail> {
				return { seasonNumber: 0, name: '', episodes: [] };
			}
		}
	};
}

interface EpisodeStub {
	episodeNumber: number;
	name: string;
	overview: string;
	airDate: string | null;
	runtime: number | null;
	stillPath: string | null;
}

/**
 * A show TMDB stub whose episode set, season metadata, and production status can be mutated
 * between refreshes, so a re-pull can observe a newly-aired/changed/removed episode, a season
 * content edit, or a status flip.
 */
function showStub() {
	let detailCalls = 0;
	let inProduction = true;
	const season1 = { name: 'Season 1', overview: '', posterPath: null as string | null };
	const episodesBySeason: Record<number, EpisodeStub[]> = {
		1: [
			{
				episodeNumber: 1,
				name: 'E1',
				overview: '',
				airDate: '2026-01-01',
				runtime: 42,
				stillPath: null
			},
			{
				episodeNumber: 2,
				name: 'E2',
				overview: '',
				airDate: '2026-08-01',
				runtime: 42,
				stillPath: null
			}
		]
	};
	return {
		detailCalls: () => detailCalls,
		addEpisode(ep: { episodeNumber: number; airDate: string | null } & Partial<EpisodeStub>) {
			episodesBySeason[1].push({
				name: `E${ep.episodeNumber}`,
				overview: '',
				runtime: 42,
				stillPath: null,
				...ep
			});
		},
		updateEpisode(episodeNumber: number, patch: Partial<EpisodeStub>) {
			const ep = episodesBySeason[1].find((e) => e.episodeNumber === episodeNumber);
			if (!ep) throw new Error(`no stub episode ${episodeNumber}`);
			Object.assign(ep, patch);
		},
		removeEpisode(episodeNumber: number) {
			episodesBySeason[1] = episodesBySeason[1].filter((e) => e.episodeNumber !== episodeNumber);
		},
		updateSeason(patch: Partial<typeof season1>) {
			Object.assign(season1, patch);
		},
		endProduction() {
			inProduction = false;
		},
		client: {
			async getDetails(type: 'movie' | 'show', id: number): Promise<MediaDetail> {
				detailCalls++;
				return {
					...movieDefaults,
					tmdbId: id,
					type: 'show',
					title: 'Airing Show',
					inProduction,
					status: inProduction ? 'Returning Series' : 'Ended',
					firstAirDate: '2026-01-01',
					lastAirDate: '2026-01-01',
					seasons: [
						{
							seasonNumber: 1,
							name: season1.name,
							episodeCount: episodesBySeason[1].length,
							airDate: '2026-01-01',
							posterPath: season1.posterPath,
							overview: season1.overview
						}
					]
				};
			},
			async getSeason(_showId: number, seasonNumber: number): Promise<SeasonDetail> {
				return {
					seasonNumber,
					name: `Season ${seasonNumber}`,
					episodes: (episodesBySeason[seasonNumber] ?? []).map((e) => ({
						episodeNumber: e.episodeNumber,
						name: e.name,
						airDate: e.airDate,
						overview: e.overview,
						stillPath: e.stillPath,
						runtime: e.runtime
					}))
				};
			}
		}
	};
}

describe('parseTmdbExternalId', () => {
	it('parses movie/show external ids', () => {
		expect(parseTmdbExternalId('movie/603')).toEqual({ type: 'movie', tmdbId: 603 });
		expect(parseTmdbExternalId('show/1396')).toEqual({ type: 'show', tmdbId: 1396 });
	});

	it('rejects anything malformed', () => {
		expect(parseTmdbExternalId('603')).toBeNull();
		expect(parseTmdbExternalId('movie/abc')).toBeNull();
		expect(parseTmdbExternalId('person/1')).toBeNull();
		expect(parseTmdbExternalId('')).toBeNull();
	});
});

describe('needsRefresh', () => {
	const base = { type: 'show' as const, status: 'Returning Series', inProduction: true };
	it('always refreshes a pre-relational row (refreshedAt 0)', () => {
		expect(needsRefresh({ ...base, refreshedAt: 0 } as never, T0)).toBe(true);
	});
	it('never refreshes a released movie', () => {
		const released = { type: 'movie' as const, releaseDate: '2020-01-01', refreshedAt: T0 };
		expect(needsRefresh(released as never, T0 + 5e9)).toBe(false);
	});
	it('refreshes an unreleased movie only past the TTL (MRQ-128)', () => {
		const future = { type: 'movie' as const, releaseDate: '2030-01-01', refreshedAt: T0 };
		expect(needsRefresh(future as never, T0 + 1000)).toBe(false);
		expect(needsRefresh(future as never, T0 + 13 * 3600_000)).toBe(true);
	});
	it('treats an undated movie as unreleased (refreshes past the TTL)', () => {
		const undated = { type: 'movie' as const, releaseDate: null, refreshedAt: T0 };
		expect(needsRefresh(undated as never, T0 + 13 * 3600_000)).toBe(true);
	});
	it('refreshes an airing show only past the TTL', () => {
		expect(needsRefresh({ ...base, refreshedAt: T0 } as never, T0 + 1000)).toBe(false);
		expect(needsRefresh({ ...base, refreshedAt: T0 } as never, T0 + 13 * 3600_000)).toBe(true);
	});
	it('never refreshes a finished show', () => {
		const ended = { type: 'show' as const, status: 'Ended', inProduction: false };
		expect(needsRefresh({ ...ended, refreshedAt: T0 } as never, T0 + 5e9)).toBe(false);
	});
});

describe('refreshMedia', () => {
	it('fetches from TMDB and stores a linked movie row keyed by our id', async () => {
		const db = createTestDb();
		const { client, detailCalls } = movieStub();
		const row = await refreshMedia(db, client, 'tmdb', 'movie/603', T0);
		expect(row).toMatchObject({
			id: mediaId('tmdb', 'movie/603'),
			provider: 'tmdb',
			externalId: 'movie/603',
			source: 'linked',
			type: 'movie',
			title: 'The Matrix',
			titleNormalized: 'the matrix', // JS-folded for the degraded search (MRQ-141)
			backdropPath: '/backdrop.jpg',
			releaseDate: '1999-03-31',
			version: 1,
			refreshedAt: T0
		});
		expect(detailCalls()).toBe(1);
	});

	it('serves a cached movie without hitting TMDB again', async () => {
		const db = createTestDb();
		const { client, detailCalls } = movieStub();
		await refreshMedia(db, client, 'tmdb', 'movie/603', T0);
		await refreshMedia(db, client, 'tmdb', 'movie/603', T0 + 5e9);
		expect(detailCalls()).toBe(1);
	});

	it('stores seasons + episodes (with air dates) for a show', async () => {
		const db = createTestDb();
		const { client } = showStub();
		const row = await refreshMedia(db, client, 'tmdb', 'show/1396', T0);
		const id = row!.id;
		expect(row).toMatchObject({ type: 'show', status: 'Returning Series', inProduction: true });

		const seasonRows = await db.select().from(seasons).where(eq(seasons.mediaId, id));
		expect(seasonRows).toHaveLength(1);
		expect(seasonRows[0]).toMatchObject({ seasonNumber: 1, episodeCount: 2 });

		const episodeRows = await db.select().from(episodes).where(eq(episodes.mediaId, id));
		expect(episodeRows.map((e) => [e.seasonNumber, e.episodeNumber, e.airDate])).toEqual([
			[1, 1, '2026-01-01'],
			[1, 2, '2026-08-01']
		]);
	});

	it('persists every episode of a large show across insert chunks', async () => {
		// D1 caps a query at 100 bound params, so episode inserts are chunked; verify a show with
		// more episodes than one chunk still stores them all.
		const db = createTestDb();
		const stub = showStub();
		for (let n = 3; n <= 40; n++) stub.addEpisode({ episodeNumber: n, airDate: '2026-01-01' });
		const row = await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0);
		const episodeRows = await db.select().from(episodes).where(eq(episodes.mediaId, row!.id));
		expect(episodeRows).toHaveLength(40);
	});

	it('within the TTL, returns the cached show without re-fetching', async () => {
		const db = createTestDb();
		const stub = showStub();
		await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0);
		await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0 + 1000);
		expect(stub.detailCalls()).toBe(1);
	});

	it('past the TTL, re-pulls and bumps version when a new episode aired', async () => {
		const db = createTestDb();
		const stub = showStub();
		const id = mediaId('tmdb', 'show/1396');
		const first = await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0);
		expect(first!.version).toBe(1);

		stub.addEpisode({ episodeNumber: 3, airDate: '2026-09-01' });
		const second = await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0 + 13 * 3600_000);
		expect(stub.detailCalls()).toBe(2);
		expect(second!.version).toBe(2);
		const episodeRows = await db.select().from(episodes).where(eq(episodes.mediaId, id));
		expect(episodeRows).toHaveLength(3);
	});

	it('past the TTL, re-pulls but keeps version when nothing changed', async () => {
		const db = createTestDb();
		const stub = showStub();
		await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0);
		const second = await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0 + 13 * 3600_000);
		expect(stub.detailCalls()).toBe(2);
		expect(second!.version).toBe(1);
	});

	it('writes nothing to episodes/seasons when nothing changed past the TTL', async () => {
		const db = createTestDb();
		const stub = showStub();
		await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0);

		const writes = trackWrites(db);
		await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0 + 13 * 3600_000);

		expect(writes.filter((w) => w.table === 'episodes' || w.table === 'seasons')).toEqual([]);
	});

	it('updates only the changed episode row, leaving others untouched', async () => {
		const db = createTestDb();
		const stub = showStub();
		const id = mediaId('tmdb', 'show/1396');
		await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0);
		stub.updateEpisode(2, { airDate: '2026-08-15', name: 'E2 renamed' });

		const writes = trackWrites(db);
		const second = await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0 + 13 * 3600_000);

		expect(second!.version).toBe(2);
		expect(writes.filter((w) => w.table === 'episodes')).toHaveLength(1);
		expect(writes.filter((w) => w.table === 'seasons')).toEqual([]);

		const rows = await db.select().from(episodes).where(eq(episodes.mediaId, id));
		expect(rows.find((r) => r.episodeNumber === 2)).toMatchObject({
			airDate: '2026-08-15',
			name: 'E2 renamed'
		});
		expect(rows.find((r) => r.episodeNumber === 1)).toMatchObject({
			airDate: '2026-01-01',
			name: 'E1'
		});
	});

	it('inserts a new episode without rewriting unchanged existing episodes', async () => {
		const db = createTestDb();
		const stub = showStub();
		await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0);
		stub.addEpisode({ episodeNumber: 3, airDate: '2026-09-01' });

		const writes = trackWrites(db);
		await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0 + 13 * 3600_000);

		// One insert statement carries just the new row (chunked upserts only ever contain
		// rows that are new or changed).
		expect(writes.filter((w) => w.table === 'episodes')).toHaveLength(1);
	});

	it('deletes an episode that disappeared upstream', async () => {
		const db = createTestDb();
		const stub = showStub();
		const id = mediaId('tmdb', 'show/1396');
		await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0);
		stub.removeEpisode(2);

		const second = await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0 + 13 * 3600_000);

		expect(second!.version).toBe(2);
		const rows = await db.select().from(episodes).where(eq(episodes.mediaId, id));
		expect(rows.map((r) => r.episodeNumber)).toEqual([1]);
	});

	it('deletes a season that disappeared upstream, and its episodes with it', async () => {
		// The stub only ever reports season 1, so seed a season 2 (+ an episode under it) directly to
		// simulate a stored season that TMDB no longer lists — there's no FK cascade from `seasons` to
		// `episodes` (both just reference `media`), so the diff must delete both explicitly.
		const db = createTestDb();
		const stub = showStub();
		const id = mediaId('tmdb', 'show/1396');
		await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0);
		await db.insert(seasons).values({
			mediaId: id,
			seasonNumber: 2,
			name: 'Season 2',
			overview: '',
			airDate: '2026-06-01',
			posterPath: null,
			episodeCount: 1
		});
		await db.insert(episodes).values({
			mediaId: id,
			seasonNumber: 2,
			episodeNumber: 1,
			name: 'S2E1',
			overview: '',
			airDate: '2026-06-01',
			runtime: 42,
			stillPath: null
		});

		const second = await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0 + 13 * 3600_000);

		expect(second!.version).toBe(2);
		const seasonRows = await db.select().from(seasons).where(eq(seasons.mediaId, id));
		expect(seasonRows.map((r) => r.seasonNumber)).toEqual([1]);
		const episodeRows = await db.select().from(episodes).where(eq(episodes.mediaId, id));
		expect(episodeRows.map((r) => [r.seasonNumber, r.episodeNumber])).toEqual([
			[1, 1],
			[1, 2]
		]);
	});

	it('upserts only the changed season, leaving episodes untouched', async () => {
		const db = createTestDb();
		const stub = showStub();
		await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0);
		stub.updateSeason({ overview: 'New synopsis' });

		const writes = trackWrites(db);
		const second = await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0 + 13 * 3600_000);

		expect(second!.version).toBe(2);
		expect(writes.filter((w) => w.table === 'episodes')).toEqual([]);
		expect(writes.filter((w) => w.table === 'seasons')).toHaveLength(1);
	});

	it('returns null for an unknown provider or malformed id without calling TMDB', async () => {
		const db = createTestDb();
		const { client, detailCalls } = movieStub();
		expect(await refreshMedia(db, client, 'tmdb', 'nope', T0)).toBeNull();
		// @ts-expect-error — exercising an unknown provider guard
		expect(await refreshMedia(db, client, 'omdb', 'movie/603', T0)).toBeNull();
		expect(detailCalls()).toBe(0);
	});
});

describe('refreshMedia — reconciles trackers, the reported bug fixed at its source', () => {
	it('resolves a show to completed on its very first hydrate, from watches recorded before any episode data existed', async () => {
		const db = createTestDb();
		const id = mediaId('tmdb', 'show/1396');
		// The tracking row + watches exist before this title has ever been hydrated server-side —
		// e.g. a bulk "mark watched" seeded from season summaries, pushed before the media channel
		// caught up.
		await seedTracker(db, id, 'watching');
		await markWatched(db, id, 1, 1);

		// A finished, single-episode season — no announced-but-unaired episode, so "caught up" really
		// does mean "completed" (see the still-airing case in the next test for the other shape).
		const stub = showStub();
		stub.removeEpisode(2);
		stub.endProduction();
		await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0);

		expect(await trackerStatus(db, id)).toBe('completed');
	});

	it('leaves a caught-up show watching, not completed, when an announced episode has not aired yet', async () => {
		const db = createTestDb();
		const id = mediaId('tmdb', 'show/1396');
		await seedTracker(db, id, 'watching');
		await markWatched(db, id, 1, 1);

		// showStub's default season has s1e2 airing in the future ('2026-08-01' > T0) — caught up on
		// what's aired, but the show isn't finished, so this must stay `watching` (isStillAiring).
		const stub = showStub();
		await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0);

		expect(await trackerStatus(db, id)).toBe('watching');
	});

	it('demotes a completed tracker when an already-known episode simply finishes airing (no TMDB content change)', async () => {
		const db = createTestDb();
		const id = mediaId('tmdb', 'show/1396');
		const stub = showStub();
		await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0);

		await seedTracker(db, id, 'completed');
		await markWatched(db, id, 1, 1);
		// s1e2 ('2026-08-01') hasn't aired as of T0, so 'completed' (watched every *aired* episode)
		// is the correct state to start from.
		expect(await trackerStatus(db, id)).toBe('completed');

		// Past the TTL, s1e2 has now aired — TMDB's content is byte-for-byte the same as before, so
		// `version` doesn't bump, but the reconcile trigger isn't gated on that: only today's date
		// needed to move for s1e2 to count as aired-and-unwatched.
		const second = await refreshMedia(
			db,
			stub.client,
			'tmdb',
			'show/1396',
			Date.UTC(2026, 7, 2) // 2026-08-02, past s1e2's air date and the 12h TTL
		);
		expect(second!.version).toBe(1); // content itself didn't change

		expect(await trackerStatus(db, id)).toBe('watching');
	});

	it('demotes a completed tracker back to watching when new content actually changes (a new season)', async () => {
		const db = createTestDb();
		const id = mediaId('tmdb', 'show/1396');
		const stub = showStub();
		await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0);

		await seedTracker(db, id, 'completed');
		await markWatched(db, id, 1, 1);
		expect(await trackerStatus(db, id)).toBe('completed');

		// A new, already-aired episode appears — genuine content change, so `changed` is true and
		// the reconcile trigger fires.
		stub.addEpisode({ episodeNumber: 3, airDate: '2026-01-15' });
		const second = await refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0 + 13 * 3600_000);
		expect(second!.version).toBe(2);

		expect(await trackerStatus(db, id)).toBe('watching');
	});

	it('does not reconcile when nothing tracks the show', async () => {
		const db = createTestDb();
		const stub = showStub();
		await expect(refreshMedia(db, stub.client, 'tmdb', 'show/1396', T0)).resolves.toBeTruthy();
	});
});
