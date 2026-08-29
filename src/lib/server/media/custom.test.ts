import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '$lib/server/db/test-db';
import { episodes, media, people, seasons, tracking, users } from '$lib/server/db/schema';
import { mediaId, type CreditRole, type MediaCredit } from '$lib/sync/events';
import type { ValidatedCustomMedia } from '$lib/sync/media-protocol';
import type { MediaDetail, SeasonDetail } from '$lib/server/tmdb';
import { loadCredits } from './credits';
import { storeCustomMedia } from './custom';
import { resolveMediaSync } from './sync';

type Db = ReturnType<typeof createTestDb>;

const USER = 'u1';
const OTHER = 'u2';
const T0 = 1_000_000_000_000;
const CUSTOM_ID = '33333333-3333-4333-8333-333333333333';
const PERSON_A = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const PERSON_B = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';

type PushedCredit = ValidatedCustomMedia['credits'][number];

/** A credit as the author's own client sends it: a name they typed, no provider identity. */
function credit(
	personId: string,
	name: string,
	role: CreditRole,
	over: Partial<Omit<MediaCredit, 'externalId' | 'profilePath'>> = {}
): PushedCredit {
	return {
		personId,
		externalId: null,
		name,
		profilePath: null,
		role,
		character: null,
		sortOrder: 0,
		...over
	};
}

/** A TMDB client that must never be reached — custom media has nothing to hydrate from. */
const noTmdb = {
	async getDetails(): Promise<MediaDetail> {
		throw new Error('TMDB must not be consulted for custom media');
	},
	async getSeason(): Promise<SeasonDetail> {
		throw new Error('TMDB must not be consulted for custom media');
	}
};

function push(over: Partial<ValidatedCustomMedia> = {}): ValidatedCustomMedia {
	return {
		id: CUSTOM_ID,
		provider: 'local',
		externalId: null,
		source: 'custom',
		type: 'movie',
		title: 'Midnight Cassette Club',
		year: 1986,
		posterPath: null,
		backdropPath: null,
		overview: 'A film nobody catalogued.',
		genres: [],
		releaseDate: null,
		status: null,
		inProduction: null,
		firstAirDate: null,
		lastAirDate: null,
		version: 0,
		seasons: null,
		episodes: null,
		credits: [] as MediaCredit[],
		editedAt: T0,
		...over
	} as ValidatedCustomMedia;
}

/** The show variant: two seasons of two episodes, dated in the past so they read as aired. */
function showPush(over: Partial<ValidatedCustomMedia> = {}): ValidatedCustomMedia {
	return push({
		type: 'show',
		inProduction: false,
		seasons: [1, 2].map((n) => ({
			seasonNumber: n,
			name: `Season ${n}`,
			overview: '',
			airDate: '1986-01-01',
			posterPath: null,
			episodeCount: 2
		})),
		episodes: [1, 2].flatMap((s) =>
			[1, 2].map((e) => ({
				season: s,
				episode: e,
				name: '',
				overview: '',
				airDate: '1986-01-01',
				runtime: null,
				stillPath: null
			}))
		),
		...over
	});
}

async function track(db: Db, userId: string, id: string): Promise<void> {
	await db.insert(tracking).values({
		id: `${userId}::${id}`,
		userId,
		mediaId: id,
		addedAt: new Date(T0),
		updatedAt: new Date(T0)
	});
}

async function row(db: Db, id: string) {
	const [r] = await db.select().from(media).where(eq(media.id, id));
	return r;
}

let db: Db;
beforeEach(async () => {
	db = createTestDb();
	await db.insert(users).values([
		{ id: USER, email: 'u1@test.dev', status: 'enabled' },
		{ id: OTHER, email: 'u2@test.dev', status: 'enabled' }
	]);
});

