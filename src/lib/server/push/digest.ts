import { and, eq, gte, inArray, isNull, lte, min, or, type SQL } from 'drizzle-orm';
import {
	episodes as episodesTable,
	episodeWatches as episodeWatchesTable,
	media as mediaTable,
	notificationLog,
	pushSubscriptions,
	tracking as trackingTable,
	type PushSubscriptionRow
} from '#lib/server/db/schema.js';
import { parseTmdbExternalId } from '#lib/server/media/hydrate.js';
import { createPushSender, type PushSender, type PushPayload } from './index';
import { chunkIds } from '#lib/server/db/chunk.js';
import type { createDb } from '#lib/server/db/index.js';

type Db = ReturnType<typeof createDb>;

/** Notifications go out at 9AM the user's local time. */
export const SEND_HOUR = 9;
/** How many days back a release still counts as "new" — covers a missed run or a late-day air without back-filling a catalogue. */
export const GRACE_DAYS = 2;
const SPECIALS_SEASON = 0;
/** Not `completed` / `did_not_finish`. */
const ACTIVE_STATUSES = ['want_to_watch', 'watching'] as const;
/** `completed` is included here; {@link selectNotifiableEpisodes} decides per row. */
const ACTIVE_SHOW_STATUSES = ['want_to_watch', 'watching', 'completed'] as const;

// Serial sends, so an unbounded run exceeds the Worker's CPU/subrequest budget and silently drops whoever came last.
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

function subtractDays(isoDate: string, days: number): string {
	const d = new Date(`${isoDate}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() - days);
	return d.toISOString().slice(0, 10);
}

function titleUrl(externalId: string | null): string {
	if (!externalId) return '/';
	const parsed = parseTmdbExternalId(externalId);
	return parsed ? `/title/${parsed.type}/${parsed.tmdbId}` : '/';
}

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

interface ReleaseGroup {
	payload: PushPayload;
	items: ReleaseItem[];
}

// `did_not_finish` never qualifies, and `want_to_watch` must earn it: `tracking.status` lags until episode metadata lands.
export function selectNotifiableEpisodes<
	T extends { mediaId: string; airDate: string | null; status: string }
>(
	rows: T[],
	watchedMediaIds: ReadonlySet<string>,
	premiereAirDate: ReadonlyMap<string, string>
): T[] {
	return rows.filter((row) => {
		if (row.status === 'did_not_finish') return false;
		if (row.status !== 'want_to_watch') return true;
		return (
			watchedMediaIds.has(row.mediaId) ||
			(row.airDate !== null && premiereAirDate.get(row.mediaId) === row.airDate)
		);
	});
}

async function findWatchedShows(db: Db, userId: string): Promise<Set<string>> {
	const rows = await db
		.selectDistinct({ mediaId: episodeWatchesTable.mediaId })
		.from(episodeWatchesTable)
		.where(and(eq(episodeWatchesTable.userId, userId), eq(episodeWatchesTable.watched, true)));
	return new Set(rows.map((r) => r.mediaId));
}

/** Earliest air date per show, ignoring specials (one can precede the real premiere). */
async function findPremiereAirDates(db: Db, mediaIds: string[]): Promise<Map<string, string>> {
	const premieres = new Map<string, string>();
	for (const chunk of chunkIds(mediaIds)) {
		const rows = await db
			.select({ mediaId: episodesTable.mediaId, airDate: min(episodesTable.airDate) })
			.from(episodesTable)
			.where(
				and(
					inArray(episodesTable.mediaId, chunk),
					gte(episodesTable.seasonNumber, SPECIALS_SEASON + 1)
				)
			)
			.groupBy(episodesTable.mediaId);
		for (const r of rows) if (r.airDate !== null) premieres.set(r.mediaId, r.airDate);
	}
	return premieres;
}

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
			airDate: episodesTable.airDate,
			status: trackingTable.status,
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
				// Provider-backed only: a custom entry's synthesized air dates would announce episodes the user just typed in.
				eq(mediaTable.source, 'linked'),
				gte(episodesTable.seasonNumber, SPECIALS_SEASON + 1),
				gte(episodesTable.airDate, from),
				lte(episodesTable.airDate, to)
			)
		);

	const undecided = [
		...new Set(episodeRows.filter((r) => r.status === 'want_to_watch').map((r) => r.mediaId))
	];
	const notifiableEpisodes = undecided.length
		? selectNotifiableEpisodes(
				episodeRows,
				await findWatchedShows(db, userId),
				await findPremiereAirDates(db, undecided)
			)
		: episodeRows;

	for (const r of notifiableEpisodes) {
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
				// Same rule as above: a custom movie has no release date, but that's an accident of the writer, not a guarantee.
				eq(mediaTable.source, 'linked'),
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
					// `/timeline` shows only strictly-future releases, so it would never hold the items this push is about; `/` does.
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

// Runs hourly; timezone is taken from the most-recently-used due subscription, an accepted multi-device-across-zones edge case.
export async function sendNewReleaseDigest(
	db: Db,
	env: Env,
	now: Date,
	sender: PushSender = createPushSender(env)
): Promise<DigestSummary> {
	// Distinct timezones stay small and roughly constant, unlike subscription rows.
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

	const batch = due.slice(0, DIGEST_MAX_USERS_PER_RUN);
	if (due.length > batch.length) {
		console.warn(
			`cron: notifications — ${due.length} users due, capping at ${DIGEST_MAX_USERS_PER_RUN}; the rest roll to the next run`
		);
	}

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
			// Per-release ledger writes: a later run finding one more episode must not re-notify the rest of the group.
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
