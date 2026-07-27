import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '$lib/server/db/test-db';
import {
	emailChangeTokens,
	episodeWatches,
	events,
	loginTokens,
	media,
	notificationLog,
	pushSubscriptions,
	sessions,
	syncState,
	tracking,
	users,
	type User
} from '$lib/server/db/schema';
import { deleteAccount } from './index';

type Db = ReturnType<typeof createTestDb>;

const MEDIA_ID = 'media-1';
const future = new Date(Date.now() + 86_400_000);

/** Create a user and seed one row in every user-scoped table, so deletion has something to clear. */
async function seedUserWithData(db: Db, email: string): Promise<User> {
	await db.insert(users).values({ email, status: 'enabled' });
	const user = (await db.select().from(users).where(eq(users.email, email)))[0];
	const uid = user.id;

	await db.insert(sessions).values({ id: `sess-${uid}`, userId: uid, expiresAt: future });
	await db
		.insert(loginTokens)
		.values({ email, tokenHash: `hash-${uid}`, kind: 'code', expiresAt: future });
	await db
		.insert(emailChangeTokens)
		.values({ userId: uid, newEmail: `new-${email}`, tokenHash: `ech-${uid}`, expiresAt: future });
	await db.insert(events).values({
		id: `evt-${uid}`,
		userId: uid,
		sequence: 1,
		type: 'tracking.added',
		entityId: MEDIA_ID,
		payload: { status: 'want_to_watch' },
		deviceId: `dev-${uid}`,
		clientCreatedAt: Date.now()
	});
	await db.insert(syncState).values({ userId: uid, lastSequence: 1 });
	await db
		.insert(tracking)
		.values({ id: `${uid}::${MEDIA_ID}`, userId: uid, mediaId: MEDIA_ID, status: 'watching' });
	await db.insert(episodeWatches).values({
		id: `${uid}::${MEDIA_ID}::s1e1`,
		userId: uid,
		mediaId: MEDIA_ID,
		season: 1,
		episode: 1,
		watched: true,
		updatedAt: Date.now()
	});
	await db.insert(pushSubscriptions).values({
		userId: uid,
		endpoint: `https://push.example/${uid}`,
		p256dh: 'p',
		auth: 'a',
		deviceId: `dev-${uid}`
	});
	await db.insert(notificationLog).values({ id: `${uid}::${MEDIA_ID}::release`, userId: uid });

	return user;
}

/** Count of a user's remaining rows across every table deletion should clear (one per table). */
async function countUserRows(db: Db, user: User): Promise<number> {
	const uid = user.id;
	const counts = await Promise.all([
		db.select().from(emailChangeTokens).where(eq(emailChangeTokens.userId, uid)),
		db.select().from(sessions).where(eq(sessions.userId, uid)),
		db.select().from(events).where(eq(events.userId, uid)),
		db.select().from(syncState).where(eq(syncState.userId, uid)),
		db.select().from(tracking).where(eq(tracking.userId, uid)),
		db.select().from(episodeWatches).where(eq(episodeWatches.userId, uid)),
		db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, uid)),
		db.select().from(notificationLog).where(eq(notificationLog.userId, uid)),
		db.select().from(loginTokens).where(eq(loginTokens.email, user.email)),
		db.select().from(users).where(eq(users.id, uid))
	]);
	return counts.reduce((sum, rows) => sum + rows.length, 0);
}

let db: Db;
beforeEach(() => {
	db = createTestDb();
});

describe('deleteAccount', () => {
	it('removes every row the user owns, across all tables', async () => {
		const user = await seedUserWithData(db, 'me@x.com');
		expect(await countUserRows(db, user)).toBeGreaterThan(0);

		await deleteAccount(db, user);

		expect(await countUserRows(db, user)).toBe(0);
	});

	it("leaves another user's data completely untouched", async () => {
		const a = await seedUserWithData(db, 'a@x.com');
		const b = await seedUserWithData(db, 'b@x.com');

		await deleteAccount(db, a);

		expect(await countUserRows(db, a)).toBe(0);
		// Every one of B's rows survives (one per seeded table + the users row).
		expect(await countUserRows(db, b)).toBe(10);
	});

	it('keeps the shared (non-user-scoped) TMDB media cache', async () => {
		const user = await seedUserWithData(db, 'me@x.com');
		await db.insert(media).values({ id: MEDIA_ID, type: 'movie', title: 'Dune' });

		await deleteAccount(db, user);

		expect(await db.select().from(media).where(eq(media.id, MEDIA_ID))).toHaveLength(1);
	});
});
