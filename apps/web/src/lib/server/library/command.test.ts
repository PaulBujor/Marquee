import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDb } from '#lib/server/db/test-db.js';
import { episodeWatches, episodes, media, tracking, users } from '#lib/server/db/schema.js';
import { trackingKey } from '#lib/sync/events.js';
import {
	UnknownMediaError,
	applyLibraryCommand,
	libraryCommandSchema,
	type LibraryCommand
} from './command';

type Db = ReturnType<typeof createTestDb>;

const U1 = 'user-1';
const U2 = 'user-2';
const MOVIE = 'movie-1';
const SHOW = 'show-1';
const AIRED = '2000-01-01';
const UNAIRED = '2999-01-01';

async function seed(db: Db): Promise<void> {
	for (const id of [U1, U2]) {
		await db.insert(users).values({ id, email: `${id}@test.dev`, status: 'enabled' });
	}
	await db.insert(media).values([
		{ id: MOVIE, externalId: 'tmdb/movie/1', type: 'movie', title: 'A Movie' },
		{ id: SHOW, externalId: 'tmdb/tv/1', type: 'show', title: 'A Show' }
	]);
}

async function seedEpisode(
	db: Db,
	season: number,
	episode: number,
	airDate: string | null = AIRED
): Promise<void> {
	await db
		.insert(episodes)
		.values({ mediaId: SHOW, seasonNumber: season, episodeNumber: episode, airDate });
}

async function track(
	db: Db,
	userId: string,
	mediaId: string,
	over: Partial<typeof tracking.$inferInsert> = {}
): Promise<void> {
	await db.insert(tracking).values({
		id: trackingKey(userId, mediaId),
		userId,
		mediaId,
		...over
	});
}

/** The materialized state a command is supposed to produce. */
async function state(db: Db, userId: string, mediaId: string) {
	const [row] = await db
		.select()
		.from(tracking)
		.where(and(eq(tracking.userId, userId), eq(tracking.mediaId, mediaId)));
	const watches = await db
		.select()
		.from(episodeWatches)
		.where(and(eq(episodeWatches.userId, userId), eq(episodeWatches.mediaId, mediaId)));
	return {
		status: row?.status,
		favorite: row?.favorite,
		rating: row?.rating,
		removed: row?.removed,
		watched: watches
			.filter((w) => w.watched)
			.map((w) => `${w.season}x${w.episode}`)
			.sort()
	};
}

function run(db: Db, mediaId: string, command: LibraryCommand, userId = U1) {
	return applyLibraryCommand(db, userId, mediaId, command);
}

