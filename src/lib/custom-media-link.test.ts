import { describe, expect, it } from 'vitest';
import {
	buildLinkEvents,
	type LinkSourceTracking,
	type LinkSourceWatch,
	type LinkTarget
} from './custom-media-link';
import { createEvent, tmdbMediaId, validateEvent, type EventPayloadMap } from '$lib/sync/events';

const DEVICE = '11111111-1111-1111-1111-111111111111';
const CUSTOM_ID = '99999999-9999-4999-8999-999999999999';
const TARGET: LinkTarget = {
	targetId: tmdbMediaId('show', 1396),
	provider: 'tmdb',
	externalId: 'show/1396'
};

const ADDED = Date.UTC(2024, 0, 10);
const STATUS_AT = Date.UTC(2025, 5, 2);
const FAV_AT = Date.UTC(2025, 5, 3);
const RATED_AT = Date.UTC(2025, 5, 4);
const WATCH_AT = Date.UTC(2025, 4, 1);
const NOW = Date.UTC(2026, 7, 14);

function source(over: Partial<LinkSourceTracking> = {}): LinkSourceTracking {
	return {
		mediaId: CUSTOM_ID,
		status: 'completed',
		favorite: false,
		rating: null,
		addedAt: ADDED,
		statusUpdatedAt: STATUS_AT,
		favoriteUpdatedAt: 0,
		ratingUpdatedAt: 0,
		...over
	};
}

const watch = (episode: number, over: Partial<LinkSourceWatch> = {}): LinkSourceWatch => ({
	season: 1,
	episode,
	watched: true,
	updatedAt: WATCH_AT,
	...over
});

/** All events targeting an id, in the order the builder emitted them. */
const forEntity = (events: ReturnType<typeof buildLinkEvents>, id: string) =>
	events.filter((e) => e.entityId === id);

