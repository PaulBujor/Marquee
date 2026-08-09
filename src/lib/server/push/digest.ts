import { and, eq, gte, inArray, isNull, lte, or, type SQL } from 'drizzle-orm';
import {
	episodes as episodesTable,
	media as mediaTable,
	notificationLog,
	pushSubscriptions,
	tracking as trackingTable,
	type PushSubscriptionRow
} from '$lib/server/db/schema';
import { parseTmdbExternalId } from '$lib/server/media/hydrate';
import { createPushSender, type PushSender, type PushPayload } from './index';
import { chunkIds } from '$lib/server/db/chunk';
import type { createDb } from '$lib/server/db';

type Db = ReturnType<typeof createDb>;

/** Notifications go out at 9AM the user's local time. */
export const SEND_HOUR = 9;
/** How many days back a release still counts as "new" — covers a missed run / late-day airs without
 *  back-filling a whole back catalogue when a long-running show is newly tracked. */
export const GRACE_DAYS = 2;
const SPECIALS_SEASON = 0;
/** Movie statuses we notify for (not `completed` / `did_not_finish`). */
const ACTIVE_STATUSES = ['want_to_watch', 'watching'] as const;
/**
 * Show statuses we notify for. Includes `completed`, unlike movies: this query already scopes to
 * episodes whose air date falls in the last `GRACE_DAYS` days, so any row it returns for a show
 * stored `completed` is guaranteed genuinely new — the user couldn't have completed the show
 * before that episode existed. This is what lets a show demoted by a new season (`tracking.status`
 * is user-intent only; nothing corrects it server-side, see `deriveStatus` for the client-side
 * read-time correction) still surface a release notification without the stored column ever being
 * fixed up. `did_not_finish` stays excluded — that's a deliberate "stop notifying me" signal, not
 * a data-staleness question.
 */
const ACTIVE_SHOW_STATUSES = ['want_to_watch', 'watching', 'completed'] as const;

/**
 * Max users notified in one hourly invocation. Every send is a serial network call, so an
 * unbounded run grows with the user base until it exceeds the Worker's CPU/subrequest budget and
 * silently drops whoever came last. Overflow rolls to the next run — `GRACE_DAYS` keeps the
 * release notifiable and `notification_log` keeps it exactly-once.
 */
export const DIGEST_MAX_USERS_PER_RUN = 200;

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

/** A single notifiable release, prior to grouping into pushes. */
interface ReleaseItem {
	/** Ledger key — deterministic per (user, release). */
	key: string;
	mediaId: string;
	kind: 'episode' | 'movie';
	title: string;
	externalId: string | null;
	season?: number;
	episode?: number;
	epName?: string | null;
}

/** A push ready to send, plus the underlying releases it covers (for per-release ledger writes). */
interface ReleaseGroup {
	payload: PushPayload;
	items: ReleaseItem[];
}

/** Newly-aired episodes + newly-released movies for a user within `[from, to]`, as notifiable items. */
async function findReleases(
	db: Db,
	userId: string,
	from: string,
	to: string
): Promise<ReleaseItem[]> {
	const items: ReleaseItem[] = [];

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
				inArray(trackingTable.status, [...ACTIVE_SHOW_STATUSES]),
				gte(episodesTable.seasonNumber, SPECIALS_SEASON + 1),
				gte(episodesTable.airDate, from),
				lte(episodesTable.airDate, to)
			)
		);

	for (const r of episodeRows) {
		items.push({
			key: `${userId}::${r.mediaId}::s${r.season}e${r.episode}`,
			mediaId: r.mediaId,
			kind: 'episode',
			title: r.title,
			externalId: r.externalId,
			season: r.season,
			episode: r.episode,
			epName: r.epName
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
			mediaId: r.mediaId,
			kind: 'movie',
			title: r.title,
			externalId: r.externalId
		});
	}

	return items;
}

