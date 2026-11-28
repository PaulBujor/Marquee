import { describe, expect, it } from 'vitest';
import {
	createEvent,
	type EventPayloadMap,
	type EventEnvelope,
	type SyncEventType
} from './events.js';
import {
	compensatingEventCount,
	compensatingEvents,
	diffStates,
	eventAtStep,
	eventDiff,
	eventSummary,
	isOnList,
	orderedLog,
	relativeAgo,
	stateAt,
	stateAtStep,
	summarize,
	touchedAfterStep,
	type HistoryState
} from './history.js';

function ev<T extends SyncEventType>(
	type: T,
	entityId: string,
	payload: EventPayloadMap[T],
	clock: number
): EventEnvelope<T> {
	return { ...createEvent(type, entityId, payload, 'device', clock) };
}

const MIN = 60_000;
const NOW = 10_000_000;

describe('stateAt', () => {
	it('an empty log is an empty library', () => {
		const state = stateAt([], NOW);
		expect(state).toEqual({ tracking: {}, episodes: {} });
		expect(diffStates(state, state)).toEqual([]);
		expect(summarize(state)).toEqual({ titles: 0, episodes: 0 });
	});

	it('replays by clientCreatedAt, not by array order', () => {
		const events = [
			ev('tracking.status_changed', 'movie/a', { status: 'completed' }, NOW - 1),
			ev('tracking.added', 'movie/a', { status: 'want_to_watch' }, NOW - 2)
		];
		expect(stateAt(events, NOW).tracking['movie/a'].status).toBe('completed');
	});

	it('breaks an exact clock tie by event id, so every device agrees', () => {
		const a = { ...ev('tracking.status_changed', 'movie/a', { status: 'watching' }, NOW), id: 'a' };
		const b = {
			...ev('tracking.status_changed', 'movie/a', { status: 'completed' }, NOW),
			id: 'b'
		};
		expect(stateAt([a, b], NOW).tracking['movie/a'].status).toBe('completed');
		expect(stateAt([b, a], NOW).tracking['movie/a'].status).toBe('completed');
	});

	it('includes an event exactly at the cutoff and excludes the next one', () => {
		const events = [
			ev('tracking.added', 'movie/a', { status: 'want_to_watch' }, NOW - 10),
			ev('tracking.status_changed', 'movie/a', { status: 'completed' }, NOW)
		];
		expect(stateAt(events, NOW).tracking['movie/a'].status).toBe('completed');
		expect(stateAt(events, NOW - 1).tracking['movie/a'].status).toBe('want_to_watch');
	});

	it('keeps a removed title as a tombstone rather than dropping it', () => {
		const events = [
			ev('tracking.added', 'movie/a', { status: 'completed' }, NOW - 3),
			ev('tracking.removed', 'movie/a', {}, NOW - 2)
		];
		const before = stateAt(events, NOW - 3);
		const after = stateAt(events, NOW);
		expect(isOnList(before, 'movie/a')).toBe(true);
		expect(after.tracking['movie/a'].removed).toBe(true);
		expect(isOnList(after, 'movie/a')).toBe(false);
	});

	it('projects per-field LWW for status, favorite and rating independently', () => {
		const events = [
			ev('tracking.added', 'show/a', { status: 'watching' }, NOW - 6),
			ev('tracking.favorite_toggled', 'show/a', { favorite: true }, NOW - 5),
			ev('tracking.rated', 'show/a', { rating: 4 }, NOW - 4),
			// A later status change must not clear the favorite or the rating.
			ev('tracking.status_changed', 'show/a', { status: 'completed' }, NOW - 3),
			// A stale favorite toggle loses.
			ev('tracking.favorite_toggled', 'show/a', { favorite: false }, NOW - 7)
		];
		expect(stateAt(events, NOW).tracking['show/a']).toEqual({
			status: 'completed',
			favorite: true,
			rating: 4,
			removed: false
		});
	});

	it('records episode watches with an unwatch tombstone', () => {
		const events = [
			ev('episode.watched', 'show/a', { season: 1, episode: 1 }, NOW - 4),
			ev('episode.watched', 'show/a', { season: 1, episode: 2 }, NOW - 3),
			ev('episode.unwatched', 'show/a', { season: 1, episode: 2 }, NOW - 2)
		];
		expect(Object.keys(stateAt(events, NOW).episodes)).toEqual(['show/a::s1e1']);
	});

	it('ignores identity events', () => {
		const events = [
			ev(
				'media.linked',
				'custom/a',
				{ targetId: 'movie/a', provider: 'tmdb', externalId: '603' },
				NOW
			)
		];
		expect(stateAt(events, NOW)).toEqual({ tracking: {}, episodes: {} });
	});
});

