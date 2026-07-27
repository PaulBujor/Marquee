import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '$lib/server/db/test-db';
import {
	episodes,
	media,
	notificationLog,
	pushSubscriptions,
	tracking,
	users
} from '$lib/server/db/schema';
import type { TrackingStatus } from '$lib/sync/events';
import type { PushPayload, PushResult, PushSender, PushTarget } from './index';
import { localDateHour, sendNewReleaseDigest } from './digest';

type Db = ReturnType<typeof createTestDb>;

// 07:00 UTC = 09:00 in Madrid (UTC+2 in July) — a user there is "due" this run.
const NOW = new Date('2026-07-27T07:00:00Z');
const MADRID = 'Europe/Madrid';
const USER = 'user-1';
const SHOW = 'media-show-1';

function fakeSender(gone = new Set<string>()): {
	sender: PushSender;
	calls: { endpoint: string; payload: PushPayload }[];
} {
	const calls: { endpoint: string; payload: PushPayload }[] = [];
	const sender: PushSender = {
		async send(target: PushTarget, payload: PushPayload): Promise<PushResult> {
			calls.push({ endpoint: target.endpoint, payload });
			return gone.has(target.endpoint)
				? { ok: false, status: 410, gone: true }
				: { ok: true, status: 201, gone: false };
		}
	};
	return { sender, calls };
}

async function seedSub(db: Db, endpoint: string, timezone: string | null): Promise<void> {
	await db.insert(pushSubscriptions).values({
		userId: USER,
		endpoint,
		p256dh: 'p256',
		auth: 'authsecret',
		deviceId: 'device-1',
		timezone,
		createdAt: NOW,
		lastUsedAt: NOW
	});
}

async function seedShowEpisode(db: Db, airDate: string, status: TrackingStatus): Promise<void> {
	await db
		.insert(media)
		.values({ id: SHOW, type: 'show', title: 'Breaking Bad', externalId: 'show/1396' });
	await db.insert(episodes).values({
		mediaId: SHOW,
		seasonNumber: 2,
		episodeNumber: 1,
		name: 'Seven Thirty-Seven',
		airDate
	});
	await db.insert(tracking).values({ id: `${USER}::${SHOW}`, userId: USER, mediaId: SHOW, status });
}

let db: Db;
beforeEach(async () => {
	db = createTestDb();
	await db.insert(users).values({ id: USER, email: 'u1@x.com', status: 'enabled' });
});

describe('localDateHour', () => {
	it('resolves the local hour + date for a timezone', () => {
		expect(localDateHour(NOW, MADRID)).toEqual({ date: '2026-07-27', hour: 9 });
		expect(localDateHour(NOW, 'America/New_York')).toEqual({ date: '2026-07-27', hour: 3 });
	});

	it('falls back to UTC on a bad timezone', () => {
		expect(localDateHour(NOW, 'Not/AZone')).toEqual({ date: '2026-07-27', hour: 7 });
		expect(localDateHour(NOW, null)).toEqual({ date: '2026-07-27', hour: 7 });
	});
});

describe('sendNewReleaseDigest', () => {
	it('pushes a newly-aired episode to a due user once, and logs it', async () => {
		await seedSub(db, 'https://push.example/ep-1', MADRID);
		await seedShowEpisode(db, '2026-07-27', 'watching');
		const { sender, calls } = fakeSender();

		const first = await sendNewReleaseDigest(db, {} as Env, NOW, sender);
		expect(first).toEqual({ dueUsers: 1, sent: 1, pruned: 0 });
		expect(calls[0].payload.url).toBe('/title/show/1396');
		expect(await db.select().from(notificationLog)).toHaveLength(1);

		// Ledger dedupe: a second run at the same hour sends nothing more.
		const second = await sendNewReleaseDigest(db, {} as Env, NOW, sender);
		expect(second).toEqual({ dueUsers: 1, sent: 0, pruned: 0 });
		expect(calls).toHaveLength(1);
	});

	it('skips a user for whom it is not 9AM local', async () => {
		await seedSub(db, 'https://push.example/ep-1', 'America/New_York'); // 03:00 local
		await seedShowEpisode(db, '2026-07-27', 'watching');
		const { sender, calls } = fakeSender();
		expect(await sendNewReleaseDigest(db, {} as Env, NOW, sender)).toEqual({
			dueUsers: 0,
			sent: 0,
			pruned: 0
		});
		expect(calls).toHaveLength(0);
	});

	it('ignores releases outside the grace window and non-active statuses', async () => {
		await seedSub(db, 'https://push.example/ep-1', MADRID);
		await seedShowEpisode(db, '2026-07-24', 'watching'); // 3 days ago, GRACE_DAYS=2
		expect((await sendNewReleaseDigest(db, {} as Env, NOW, fakeSender().sender)).sent).toBe(0);

		await db.update(tracking).set({ status: 'completed' });
		await db.update(episodes).set({ airDate: '2026-07-27' });
		expect((await sendNewReleaseDigest(db, {} as Env, NOW, fakeSender().sender)).sent).toBe(0);
	});

	it('prunes a subscription the push service reports gone', async () => {
		await seedSub(db, 'https://push.example/dead', MADRID);
		await seedShowEpisode(db, '2026-07-27', 'watching');
		const { sender } = fakeSender(new Set(['https://push.example/dead']));

		const result = await sendNewReleaseDigest(db, {} as Env, NOW, sender);
		expect(result).toMatchObject({ dueUsers: 1, sent: 0, pruned: 1 });
		expect(await db.select().from(pushSubscriptions)).toHaveLength(0);
		// Not delivered, so not logged — a live device next time still gets it.
		expect(await db.select().from(notificationLog)).toHaveLength(0);
	});

	it('notifies a movie released within the window', async () => {
		await seedSub(db, 'https://push.example/ep-1', MADRID);
		await db.insert(media).values({
			id: 'media-movie-1',
			type: 'movie',
			title: 'Dune',
			externalId: 'movie/438631',
			releaseDate: '2026-07-26'
		});
		await db.insert(tracking).values({
			id: `${USER}::media-movie-1`,
			userId: USER,
			mediaId: 'media-movie-1',
			status: 'want_to_watch'
		});
		const { sender, calls } = fakeSender();

		const result = await sendNewReleaseDigest(db, {} as Env, NOW, sender);
		expect(result.sent).toBe(1);
		expect(calls[0].payload).toMatchObject({
			title: 'Dune',
			body: 'Out now',
			url: '/title/movie/438631'
		});
		const logged = await db.select().from(notificationLog).where(eq(notificationLog.userId, USER));
		expect(logged[0].id).toBe(`${USER}::media-movie-1::release`);
	});
});