describe('buildLinkEvents', () => {
	it('revives a target the user removed more recently than the entry was added', () => {
		// Otherwise the title vanishes outright: the target's revive is stamped with the entry's
		// historical `addedAt` and loses to the newer tombstone, while the entry itself is tombstoned
		// at `now`. Both projections agree, so nothing heals it.
		const addedAt = Date.UTC(2024, 0, 1);
		const removedAt = Date.UTC(2025, 0, 1);
		const events = buildLinkEvents(
			source({ addedAt }),
			[],
			{ ...TARGET, removedUpdatedAt: removedAt },
			NOW
		);

		const revives = forEntity(events, TARGET.targetId).filter((e) => e.type === 'tracking.added');
		expect(revives.map((e) => e.clock)).toEqual([addedAt, removedAt]);
	});

	it('does not re-stamp the status clock when the target carries no newer tombstone', () => {
		// The extra revive re-asserts the status at its own clock, and the historical
		// `status_changed` is what dates a completed title — so it must stay off the common path.
		const events = buildLinkEvents(source({ addedAt: Date.UTC(2024, 0, 1) }), [], TARGET, NOW);
		expect(
			forEntity(events, TARGET.targetId).filter((e) => e.type === 'tracking.added')
		).toHaveLength(1);
	});

	it('records the association against the custom entry, naming the target by identity', () => {
		const events = buildLinkEvents(source(), [], TARGET, NOW);
		expect(events[0]).toEqual({
			type: 'media.linked',
			entityId: CUSTOM_ID,
			payload: {
				targetId: TARGET.targetId,
				provider: 'tmdb',
				externalId: 'show/1396'
			},
			clock: NOW
		});
	});

	it('carries the added and status clocks, not today', () => {
		// These clocks are the dates the app displays. Stamping them now would rewrite a decade of
		// watch history into one afternoon.
		const events = buildLinkEvents(source(), [], TARGET, NOW);
		const target = forEntity(events, TARGET.targetId);
		expect(target).toContainEqual({
			type: 'tracking.added',
			entityId: TARGET.targetId,
			payload: { status: 'completed' },
			clock: ADDED
		});
		expect(target).toContainEqual({
			type: 'tracking.status_changed',
			entityId: TARGET.targetId,
			payload: { status: 'completed' },
			clock: STATUS_AT
		});
	});

	it('carries favorite and rating with their own clocks when they were set', () => {
		const events = buildLinkEvents(
			source({ favorite: true, favoriteUpdatedAt: FAV_AT, rating: 4, ratingUpdatedAt: RATED_AT }),
			[],
			TARGET,
			NOW
		);
		expect(forEntity(events, TARGET.targetId)).toContainEqual({
			type: 'tracking.favorite_toggled',
			entityId: TARGET.targetId,
			payload: { favorite: true },
			clock: FAV_AT
		});
		expect(forEntity(events, TARGET.targetId)).toContainEqual({
			type: 'tracking.rated',
			entityId: TARGET.targetId,
			payload: { rating: 4 },
			clock: RATED_AT
		});
	});

	it('emits nothing for an unfavourited, unrated entry', () => {
		// Emitting `favorite: false` would let a merge *clear* a flag the user set on the target from
		// another device. Linking only ever adds to what the target knows.
		const events = buildLinkEvents(source(), [], TARGET, NOW);
		expect(events.some((e) => e.type === 'tracking.favorite_toggled')).toBe(false);
		expect(events.some((e) => e.type === 'tracking.rated')).toBe(false);
	});

	it('carries each watched episode onto the target at the clock it was marked', () => {
		const events = buildLinkEvents(
			source(),
			[watch(1), watch(2, { updatedAt: WATCH_AT + 1000 }), watch(3, { watched: false })],
			TARGET,
			NOW
		);
		const watched = forEntity(events, TARGET.targetId).filter((e) => e.type === 'episode.watched');
		expect(watched).toHaveLength(2); // the unwatched row is not history to carry
		expect(watched[0]).toMatchObject({ payload: { season: 1, episode: 1 }, clock: WATCH_AT });
		expect(watched[1]).toMatchObject({
			payload: { season: 1, episode: 2 },
			clock: WATCH_AT + 1000
		});
	});

	it('retires the custom entry last, at now, so it leaves the lists', () => {
		const events = buildLinkEvents(source(), [watch(1), watch(2)], TARGET, NOW);
		const onSource = forEntity(events, CUSTOM_ID);
		// media.linked, then an unwatch per watched episode, then the tombstone.
		expect(onSource.map((e) => e.type)).toEqual([
			'media.linked',
			'episode.unwatched',
			'episode.unwatched',
			'tracking.removed'
		]);
		// At `now`, so they beat the older clocks above and a replay can't resurrect the progress.
		expect(onSource.slice(1).every((e) => e.clock === NOW)).toBe(true);
		expect(events[events.length - 1].type).toBe('tracking.removed');
	});

	it('substitutes now for a clock the projection never set', () => {
		// A field's clock sits at 0 until something sets it, and the event schema rejects a
		// non-positive clock — an unset clock has to become a real one or the server drops the event.
		const events = buildLinkEvents(
			source({ addedAt: 0, statusUpdatedAt: 0, favorite: true, favoriteUpdatedAt: 0 }),
			[watch(1, { updatedAt: 0 })],
			TARGET,
			NOW
		);
		expect(events.every((e) => (e.clock ?? 0) > 0)).toBe(true);
	});

	it('produces only events the real event schema accepts', () => {
		const events = buildLinkEvents(
			source({ favorite: true, favoriteUpdatedAt: FAV_AT, rating: 5, ratingUpdatedAt: RATED_AT }),
			[watch(1), watch(2)],
			TARGET,
			NOW
		);
		for (const spec of events) {
			const envelope = createEvent(
				spec.type,
				spec.entityId,
				spec.payload as EventPayloadMap[typeof spec.type],
				DEVICE,
				spec.clock
			);
			expect(validateEvent(envelope)).not.toBeNull();
		}
	});
});
