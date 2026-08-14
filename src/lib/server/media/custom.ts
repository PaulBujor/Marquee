/**
 * Server side of custom (user-authored) media. A custom row is **owned** (`owner_user_id`),
 * never returned to anyone else, and can never overwrite a shared `linked` row. Conflicts resolve
 * by LWW on `editedAt` against `updated_at`.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { episodes, media, seasons, type Media } from '$lib/server/db/schema';
import { chunkIds } from '$lib/server/db/chunk';
import type { createDb } from '$lib/server/db';
import type { ValidatedCustomMedia } from '$lib/sync/media-protocol';
import {
	episodeSignature,
	seasonSignature,
	syncEpisodes,
	syncSeasons,
	type EpisodeInsert,
	type SeasonInsert
} from './hydrate';

type Db = ReturnType<typeof createDb>;

/** Split a pushed record into the media scalars and its child rows. */
function toRows(record: ValidatedCustomMedia) {
	const scalars = {
		id: record.id,
		provider: record.provider,
		externalId: null,
		source: 'custom' as const,
		type: record.type,
		title: record.title,
		// Folded in app code with JS `toLowerCase()`, matching how hydration writes it and how the
		// offline client folds — the two must agree or the same query returns different rows.
		titleNormalized: record.title.toLowerCase(),
		year: record.year,
		posterPath: null,
		backdropPath: null,
		overview: record.overview,
		genres: record.genres,
		releaseDate: record.releaseDate,
		status: null,
		inProduction: record.inProduction,
		firstAirDate: record.firstAirDate,
		lastAirDate: record.lastAirDate
	};
	const seasonRows: SeasonInsert[] = (record.seasons ?? []).map((s) => ({
		mediaId: record.id,
		seasonNumber: s.seasonNumber,
		name: s.name,
		overview: s.overview,
		airDate: s.airDate,
		posterPath: null,
		episodeCount: s.episodeCount
	}));
	const episodeRows: EpisodeInsert[] = (record.episodes ?? []).map((e) => ({
		mediaId: record.id,
		seasonNumber: e.season,
		episodeNumber: e.episode,
		name: e.name,
		overview: e.overview,
		airDate: e.airDate,
		runtime: e.runtime,
		stillPath: null
	}));
	return { scalars, seasonRows, episodeRows };
}

/** Whether this user may write `record`'s id — existing rows are only writable by their owner. */
function mayWrite(existing: Media | undefined, userId: string): boolean {
	if (!existing) return true;
	return existing.source === 'custom' && existing.ownerUserId === userId;
}

/**
 * Store custom records a user pushed. `allowedIds` is the caller's anti-abuse gate — only ids the
 * user's own tracking references pass through. Skipped ids are absent from the result; the client
 * retries them.
 */
export async function storeCustomMedia(
	db: Db,
	userId: string,
	records: ValidatedCustomMedia[],
	allowedIds: Set<string>
): Promise<string[]> {
	const eligible = records.filter((r) => allowedIds.has(r.id));
	if (eligible.length === 0) return [];

	const existingRows = (
		await Promise.all(
			chunkIds(eligible.map((r) => r.id)).map((c) =>
				db.select().from(media).where(inArray(media.id, c))
			)
		)
	).flat();
	const existingById = new Map(existingRows.map((r) => [r.id, r]));

	const stored: string[] = [];
	for (const record of eligible) {
		const existing = existingById.get(record.id);
		if (!mayWrite(existing, userId)) continue;
		// A stored copy from a later edit (another device) wins; report it as stored anyway, since
		// there is nothing left for this client to retry — the newer copy comes back on the diff.
		if (existing && existing.updatedAt > record.editedAt) {
			stored.push(record.id);
			continue;
		}

		const { scalars, seasonRows, episodeRows } = toRows(record);

		if (!existing) {
			await db
				.insert(media)
				.values({
					...scalars,
					ownerUserId: userId,
					version: 1,
					// Nothing will ever re-pull this from a provider, so the refresh clock is only here
					// to keep the nightly sweep's "never refreshed" branch from picking it up.
					refreshedAt: record.editedAt,
					updatedAt: record.editedAt
				})
				.onConflictDoNothing();
			await syncSeasons(db, record.id, [], seasonRows);
			await syncEpisodes(db, record.id, [], episodeRows);
			stored.push(record.id);
			continue;
		}

		const [oldSeasons, oldEpisodes] = await Promise.all([
			db.select().from(seasons).where(eq(seasons.mediaId, record.id)),
			db.select().from(episodes).where(eq(episodes.mediaId, record.id))
		]);
		const changed =
			existing.title !== scalars.title ||
			existing.year !== scalars.year ||
			existing.overview !== scalars.overview ||
			existing.type !== scalars.type ||
			seasonSignature(oldSeasons) !== seasonSignature(seasonRows) ||
			episodeSignature(oldEpisodes) !== episodeSignature(episodeRows);

		// Children first: if that throws, the row keeps its old clock and version, so the next push
		// retries rather than being recorded as up to date with half its episodes written.
		await syncSeasons(db, record.id, oldSeasons, seasonRows);
		await syncEpisodes(db, record.id, oldEpisodes, episodeRows);
		await db
			.update(media)
			.set({
				...scalars,
				ownerUserId: userId,
				refreshedAt: record.editedAt,
				updatedAt: record.editedAt,
				version: changed ? existing.version + 1 : existing.version
			})
			.where(and(eq(media.id, record.id), eq(media.ownerUserId, userId)));
		stored.push(record.id);
	}
	return stored;
}