describe('storeCustomMedia', () => {
	it('stores a record the user references, stamped with its owner', async () => {
		const stored = await storeCustomMedia(db, USER, [push()], new Set([CUSTOM_ID]));
		expect(stored).toEqual([CUSTOM_ID]);
		expect(await row(db, CUSTOM_ID)).toMatchObject({
			source: 'custom',
			provider: 'local',
			externalId: null,
			ownerUserId: USER,
			title: 'Midnight Cassette Club',
			// Stored at 1 even though the client minted it at 0 — that gap is what makes the client
			// pull its own record back and stop treating it as unsynced.
			version: 1,
			updatedAt: T0
		});
	});

	it('folds the title for the degraded search the same way hydration does', async () => {
		await storeCustomMedia(db, USER, [push({ title: 'ÉCLAIR' })], new Set([CUSTOM_ID]));
		expect((await row(db, CUSTOM_ID)).titleNormalized).toBe('éclair');
	});

	it('drops a record the user does not reference', async () => {
		expect(await storeCustomMedia(db, USER, [push()], new Set())).toEqual([]);
		expect(await row(db, CUSTOM_ID)).toBeUndefined();
	});

	it('refuses to overwrite a shared provider-backed row', async () => {
		const shared = mediaId('tmdb', 'movie/603');
		await db.insert(media).values({
			id: shared,
			provider: 'tmdb',
			externalId: 'movie/603',
			source: 'linked',
			type: 'movie',
			title: 'The Real Title',
			version: 3,
			refreshedAt: T0
		});
		const stored = await storeCustomMedia(
			db,
			USER,
			[push({ id: shared, title: 'hijacked' })],
			new Set([shared])
		);
		expect(stored).toEqual([]);
		expect(await row(db, shared)).toMatchObject({
			title: 'The Real Title',
			source: 'linked',
			ownerUserId: null
		});
	});

	it("refuses to overwrite another account's private row", async () => {
		await storeCustomMedia(db, OTHER, [push()], new Set([CUSTOM_ID]));
		const stored = await storeCustomMedia(
			db,
			USER,
			[push({ title: 'hijacked', editedAt: T0 + 5000 })],
			new Set([CUSTOM_ID])
		);
		expect(stored).toEqual([]);
		expect(await row(db, CUSTOM_ID)).toMatchObject({
			title: 'Midnight Cassette Club',
			ownerUserId: OTHER
		});
	});

	it('writes a show as seasons and episodes', async () => {
		await storeCustomMedia(db, USER, [showPush()], new Set([CUSTOM_ID]));
		expect(await db.select().from(seasons).where(eq(seasons.mediaId, CUSTOM_ID))).toHaveLength(2);
		const eps = await db.select().from(episodes).where(eq(episodes.mediaId, CUSTOM_ID));
		expect(eps).toHaveLength(4);
		// Past air dates are what make a synthesized episode watchable at all (see `isAired`).
		expect(eps.every((e) => e.airDate === '1986-01-01')).toBe(true);
	});

	it('bumps the version on a real edit and leaves it alone on a no-op push', async () => {
		await storeCustomMedia(db, USER, [showPush()], new Set([CUSTOM_ID]));
		expect((await row(db, CUSTOM_ID)).version).toBe(1);

		await storeCustomMedia(db, USER, [showPush({ editedAt: T0 + 1 })], new Set([CUSTOM_ID]));
		expect((await row(db, CUSTOM_ID)).version).toBe(1); // nothing actually changed

		await storeCustomMedia(
			db,
			USER,
			[showPush({ title: 'Renamed', editedAt: T0 + 2 })],
			new Set([CUSTOM_ID])
		);
		expect(await row(db, CUSTOM_ID)).toMatchObject({ title: 'Renamed', version: 2 });
	});

	it('reconciles a season removed by a later edit', async () => {
		await storeCustomMedia(db, USER, [showPush()], new Set([CUSTOM_ID]));
		const oneSeason = showPush({ editedAt: T0 + 1 });
		oneSeason.seasons = oneSeason.seasons!.slice(0, 1);
		oneSeason.episodes = oneSeason.episodes!.filter((e) => e.season === 1);
		await storeCustomMedia(db, USER, [oneSeason], new Set([CUSTOM_ID]));

		expect(await db.select().from(seasons).where(eq(seasons.mediaId, CUSTOM_ID))).toHaveLength(1);
		expect(await db.select().from(episodes).where(eq(episodes.mediaId, CUSTOM_ID))).toHaveLength(2);
		expect((await row(db, CUSTOM_ID)).version).toBe(2);
	});

	it('stores the people the author credited, owner-scoped, and reconciles a later edit', async () => {
		const director = credit(PERSON_A, 'Renata Voss', 'director');
		const lead = credit(PERSON_B, 'Tomas Ilie', 'cast', { character: 'The Courier' });
		await storeCustomMedia(db, USER, [push({ credits: [director, lead] })], new Set([CUSTOM_ID]));

		expect(await db.select().from(people).where(eq(people.ownerUserId, USER))).toHaveLength(2);
		expect(await loadCredits(db, CUSTOM_ID)).toMatchObject([
			{ name: 'Tomas Ilie', role: 'cast', character: 'The Courier', externalId: null },
			{ name: 'Renata Voss', role: 'director' }
		]);

		// A later edit drops the lead — the credit goes, the person row stays (another entry may
		// credit them), exactly as the provider path behaves.
		await storeCustomMedia(
			db,
			USER,
			[push({ credits: [director], editedAt: T0 + 1 })],
			new Set([CUSTOM_ID])
		);
		expect((await loadCredits(db, CUSTOM_ID)).map((c) => c.role)).toEqual(['director']);
		expect(await db.select().from(people).where(eq(people.id, PERSON_B))).toHaveLength(1);
		expect((await row(db, CUSTOM_ID)).version).toBe(2);
	});

	it('treats a credit change alone as an edit worth a new version', async () => {
		await storeCustomMedia(
			db,
			USER,
			[push({ credits: [credit(PERSON_A, 'Renata Voss', 'director')] })],
			new Set([CUSTOM_ID])
		);
		await storeCustomMedia(
			db,
			USER,
			[push({ credits: [credit(PERSON_A, 'Renata Voss', 'producer')], editedAt: T0 + 1 })],
			new Set([CUSTOM_ID])
		);
		expect((await row(db, CUSTOM_ID)).version).toBe(2);
	});

	it('drops a credit naming a person the pusher may not write', async () => {
		// The other account's private person. Its id is the client's to mint, so a push can name it —
		// and must neither rewrite the row nor end up crediting somebody else's name on this entry.
		await db
			.insert(people)
			.values({ id: PERSON_A, provider: 'local', ownerUserId: OTHER, name: 'Theirs' });

		await storeCustomMedia(
			db,
			USER,
			[push({ credits: [credit(PERSON_A, 'Mine Now', 'director')] })],
			new Set([CUSTOM_ID])
		);

		expect(await loadCredits(db, CUSTOM_ID)).toEqual([]);
		expect((await db.select().from(people).where(eq(people.id, PERSON_A)))[0]).toMatchObject({
			name: 'Theirs',
			ownerUserId: OTHER
		});
	});

	it('lets a newer stored edit win over an older push, and still reports it settled', async () => {
		await storeCustomMedia(
			db,
			USER,
			[push({ title: 'newer', editedAt: T0 + 100 })],
			new Set([CUSTOM_ID])
		);
		// An older edit arrives late from a second device; LWW keeps the newer copy. It's reported as
		// stored so the sender stops queueing it — the winning copy comes back on the version diff.
		const stored = await storeCustomMedia(
			db,
			USER,
			[push({ title: 'older', editedAt: T0 })],
			new Set([CUSTOM_ID])
		);
		expect(stored).toEqual([CUSTOM_ID]);
		expect((await row(db, CUSTOM_ID)).title).toBe('newer');
	});
});

