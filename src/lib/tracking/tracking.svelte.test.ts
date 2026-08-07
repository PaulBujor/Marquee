import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { getEpisodeWatches, getTrackingByMediaId, setActiveUser } from '$lib/client/idb';
import { TrackingState } from './tracking.svelte';
import type { SeasonSummary } from './actions';

setActiveUser('test-user'); // the store is namespaced per user; scope it before opening

// `#inProduction` used to be captured once in the constructor and never refreshed, unlike
// `#seasons` (`updateSeasons`). A show that finishes after the page mounted stayed stuck against
// a stale `inProduction: true` until the instance was recreated (reload/re-navigation).
describe('TrackingState.updateInProduction', () => {
	const TODAY_SEASON: SeasonSummary[] = [
		{ seasonNumber: 1, episodeCount: 8, airDate: '2020-01-01' }
	];

	it('feeds a fresh production status into readiness checks without recreating the instance', () => {
		const state = new TrackingState('test-media-id', null, TODAY_SEASON);
		state.updateInProduction(true);
		// Still (believed) in production, no per-episode data yet — an aired season can't be
		// enumerated from the count alone.
		expect(state.readyToMarkSeries()).toBe(false);

		state.updateInProduction(false);
		// Now known finished — the episodeCount fallback resolves the aired season.
		expect(state.readyToMarkSeries()).toBe(true);
	});
});

/**
 * MRQ-210 part 1: readiness used to be enforced only by the `disabled` binding on the calling
 * buttons — `markSeriesWatched`/`markSeasonWatched` themselves would write regardless. These drive
 * the real write path (through the actual event pipeline, into real — fake-indexeddb-backed —
 * IndexedDB) so a regression that re-opens the bypass shows up as an actual persisted write, not
 * just a readiness-flag assertion.
 */
describe('TrackingState.markSeriesWatched / markSeasonWatched — readiness enforced on the write path', () => {
	// A weekly show that premiered two months ago with only 5 of 10 episodes actually out — TMDB's
	// `in_production` hasn't synced to this device yet, so it reads `null` (unknown), and no
	// per-episode data has synced either. This is exactly the MRQ-210 scenario: the disabled binding
	// would normally prevent the click, but the guard inside the method is what actually matters.
	const unairedWeeklyShow: SeasonSummary[] = [
		{ seasonNumber: 1, episodeCount: 10, airDate: '2026-05-24' }
	];

	it('markSeriesWatched no-ops when not ready, even called directly (bypassing the disabled button)', async () => {
		const mediaId = 'unaired-weekly-show-series';
		const state = new TrackingState(mediaId, null, unairedWeeklyShow);
		state.updateInProduction(null);
		expect(state.readyToMarkSeries()).toBe(false);

		await state.markSeriesWatched();

		// Nothing written: not even the implicit "add to watching" that a real mark would trigger.
		expect(await getTrackingByMediaId(mediaId)).toBeUndefined();
		expect(await getEpisodeWatches(mediaId)).toEqual([]);
	});

	it('markSeasonWatched no-ops when not ready, even called directly (bypassing the disabled button)', async () => {
		const mediaId = 'unaired-weekly-show-season';
		const state = new TrackingState(mediaId, null, unairedWeeklyShow);
		state.updateInProduction(null);
		expect(state.readyToMarkSeason(1)).toBe(false);

		await state.markSeasonWatched(1);

		expect(await getTrackingByMediaId(mediaId)).toBeUndefined();
		expect(await getEpisodeWatches(mediaId)).toEqual([]);
	});

	it('markSeriesWatched still seeds a confirmed-finished show with no per-episode records synced', async () => {
		const mediaId = 'finished-show-no-episode-records';
		// TMDB confirms the show wrapped (inProduction: false, not null) and the season aired, but
		// per-episode rows were never synced — the confirmed-finished fallback should still resolve
		// the whole season by its episodeCount (MRQ-210 option B: trust TMDB's count once finished).
		const finished: SeasonSummary[] = [{ seasonNumber: 1, episodeCount: 3, airDate: '2020-01-01' }];
		const state = new TrackingState(mediaId, null, finished);
		state.updateInProduction(false);
		expect(state.readyToMarkSeries()).toBe(true);

		await state.markSeriesWatched();

		const watched = await getEpisodeWatches(mediaId);
		expect(
			watched
				.filter((e) => e.watched)
				.map((e) => `${e.season}:${e.episode}`)
				.sort()
		).toEqual(['1:1', '1:2', '1:3']);
	});
});
