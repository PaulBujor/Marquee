import { describe, expect, it } from 'vitest';
import { TrackingState } from './tracking.svelte';
import type { SeasonSummary } from './actions';

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
