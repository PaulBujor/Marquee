import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import {
	episodes as episodesTable,
	media as mediaTable,
	notificationLog,
	pushSubscriptions,
	tracking as trackingTable
} from '$lib/server/db/schema';
import { parseTmdbExternalId } from '$lib/server/media/hydrate';
import { createPushSender, type PushSender, type PushPayload } from './index';
import type { createDb } from '$lib/server/db';

type Db = ReturnType<typeof createDb>;

/** Notifications go out at 9AM the user's local time. */
export const SEND_HOUR = 9;
/** How many days back a release still counts as "new" — covers a missed run / late-day airs without
 *  back-filling a whole back catalogue when a long-running show is newly tracked. */
export const GRACE_DAYS = 2;
const SPECIALS_SEASON = 0;
/** Statuses we notify for (not `completed` / `did_not_finish`). */
const ACTIVE_STATUSES = ['want_to_watch', 'watching'] as const;
/** D1 caps bound params ~100/query — chunk id `IN (...)` lists well under that. */
const CHUNK = 90;

/** The user's local date (`YYYY-MM-DD`) and hour (0–23) for `now`, or a UTC fallback on a bad tz. */
export function localDateHour(now: Date, timeZone: string | null): { date: string; hour: number } {
	try {
		const parts = new Intl.DateTimeFormat('en-CA', {
			timeZone: timeZone ?? 'UTC',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			hourCycle: 'h23'
		}).formatToParts(now);
		const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
		return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
	} catch {
		const iso = now.toISOString();
		return { date: iso.slice(0, 10), hour: now.getUTCHours() };
	}
}