describe('diffStates', () => {
	function states(): { now: HistoryState; then: HistoryState } {
		const events = [
			ev('tracking.added', 'movie/a', { status: 'watching' }, NOW - 10),
			ev('tracking.rated', 'movie/a', { rating: 2 }, NOW - 9),
			ev('tracking.added', 'movie/b', { status: 'completed' }, NOW - 8),
			ev('episode.watched', 'show/c', { season: 1, episode: 1 }, NOW - 7),
			ev('tracking.added', 'show/c', { status: 'watching' }, NOW - 6),
			ev('tracking.removed', 'movie/b', {}, NOW - 5),
			ev('tracking.status_changed', 'movie/a', { status: 'completed' }, NOW - 4),
			ev('episode.unwatched', 'show/c', { season: 1, episode: 1 }, NOW - 3),
			ev('tracking.added', 'movie/d', { status: 'want_to_watch' }, NOW - 2)
		];
		return { now: stateAt(events, NOW), then: stateAt(events, NOW - 6) };
	}

	it('reports one entry per changed title, ordered by media id', () => {
		const { now, then } = states();
		const diffs = diffStates(now, then);
		expect(diffs.map((d) => d.mediaId)).toEqual(['movie/a', 'movie/b', 'movie/d', 'show/c']);
	});

	it('describes a status change, a revival and a removal', () => {
		const { now, then } = states();
		const [a, b, d] = diffStates(now, then);
		expect(a).toMatchObject({ status: 'watching', readd: false });
		expect(a.rating).toBeUndefined(); // unchanged, so it needs no event
		expect(b).toMatchObject({ readd: true, status: 'completed' });
		expect(d).toMatchObject({ remove: true });
	});

	it('describes episode watch deltas for a title that stays', () => {
		const { now, then } = states();
		const show = diffStates(now, then).find((diff) => diff.mediaId === 'show/c');
		expect(show?.episodes.watched).toEqual([{ mediaId: 'show/c', season: 1, episode: 1 }]);
		expect(show?.episodes.unwatched).toEqual([]);
	});

	it('is empty when the two states match', () => {
		const { now } = states();
		expect(diffStates(now, now)).toEqual([]);
	});
});

describe('compensatingEvents', () => {
	it('turns a rewind into the events that make now look like then', () => {
		const events = [
			ev('tracking.added', 'movie/a', { status: 'want_to_watch' }, NOW - 10),
			ev('tracking.favorite_toggled', 'movie/a', { favorite: true }, NOW - 9),
			ev('tracking.rated', 'movie/a', { rating: 5 }, NOW - 8),
			ev('episode.watched', 'show/b', { season: 2, episode: 3 }, NOW - 7),
			ev('tracking.added', 'show/b', { status: 'watching' }, NOW - 6),
			ev('tracking.removed', 'movie/a', {}, NOW - 5),
			ev('episode.unwatched', 'show/b', { season: 2, episode: 3 }, NOW - 4)
		];
		const specs = compensatingEvents(diffStates(stateAt(events, NOW), stateAt(events, NOW - 6)));
		expect(specs).toEqual([
			{
				type: 'tracking.added',
				entityId: 'movie/a',
				payload: { status: 'want_to_watch' }
			},
			{ type: 'tracking.favorite_toggled', entityId: 'movie/a', payload: { favorite: true } },
			{ type: 'tracking.rated', entityId: 'movie/a', payload: { rating: 5 } },
			{ type: 'episode.watched', entityId: 'show/b', payload: { season: 2, episode: 3 } }
		]);
	});

	it('counts exactly what it would write', () => {
		const diffs = [
			{
				mediaId: 'movie/a',
				readd: false,
				status: 'completed' as const,
				episodes: { watched: [], unwatched: [] }
			},
			{
				mediaId: 'movie/b',
				readd: false,
				remove: true,
				episodes: {
					watched: [{ mediaId: 'movie/b', season: 1, episode: 1 }],
					unwatched: []
				}
			}
		];
		expect(compensatingEventCount(diffs)).toBe(2);
	});
});