describe('resolveMediaSync with custom media', () => {
	it('stores a pushed record and returns it in the same response', async () => {
		await track(db, USER, CUSTOM_ID);
		const res = await resolveMediaSync(
			db,
			noTmdb,
			USER,
			{ refs: [], have: [{ id: CUSTOM_ID, version: 0 }], custom: [showPush()] },
			T0
		);
		expect(res.storedCustom).toEqual([CUSTOM_ID]);
		expect(res.media).toHaveLength(1);
		expect(res.media[0]).toMatchObject({ id: CUSTOM_ID, source: 'custom', version: 1 });
		expect(res.media[0].episodes).toHaveLength(4);
	});

	it('recovers a custom entry on a device that has only the tracking row', async () => {
		await track(db, USER, CUSTOM_ID);
		await resolveMediaSync(db, noTmdb, USER, { refs: [], have: [], custom: [push()] }, T0);
		// A fresh device: the event log gave it the tracking row, it has no media row, so it asks at
		// version 0 and the owner-scoped copy comes back. No TMDB call is possible for such a title.
		const res = await resolveMediaSync(
			db,
			noTmdb,
			USER,
			{ refs: [], have: [{ id: CUSTOM_ID, version: 0 }] },
			T0
		);
		expect(res.media.map((m) => m.id)).toEqual([CUSTOM_ID]);
	});

	it('reports nothing stored for a record the user does not track', async () => {
		const res = await resolveMediaSync(
			db,
			noTmdb,
			USER,
			{ refs: [], have: [], custom: [push()] },
			T0
		);
		expect(res.storedCustom).toEqual([]);
		expect(await row(db, CUSTOM_ID)).toBeUndefined();
	});
});