/** Drop items already recorded in the ledger, so only genuinely new releases remain. */
async function filterUnsent(db: Db, items: ReleaseItem[]): Promise<ReleaseItem[]> {
	const keys = items.map((i) => i.key);
	const sent = new Set<string>();
	for (const chunk of chunkIds(keys)) {
		const rows = await db
			.select({ id: notificationLog.id })
			.from(notificationLog)
			.where(inArray(notificationLog.id, chunk));
		for (const row of rows) sent.add(row.id);
	}
	return items.filter((i) => !sent.has(i.key));
}

/** The rich, single-release payload — unchanged from before grouping existed. */
function singleItemPayload(item: ReleaseItem): PushPayload {
	const url = titleUrl(item.externalId);
	if (item.kind === 'movie') {
		return { title: item.title, body: 'Out now', url, tag: `${item.mediaId}::release` };
	}
	return {
		title: item.title,
		body: `Season ${item.season}, Episode ${item.episode}${item.epName ? `: ${item.epName}` : ''} is out`,
		url,
		tag: `${item.mediaId}::s${item.season}e${item.episode}`
	};
}

/**
 * Collapse a user's fresh releases into the pushes to actually send: a single release keeps its
 * rich per-episode/movie form; multiple releases from one show collapse to one per-show
 * notification; releases spanning more than one show/movie collapse further into a single
 * cross-show summary (rather than one push per show) so a busy day never fans out per release.
 */
function groupReleases(items: ReleaseItem[]): ReleaseGroup[] {
	if (items.length === 0) return [];

	const byMedia = new Map<string, ReleaseItem[]>();
	for (const item of items) {
		const group = byMedia.get(item.mediaId) ?? [];
		group.push(item);
		byMedia.set(item.mediaId, group);
	}

	if (byMedia.size > 1) {
		const total = items.length;
		return [
			{
				payload: {
					title: 'New releases',
					// `/timeline` only ever shows strictly-future releases (filterUpcoming excludes
					// airDate/releaseDate <= today), so it would never show the items this notification
					// is about — the library is the deep link that actually still contains them.
					body: `${total} new release${total === 1 ? '' : 's'} across ${byMedia.size} titles`,
					url: '/',
					tag: 'digest::summary'
				},
				items
			}
		];
	}

	const [[mediaId, group]] = byMedia;
	if (group.length === 1) {
		return [{ payload: singleItemPayload(group[0]), items: group }];
	}

	const first = group[0];
	return [
		{
			payload: {
				title: first.title,
				body: `${group.length} new episodes`,
				url: titleUrl(first.externalId),
				tag: `${mediaId}::digest`
			},
			items: group
		}
	];
}

export interface DigestSummary {
	dueUsers: number;
	sent: number;
	pruned: number;
}