describe('summarize', () => {
	it('counts only titles on the list, and only their episodes', () => {
		const events = [
			ev('tracking.added', 'movie/a', { status: 'completed' }, NOW - 4),
			ev('tracking.added', 'movie/b', { status: 'completed' }, NOW - 3),
			ev('tracking.removed', 'movie/b', {}, NOW - 2),
			ev('episode.watched', 'show/c', { season: 1, episode: 1 }, NOW - 1),
			ev('episode.watched', 'show/c', { season: 1, episode: 2 }, NOW - 1)
		];
		// show/c has no tracking row, so its episodes aren't on the list and don't count.
		expect(summarize(stateAt(events, NOW))).toEqual({ titles: 1, episodes: 0 });
	});
});

describe('relativeAgo', () => {
	it('reads in the coarsest sensible unit', () => {
		expect(relativeAgo(0)).toBe('now');
		expect(relativeAgo(15 * MIN)).toMatch(/15 minutes? ago/);
		expect(relativeAgo(24 * 60 * MIN)).toMatch(/yesterday|1 day/);
	});
});

describe('the event step projection', () => {
	/** A log whose events interleave two titles, so order matters. */
	function log(): EventEnvelope[] {
		return orderedLog([
			ev('tracking.added', 'movie/b', { status: 'watching' }, NOW - 30),
			ev('tracking.added', 'movie/a', { status: 'watching' }, NOW - 20),
			ev('episode.watched', 'movie/b', { season: 1, episode: 1 }, NOW - 10),
			ev('tracking.removed', 'movie/a', {}, NOW - 5)
		]);
	}

	it('orders the log by clock, then id', () => {
		expect(log().map((e) => e.entityId)).toEqual(['movie/b', 'movie/a', 'movie/b', 'movie/a']);
	});

	it('counts steps as a prefix of the ordered log', () => {
		const events = log();
		expect(stateAtStep(events, 0)).toEqual({ tracking: {}, episodes: {} });
		expect(stateAtStep(events, 1).tracking['movie/b'].status).toBe('watching');
		expect(stateAtStep(events, 2).tracking['movie/a']).toBeDefined();
		expect(stateAtStep(events, 4)).toEqual(stateAt(events, Infinity));
	});

	it('names the event a step sits just after', () => {
		const events = log();
		expect(eventAtStep(events, 0)).toBeUndefined();
		expect(eventAtStep(events, 1)?.entityId).toBe('movie/b');
		expect(eventAtStep(events, 4)?.type).toBe('tracking.removed');
	});

	it('turns one event into a diff that undoes just that event', () => {
		const events = log();
		// Step 1 added movie/b: undoing it takes the title off the list again.
		expect(eventDiff(events, 1)).toMatchObject({ mediaId: 'movie/b', remove: true });
		// Step 3 watched S1E1: undoing it un-watches that episode only.
		expect(eventDiff(events, 3)).toMatchObject({
			mediaId: 'movie/b',
			episodes: { watched: [], unwatched: [{ mediaId: 'movie/b', season: 1, episode: 1 }] }
		});
		// Step 4 removed movie/a: undoing it puts the title back as it was.
		expect(eventDiff(events, 4)).toMatchObject({
			mediaId: 'movie/a',
			readd: true,
			status: 'watching'
		});
	});

	it('has nothing to undo for an event that changed nothing visible', () => {
		const events = orderedLog([
			ev('tracking.added', 'movie/a', { status: 'watching' }, NOW - 20),
			ev('tracking.favorite_toggled', 'movie/a', { favorite: false }, NOW - 10),
			ev(
				'media.linked',
				'movie/a',
				{ targetId: 'movie/a', provider: 'tmdb', externalId: '1' },
				NOW - 5
			)
		]);
		// Favoriting something that was already not a favorite.
		expect(eventDiff(events, 2)).toBeNull();
		// An identity event isn't tracking state.
		expect(eventDiff(events, 3)).toBeNull();
	});

	it('lists the titles touched after a step, newest first', () => {
		const events = log();
		expect(touchedAfterStep(events, 2)).toEqual(['movie/a', 'movie/b']);
		expect(touchedAfterStep(events, 4)).toEqual([]);
	});

	it('summarizes an event in words', () => {
		const events = log();
		expect(eventSummary(events[0])).toBe('Added · Watching');
		expect(eventSummary(events[2])).toBe('S1E1 watched');
		expect(eventSummary(events[3])).toBe('Removed from your lists');
	});
});
