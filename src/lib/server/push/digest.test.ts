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

/** Seed an additional episode on an already-inserted show (no media/tracking re-insert). */
async function seedEpisode(
	db: Db,
	mediaId: string,
	season: number,
	episode: number,
	airDate: string
): Promise<void> {
	await db
		.insert(episodes)
		.values({ mediaId, seasonNumber: season, episodeNumber: episode, airDate });
}

async function seedShow(
	db: Db,
	mediaId: string,
	title: string,
	externalId: string,
	status: TrackingStatus
): Promise<void> {
	await db.insert(media).values({ id: mediaId, type: 'show', title, externalId });
	await db.insert(tracking).values({ id: `${USER}::${mediaId}`, userId: USER, mediaId, status });
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

	it('groups multiple new episodes of one show into a single push', async () => {
		await seedSub(db, 'https://push.example/ep-1', MADRID);
		await seedShow(db, SHOW, 'Breaking Bad', 'show/1396', 'watching');
		await seedEpisode(db, SHOW, 2, 1, '2026-07-26');
		await seedEpisode(db, SHOW, 2, 2, '2026-07-27');
		await seedEpisode(db, SHOW, 2, 3, '2026-07-27');
		const { sender, calls } = fakeSender();

		const result = await sendNewReleaseDigest(db, {} as Env, NOW, sender);
		expect(result).toEqual({ dueUsers: 1, sent: 1, pruned: 0 });
		expect(calls).toHaveLength(1);
		expect(calls[0].payload).toMatchObject({
			title: 'Breaking Bad',
			body: '3 new episodes',
			url: '/title/show/1396'
		});
		// Every underlying episode is logged individually, so a later run's dedupe is per-episode.
		const logged = await db.select().from(notificationLog).where(eq(notificationLog.userId, USER));
		expect(logged).toHaveLength(3);

		const second = await sendNewReleaseDigest(db, {} as Env, NOW, sender);
		expect(second).toEqual({ dueUsers: 1, sent: 0, pruned: 0 });
		expect(calls).toHaveLength(1);
	});

	it('collapses releases across multiple shows into one summary push', async () => {
		await seedSub(db, 'https://push.example/ep-1', MADRID);
		await seedShow(db, SHOW, 'Breaking Bad', 'show/1396', 'watching');
		await seedEpisode(db, SHOW, 2, 1, '2026-07-27');
		await seedShow(db, 'media-show-2', 'Better Call Saul', 'show/60059', 'want_to_watch');
		await seedEpisode(db, 'media-show-2', 1, 1, '2026-07-27');
		const { sender, calls } = fakeSender();

		const result = await sendNewReleaseDigest(db, {} as Env, NOW, sender);
		expect(result).toEqual({ dueUsers: 1, sent: 1, pruned: 0 });
		expect(calls).toHaveLength(1);
		expect(calls[0].payload).toMatchObject({
			title: 'New releases',
			body: '2 new releases across 2 titles',
			url: '/'
		});
		const logged = await db.select().from(notificationLog).where(eq(notificationLog.userId, USER));
		expect(logged).toHaveLength(2);
	});

	it('falls back to the rich single-episode form once a group shrinks to one fresh item', async () => {
		await seedSub(db, 'https://push.example/ep-1', MADRID);
		await seedShow(db, SHOW, 'Breaking Bad', 'show/1396', 'watching');
		await seedEpisode(db, SHOW, 2, 1, '2026-07-26');
		await seedEpisode(db, SHOW, 2, 2, '2026-07-27');
		const { sender: firstSender } = fakeSender();
		await sendNewReleaseDigest(db, {} as Env, NOW, firstSender);

		// A third episode airs later the same day, still within the grace window.
		await seedEpisode(db, SHOW, 2, 3, '2026-07-27');
		const { sender, calls } = fakeSender();
		const result = await sendNewReleaseDigest(db, {} as Env, NOW, sender);
		expect(result).toEqual({ dueUsers: 1, sent: 1, pruned: 0 });
		expect(calls[0].payload).toMatchObject({
			title: 'Breaking Bad',
			body: 'Season 2, Episode 3 is out',
			url: '/title/show/1396'
		});
	});

	it('does not repeat a grouped push the next day when one more episode lands', async () => {
		await seedSub(db, 'https://push.example/ep-1', MADRID);
		await seedShow(db, SHOW, 'Breaking Bad', 'show/1396', 'watching');
		await seedEpisode(db, SHOW, 2, 1, '2026-07-26');
		await seedEpisode(db, SHOW, 2, 2, '2026-07-27');
		await seedEpisode(db, SHOW, 2, 3, '2026-07-27');
		const day1 = await sendNewReleaseDigest(db, {} as Env, NOW, fakeSender().sender);
		expect(day1).toEqual({ dueUsers: 1, sent: 1, pruned: 0 });

		// Next day, 9AM Madrid again; episode 4 airs today, 1-3 are still within GRACE_DAYS=2
		// and so are re-candidates from findReleases, but the ledger must exclude them.
		await seedEpisode(db, SHOW, 2, 4, '2026-07-28');
		const NEXT_DAY = new Date('2026-07-28T07:00:00Z');
		const { sender, calls } = fakeSender();
		const day2 = await sendNewReleaseDigest(db, {} as Env, NEXT_DAY, sender);

		expect(day2).toEqual({ dueUsers: 1, sent: 1, pruned: 0 });
		expect(calls).toHaveLength(1);
		expect(calls[0].payload).toMatchObject({
			title: 'Breaking Bad',
			body: 'Season 2, Episode 4 is out',
			url: '/title/show/1396'
		});
		const logged = await db.select().from(notificationLog).where(eq(notificationLog.userId, USER));
		expect(logged).toHaveLength(4);
	});
});