describe('applyLibraryCommand', () => {
	it('emits nothing when the command restates what is already true', async () => {
		const db = createTestDb();
		await seed(db);

		const first = await run(db, MOVIE, { status: 'completed' });
		const replay = await run(db, MOVIE, { status: 'completed' });

		expect(first.map((e) => e.type)).toEqual(['tracking.added']);
		expect(replay).toEqual([]);
		expect(await state(db, U1, MOVIE)).toMatchObject({ status: 'completed' });
	});

	it('emits only a rating event when only the rating changes', async () => {
		const db = createTestDb();
		await seed(db);
		await track(db, U1, MOVIE, { status: 'completed' });

		const events = await run(db, MOVIE, { rating: 4 });

		expect(events.map((e) => [e.type, e.payload])).toEqual([['tracking.rated', { rating: 4 }]]);
		expect(await state(db, U1, MOVIE)).toMatchObject({ status: 'completed', rating: 4 });
	});

	it('emits the clearing event when a rating is removed', async () => {
		const db = createTestDb();
		await seed(db);
		await track(db, U1, MOVIE, { status: 'completed', rating: 5 });

		const events = await run(db, MOVIE, { rating: null });

		expect(events.map((e) => [e.type, e.payload])).toEqual([['tracking.rated', { rating: null }]]);
		expect(await state(db, U1, MOVIE)).toMatchObject({ rating: null });
	});

	it('seeds one watched event per aired episode of a season, and replays as a no-op', async () => {
		const db = createTestDb();
		await seed(db);
		for (const episode of [1, 2, 3]) await seedEpisode(db, 1, episode);
		await seedEpisode(db, 1, 4, UNAIRED);
		await seedEpisode(db, 2, 1);

		const events = await run(db, SHOW, { season: { season: 1, watched: true } });
		const replay = await run(db, SHOW, { season: { season: 1, watched: true } });

		expect(events.filter((e) => e.type === 'episode.watched')).toHaveLength(3);
		// Not tracked yet, so a watch implies the title is being watched.
		expect(events.filter((e) => e.type === 'tracking.added')).toEqual([
			expect.objectContaining({ payload: { status: 'watching' } })
		]);
		expect(replay).toEqual([]);
		// The unaired episode and the other season are untouched.
		expect(await state(db, U1, SHOW)).toMatchObject({ watched: ['1x1', '1x2', '1x3'] });
	});

	it('only un-watches the episodes of a season that are actually watched', async () => {
		const db = createTestDb();
		await seed(db);
		await track(db, U1, SHOW, { status: 'watching' });
		for (const [season, episode] of [
			[1, 1],
			[1, 2],
			[2, 1]
		] as const) {
			await db.insert(episodeWatches).values({
				id: `${U1}::${SHOW}::s${season}e${episode}`,
				userId: U1,
				mediaId: SHOW,
				season,
				episode,
				watched: true
			});
		}

		const events = await run(db, SHOW, { season: { season: 1, watched: false } });

		expect(events.filter((e) => e.type === 'episode.unwatched')).toHaveLength(2);
		expect(await state(db, U1, SHOW)).toMatchObject({ watched: ['2x1'] });
	});

	it('emits nothing for an episode delta that repeats the stored state', async () => {
		const db = createTestDb();
		await seed(db);
		await track(db, U1, SHOW, { status: 'watching' });
		await seedEpisode(db, 1, 1);

		const first = await run(db, SHOW, { episodes: [{ season: 1, episode: 1, watched: true }] });
		const repeat = await run(db, SHOW, { episodes: [{ season: 1, episode: 1, watched: true }] });
		const neverWatched = await run(db, SHOW, {
			episodes: [{ season: 1, episode: 2, watched: false }]
		});

		expect(first.map((e) => e.type)).toEqual(['episode.watched']);
		expect(repeat).toEqual([]);
		expect(neverWatched).toEqual([]);
	});

	it('applies an independent mix of fields onto the projected state', async () => {
		const db = createTestDb();
		await seed(db);

		await run(db, MOVIE, { status: 'watching', favorite: true, rating: 3 });

		expect(await state(db, U1, MOVIE)).toMatchObject({
			status: 'watching',
			favorite: true,
			rating: 3,
			removed: false
		});
	});

	it('removes a title and clears its progress, once', async () => {
		const db = createTestDb();
		await seed(db);
		await track(db, U1, SHOW, { status: 'watching' });
		await seedEpisode(db, 1, 1);
		await run(db, SHOW, { episodes: [{ season: 1, episode: 1, watched: true }] });

		const events = await run(db, SHOW, { removed: true });
		const replay = await run(db, SHOW, { removed: true });

		expect(events.map((e) => e.type)).toEqual(['episode.unwatched', 'tracking.removed']);
		expect(replay).toEqual([]);
		expect(await state(db, U1, SHOW)).toMatchObject({ removed: true, watched: [] });
	});

	it('puts a removed title back on the list, keeping its status', async () => {
		const db = createTestDb();
		await seed(db);
		await track(db, U1, MOVIE, { status: 'completed', removed: true });

		const events = await run(db, MOVIE, { removed: false });

		expect(events.map((e) => e.type)).toEqual(['tracking.added']);
		expect(await state(db, U1, MOVIE)).toMatchObject({ status: 'completed', removed: false });
	});

	it('rejects a media id that does not exist', async () => {
		const db = createTestDb();
		await seed(db);

		await expect(run(db, 'no-such-title', { status: 'completed' })).rejects.toBeInstanceOf(
			UnknownMediaError
		);
	});

	it("treats another user's custom entry as one that does not exist", async () => {
		const db = createTestDb();
		await seed(db);
		await db.insert(media).values({
			id: 'custom-1',
			provider: 'local',
			source: 'custom',
			ownerUserId: U2,
			type: 'movie',
			title: 'Their Own'
		});

		await expect(run(db, 'custom-1', { status: 'completed' })).rejects.toBeInstanceOf(
			UnknownMediaError
		);
		expect(await state(db, U1, 'custom-1')).toMatchObject({ status: undefined });
	});

	it('writes nothing for a user who is not the caller', async () => {
		const db = createTestDb();
		await seed(db);

		await run(db, MOVIE, { status: 'completed' }, U1);

		expect(await state(db, U2, MOVIE)).toMatchObject({ status: undefined });
	});

	it('names the events it emitted as the caller’s own', async () => {
		const db = createTestDb();
		await seed(db);

		const [event] = await run(db, MOVIE, { status: 'completed' });

		expect(event).toMatchObject({ userId: U1, entityId: MOVIE, sequence: 1 });
	});
});

describe('libraryCommandSchema', () => {
	it('rejects values outside the vocabulary', () => {
		for (const bad of [
			{ rating: 0 },
			{ rating: 6 },
			{ rating: 9 },
			{ rating: 3.5 },
			{ status: 'dropped' },
			{ episodes: [{ season: 0, episode: 0, watched: true }] },
			{ episodes: [{ season: 1, episode: 1, watched: true, extra: 1 }] },
			{ season: { season: -1, watched: true } },
			{ unknown: true }
		]) {
			expect(libraryCommandSchema.safeParse(bad).success).toBe(false);
		}
	});

	it('accepts an independent subset of fields, including a clearing rating', () => {
		expect(libraryCommandSchema.safeParse({ rating: null }).success).toBe(true);
		expect(libraryCommandSchema.safeParse({ favorite: false, removed: true }).success).toBe(true);
		expect(libraryCommandSchema.safeParse({ season: { season: 0, watched: true } }).success).toBe(
			true
		);
	});
});
