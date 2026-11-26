/**
 * Turns a stated library intent into the minimal event set it implies. A caller names *what it
 * wants*, never an event: which events that means — and whether any are needed at all — is decided
 * here, so replaying the same command (deliveries are at-least-once) is a no-op the second time.
 *
 * Every write goes through `applyEvents`, so `tracking` and `episode_watches` stay derivable from
 * the log; nothing here writes those tables.
 */
import { and, eq, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { createDb } from '#lib/server/db/index.js';
import { episodeWatches, episodes, media, tracking } from '#lib/server/db/schema.js';
import { applyEvents, type EventOrigin } from '#lib/server/sync/projection.js';
import {
	TRACKING_STATUSES,
	createEvent,
	type EventEnvelope,
	type EventPayloadMap,
	type ServerEvent,
	type SyncEventType,
	type TrackingStatus
} from '#lib/sync/events.js';
import { todayIso } from '#lib/tracking/actions.js';

type Db = ReturnType<typeof createDb>;

/** Events the API mints on a user's behalf are attributed to one fixed origin, which is not a device. */
const API_DEVICE_ID = '00000000-0000-5000-a000-000000000001';

/** Cap on an explicit episode delta list, so one request can't enumerate an unbounded series. */
const COMMAND_EPISODES_MAX = 500;

const episodeCoordSchema = z
	.object({
		// Season 0 is TMDB's Specials, so only the episode within a season is 1-based.
		season: z.number().int().nonnegative(),
		episode: z.number().int().positive()
	})
	.strict();

/** One episode's desired state — the only way to speak about a single episode. */
export const episodeDeltaSchema = episodeCoordSchema.extend({ watched: z.boolean() });

/**
 * Wire shape of a command. Strict, because an unknown field means the caller believes it is doing
 * something that would silently not happen. Every field is optional and independent.
 */
export const libraryCommandSchema = z
	.object({
		status: z.enum(TRACKING_STATUSES).optional(),
		favorite: z.boolean().optional(),
		/** 1–5, or `null` to clear. */
		rating: z.number().int().min(1).max(5).nullable().optional(),
		/** `true` removes the title; `false` puts it back. */
		removed: z.boolean().optional(),
		episodes: z.array(episodeDeltaSchema).max(COMMAND_EPISODES_MAX).optional(),
		/** Bulk intent for one season: every aired episode of it gets `watched`. */
		season: episodeCoordSchema.pick({ season: true }).extend({ watched: z.boolean() }).optional()
	})
	.strict();

export type EpisodeDelta = z.infer<typeof episodeDeltaSchema>;
export type LibraryCommand = z.infer<typeof libraryCommandSchema>;

/** A media id that is neither in the shared catalog nor owned by the caller — both answer identically. */
export class UnknownMediaError extends Error {
	constructor() {
		super('Unknown media');
		this.name = 'UnknownMediaError';
	}
}

function coordKey(coord: { season: number; episode: number }): string {
	return `${coord.season}:${coord.episode}`;
}

/**
 * Applies `command` to one title the caller owns, and returns the events it emitted (empty when the
 * title already matched the command). `userId` must come from the authenticated token, never input.
 */
export async function applyLibraryCommand(
	db: Db,
	userId: string,
	mediaId: string,
	command: LibraryCommand,
	origin: EventOrigin
): Promise<ServerEvent[]> {
	const [title] = await db
		.select({ type: media.type, source: media.source, ownerUserId: media.ownerUserId })
		.from(media)
		.where(eq(media.id, mediaId))
		.limit(1);
	// Another user's custom entry must be indistinguishable from one that doesn't exist.
	if (!title || (title.source === 'custom' && title.ownerUserId !== userId))
		throw new UnknownMediaError();

	const [current] = await db
		.select({
			status: tracking.status,
			favorite: tracking.favorite,
			rating: tracking.rating,
			removed: tracking.removed
		})
		.from(tracking)
		.where(and(eq(tracking.userId, userId), eq(tracking.mediaId, mediaId)))
		.limit(1);
	const live = current !== undefined && !current.removed;

	const wantsEpisodes =
		title.type === 'show' && (command.episodes !== undefined || command.season !== undefined);
	// Removal clears episode progress too, so both paths need the current watched rows.
	const needsWatches = wantsEpisodes || (title.type === 'show' && command.removed === true);
	const watches = needsWatches
		? await db
				.select({
					season: episodeWatches.season,
					episode: episodeWatches.episode,
					watched: episodeWatches.watched
				})
				.from(episodeWatches)
				.where(and(eq(episodeWatches.userId, userId), eq(episodeWatches.mediaId, mediaId)))
		: [];
	const watchedNow = new Map(watches.map((w) => [coordKey(w), w.watched]));

	// A movie has no episodes, so an episode intent against one names nothing to mark.
	const desired = new Map<string, EpisodeDelta>();
	if (wantsEpisodes) {
		for (const delta of command.episodes ?? []) desired.set(coordKey(delta), delta);
		if (command.season) {
			const { season, watched } = command.season;
			if (watched) {
				// The server picks which episodes a bulk intent means, so it can only name ones that have aired.
				const aired = await db
					.select({ seasonNumber: episodes.seasonNumber, episodeNumber: episodes.episodeNumber })
					.from(episodes)
					.where(
						and(
							eq(episodes.mediaId, mediaId),
							eq(episodes.seasonNumber, season),
							lte(episodes.airDate, todayIso())
						)
					);
				for (const e of aired)
					desired.set(coordKey({ season: e.seasonNumber, episode: e.episodeNumber }), {
						season: e.seasonNumber,
						episode: e.episodeNumber,
						watched: true
					});
			} else {
				// Un-watching needs no air dates: only what is actually watched can be un-watched.
				for (const w of watches)
					if (w.watched && w.season === season) desired.set(coordKey(w), { ...w, watched: false });
			}
		}
	}
	// An absent row and a stored `watched: false` are the same state, so a command that asks for
	// `watched: false` on a never-watched episode emits nothing.
	const episodeChanges = [...desired.values()].filter(
		(delta) => (watchedNow.get(coordKey(delta)) ?? false) !== delta.watched
	);

	// `tracking.added` is the only event that clears a `removed` tombstone, so a title has to be
	// asserted back onto the list before anything that needs a row can be written to it.
	const wantsLive =
		command.removed === false ||
		command.status !== undefined ||
		command.favorite === true ||
		command.rating !== undefined ||
		episodeChanges.some((delta) => delta.watched);
	// A resurrection keeps the caller's status, else the tombstone's; a fresh one is implied by the command.
	const addedStatus = (implied: TrackingStatus): TrackingStatus =>
		command.status ?? current?.status ?? implied;

	const events: EventEnvelope[] = [];
	const emit = <T extends SyncEventType>(type: T, payload: EventPayloadMap[T]): void => {
		events.push(createEvent(type, mediaId, payload, API_DEVICE_ID));
	};

	if (!live && wantsLive) {
		// A watch means the title is being watched; a favorite or rating only puts it on the list.
		const implied = episodeChanges.some((delta) => delta.watched) ? 'watching' : 'want_to_watch';
		emit('tracking.added', { status: addedStatus(implied) });
	} else if (live && command.status !== undefined && command.status !== current.status) {
		emit('tracking.status_changed', { status: command.status });
	}

	if (command.favorite !== undefined && command.favorite !== (current?.favorite ?? false)) {
		emit('tracking.favorite_toggled', { favorite: command.favorite });
	}
	if (command.rating !== undefined && command.rating !== (current?.rating ?? null)) {
		emit('tracking.rated', { rating: command.rating });
	}

	for (const delta of episodeChanges) {
		emit(delta.watched ? 'episode.watched' : 'episode.unwatched', {
			season: delta.season,
			episode: delta.episode
		});
	}

	if (command.removed === true && live) {
		// Progress goes with the removal, so a later re-add starts clean instead of resurrecting it.
		for (const w of watches) {
			if (w.watched) emit('episode.unwatched', { season: w.season, episode: w.episode });
		}
		emit('tracking.removed', {});
	}

	return applyEvents(db, userId, origin, events);
}