/** Shift an ISO date (`YYYY-MM-DD`) back by `days`. */
function subtractDays(isoDate: string, days: number): string {
	const d = new Date(`${isoDate}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() - days);
	return d.toISOString().slice(0, 10);
}

/** In-app deep link for a title from its TMDB external id (`movie/603` → `/title/movie/603`). */
function titleUrl(externalId: string | null): string {
	if (!externalId) return '/';
	const parsed = parseTmdbExternalId(externalId);
	return parsed ? `/title/${parsed.type}/${parsed.tmdbId}` : '/';
}

interface DigestItem {
	/** Ledger key — deterministic per (user, release). */
	key: string;
	payload: PushPayload;
}

/** Newly-aired episodes + newly-released movies for a user within `[from, to]`, as notifiable items. */
async function findReleases(
	db: Db,
	userId: string,
	from: string,
	to: string
): Promise<DigestItem[]> {
	const items: DigestItem[] = [];

	const episodeRows = await db
		.select({
			mediaId: trackingTable.mediaId,
			season: episodesTable.seasonNumber,
			episode: episodesTable.episodeNumber,
			epName: episodesTable.name,
			title: mediaTable.title,
			externalId: mediaTable.externalId
		})
		.from(trackingTable)
		.innerJoin(episodesTable, eq(episodesTable.mediaId, trackingTable.mediaId))
		.innerJoin(mediaTable, eq(mediaTable.id, trackingTable.mediaId))
		.where(
			and(
				eq(trackingTable.userId, userId),
				eq(trackingTable.removed, false),
				inArray(trackingTable.status, [...ACTIVE_STATUSES]),
				gte(episodesTable.seasonNumber, SPECIALS_SEASON + 1),
				gte(episodesTable.airDate, from),
				lte(episodesTable.airDate, to)
			)
		);

	for (const r of episodeRows) {
		items.push({
			key: `${userId}::${r.mediaId}::s${r.season}e${r.episode}`,
			payload: {
				title: r.title,
				body: `Season ${r.season}, Episode ${r.episode}${r.epName ? `: ${r.epName}` : ''} is out`,
				url: titleUrl(r.externalId),
				tag: `${r.mediaId}::s${r.season}e${r.episode}`
			}
		});
	}

	const movieRows = await db
		.select({
			mediaId: mediaTable.id,
			title: mediaTable.title,
			externalId: mediaTable.externalId
		})
		.from(trackingTable)
		.innerJoin(mediaTable, eq(mediaTable.id, trackingTable.mediaId))
		.where(
			and(
				eq(trackingTable.userId, userId),
				eq(trackingTable.removed, false),
				inArray(trackingTable.status, [...ACTIVE_STATUSES]),
				eq(mediaTable.type, 'movie'),
				gte(mediaTable.releaseDate, from),
				lte(mediaTable.releaseDate, to)
			)
		);

	for (const r of movieRows) {
		items.push({
			key: `${userId}::${r.mediaId}::release`,
			payload: {
				title: r.title,
				body: 'Out now',
				url: titleUrl(r.externalId),
				tag: `${r.mediaId}::release`
			}
		});
	}

	return items;
}

/** Drop items already recorded in the ledger, so only genuinely new releases remain. */
async function filterUnsent(db: Db, items: DigestItem[]): Promise<DigestItem[]> {
	const keys = items.map((i) => i.key);
	const sent = new Set<string>();
	for (let i = 0; i < keys.length; i += CHUNK) {
		const chunk = keys.slice(i, i + CHUNK);
		const rows = await db
			.select({ id: notificationLog.id })
			.from(notificationLog)
			.where(inArray(notificationLog.id, chunk));
		for (const row of rows) sent.add(row.id);
	}
	return items.filter((i) => !sent.has(i.key));
}

export interface DigestSummary {
	dueUsers: number;
	sent: number;
	pruned: number;
}

/**
 * Send the daily new-release digest. Runs hourly; a user is notified only when it's ~9AM
 * their local time (timezone taken from their most recently used subscription). For each due user it
 * finds tracked titles with a release in the last `GRACE_DAYS`, drops anything already in the
 * `notification_log` ledger, pushes the rest to every device, records them, and prunes any
 * subscription the push service reports gone (404/410).
 *
 * `sender` is injectable for tests; by default it's built from the VAPID env (throws if unconfigured,
 * which the cron wrapper catches).
 */
export async function sendNewReleaseDigest(
	db: Db,
	env: Env,
	now: Date,
	sender: PushSender = createPushSender(env)
): Promise<DigestSummary> {
	const subs = await db.select().from(pushSubscriptions);
	if (subs.length === 0) return { dueUsers: 0, sent: 0, pruned: 0 };

	// Group by user, tracking the most-recently-used subscription's timezone as the user's timezone.
	const byUser = new Map<string, typeof subs>();
	for (const sub of subs) {
		const list = byUser.get(sub.userId) ?? [];
		list.push(sub);
		byUser.set(sub.userId, list);
	}

	let dueUsers = 0;
	let sent = 0;
	let pruned = 0;

	for (const [userId, userSubs] of byUser) {
		const primary = userSubs.reduce((a, b) => (b.lastUsedAt > a.lastUsedAt ? b : a));
		const { date, hour } = localDateHour(now, primary.timezone);
		if (hour !== SEND_HOUR) continue;
		dueUsers += 1;

		const from = subtractDays(date, GRACE_DAYS);
		const candidates = await findReleases(db, userId, from, date);
		if (candidates.length === 0) continue;
		const fresh = await filterUnsent(db, candidates);
		if (fresh.length === 0) continue;

		for (const item of fresh) {
			let delivered = false;
			for (const sub of userSubs) {
				const result = await sender.send(
					{ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
					item.payload
				);
				if (result.ok) {
					delivered = true;
					sent += 1;
				} else if (result.gone) {
					await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
					pruned += 1;
				}
			}
			// Log only once we've actually delivered, so a transient failure retries within the grace
			// window rather than being silently swallowed.
			if (delivered) {
				await db
					.insert(notificationLog)
					.values({ id: item.key, userId, sentAt: now })
					.onConflictDoNothing();
			}
		}
	}

	return { dueUsers, sent, pruned };
}