/**
 * Send the daily new-release digest. Runs hourly; a user is notified only when it's ~9AM
 * their local time (timezone taken from their most recently used subscription among the ones
 * matching the current hour's due timezones — a user whose most-recently-used device sits in a
 * timezone that isn't due this run is correctly skipped, but one whose *only* due device is an
 * older one can be notified off that device's timezone instead; a rare multi-device-across-zones
 * edge case, traded for not reading every subscription row every hour).
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
	// Which timezones are at local hour SEND_HOUR right now — resolved against the distinct set in
	// use, not every subscription row, since the number of distinct timezones stays small and
	// roughly constant as the user base grows.
	const timezonesInUse = await db
		.selectDistinct({ timezone: pushSubscriptions.timezone })
		.from(pushSubscriptions);
	const dueTimezones = timezonesInUse
		.map((row) => row.timezone)
		.filter((timezone) => localDateHour(now, timezone).hour === SEND_HOUR);
	if (dueTimezones.length === 0) return { dueUsers: 0, sent: 0, pruned: 0 };

	const dueNamedTimezones = dueTimezones.filter((tz): tz is string => tz !== null);
	const dueTimezoneConditions = [
		dueNamedTimezones.length > 0
			? inArray(pushSubscriptions.timezone, dueNamedTimezones)
			: undefined,
		dueTimezones.includes(null) ? isNull(pushSubscriptions.timezone) : undefined
	].filter((condition): condition is SQL => condition !== undefined);

	// Two passes, so the hourly run doesn't pull every device's key material to discard 23/24 of it.
	// The first reads only what the 9AM-local test needs, and only for subscriptions whose timezone
	// is due this hour; the encryption keys are loaded in the second, for due users only.
	const candidates = await db
		.select({
			userId: pushSubscriptions.userId,
			timezone: pushSubscriptions.timezone,
			lastUsedAt: pushSubscriptions.lastUsedAt
		})
		.from(pushSubscriptions)
		.where(
			dueTimezoneConditions.length === 1 ? dueTimezoneConditions[0] : or(...dueTimezoneConditions)
		);
	if (candidates.length === 0) return { dueUsers: 0, sent: 0, pruned: 0 };

	// The user's timezone is the one on their most-recently-used subscription.
	const tzByUser = new Map<string, { timezone: string | null; lastUsedAt: Date }>();
	for (const row of candidates) {
		const current = tzByUser.get(row.userId);
		if (!current || row.lastUsedAt > current.lastUsedAt) {
			tzByUser.set(row.userId, { timezone: row.timezone, lastUsedAt: row.lastUsedAt });
		}
	}

	const due: { userId: string; date: string }[] = [];
	for (const [userId, { timezone }] of tzByUser) {
		const { date, hour } = localDateHour(now, timezone);
		if (hour === SEND_HOUR) due.push({ userId, date });
	}
	if (due.length === 0) return { dueUsers: 0, sent: 0, pruned: 0 };

	// Bound the work per invocation. Sends are serial network calls, so an unbounded run would
	// eventually exceed the Worker's limits and drop whoever sorted last. Overflow waits for the
	// next hourly run: `GRACE_DAYS` keeps the release notifiable, and the ledger keeps it once-only.
	const batch = due.slice(0, DIGEST_MAX_USERS_PER_RUN);
	if (due.length > batch.length) {
		console.warn(
			`cron: notifications — ${due.length} users due, capping at ${DIGEST_MAX_USERS_PER_RUN}; the rest roll to the next run`
		);
	}

	// Now load the full subscription rows (endpoint + keys) for just the users being notified.
	const subsByUser = new Map<string, PushSubscriptionRow[]>();
	for (const ids of chunkIds(batch.map((d) => d.userId))) {
		const rows = await db
			.select()
			.from(pushSubscriptions)
			.where(inArray(pushSubscriptions.userId, ids));
		for (const row of rows) {
			const list = subsByUser.get(row.userId) ?? [];
			list.push(row);
			subsByUser.set(row.userId, list);
		}
	}

	let dueUsers = 0;
	let sent = 0;
	let pruned = 0;

	for (const { userId, date } of batch) {
		const userSubs = subsByUser.get(userId);
		if (!userSubs || userSubs.length === 0) continue; // unsubscribed between the two passes
		dueUsers += 1;

		const from = subtractDays(date, GRACE_DAYS);
		const candidates = await findReleases(db, userId, from, date);
		if (candidates.length === 0) continue;
		const fresh = await filterUnsent(db, candidates);
		if (fresh.length === 0) continue;

		for (const group of groupReleases(fresh)) {
			let delivered = false;
			for (const sub of userSubs) {
				const result = await sender.send(
					{ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
					group.payload
				);
				if (result.ok) {
					delivered = true;
					sent += 1;
				} else if (result.gone) {
					await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
					pruned += 1;
				}
			}
			// Log every release the push covered — not just the group as a whole — so dedupe stays
			// per-release: a later run that finds only some of these still unsent (e.g. one more
			// episode airs) doesn't re-notify the ones already delivered in this group.
			if (delivered) {
				for (const item of group.items) {
					await db
						.insert(notificationLog)
						.values({ id: item.key, userId, sentAt: now })
						.onConflictDoNothing();
				}
			}
		}
	}

	return { dueUsers, sent, pruned };
}
