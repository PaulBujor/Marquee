import { describe, expect, it } from 'vitest';
import {
	allEpisodes,
	nextEpisode,
	nextFavorite,
	seasonEpisodes,
	statusEventType,
	toTrackingView,
	watchedKey
} from './actions';

describe('toTrackingView', () => {
	it('treats a missing row as untracked', () => {
		expect(toTrackingView(undefined)).toEqual({ tracked: false });
	});

	it('treats a removed (tombstoned) row as untracked', () => {
		expect(toTrackingView({ status: 'completed', favorite: true, removed: true })).toEqual({
			tracked: false
		});
	});

	it('exposes status and favorite for a live row', () => {
		expect(toTrackingView({ status: 'watching', favorite: true, removed: false })).toEqual({
			tracked: true,
			status: 'watching',
			favorite: true
		});
	});
});

describe('statusEventType', () => {
	it('adds when the title is not yet tracked', () => {
		expect(statusEventType({ tracked: false })).toBe('tracking.added');
	});

	it('changes status when the title is already tracked', () => {
		expect(statusEventType({ tracked: true, status: 'want_to_watch', favorite: false })).toBe(
			'tracking.status_changed'
		);
	});
});

describe('nextFavorite', () => {
	it('favorites an untracked title (implicit add)', () => {
		expect(nextFavorite({ tracked: false })).toBe(true);
	});

	it('toggles off when already favorited', () => {
		expect(nextFavorite({ tracked: true, status: 'watching', favorite: true })).toBe(false);
	});

	it('toggles on when tracked but not favorited', () => {
		expect(nextFavorite({ tracked: true, status: 'watching', favorite: false })).toBe(true);
	});
});

describe('episode helpers', () => {
	it('builds a stable watched key', () => {
		expect(watchedKey(2, 5)).toBe('2:5');
	});

	it('enumerates a season 1..episodeCount', () => {
		expect(seasonEpisodes({ seasonNumber: 1, episodeCount: 3 })).toEqual([
			{ season: 1, episode: 1 },
			{ season: 1, episode: 2 },
			{ season: 1, episode: 3 }
		]);
	});

	it('flattens all real seasons, skipping Specials (season 0)', () => {
		const seasons = [
			{ seasonNumber: 0, episodeCount: 4 },
			{ seasonNumber: 1, episodeCount: 2 },
			{ seasonNumber: 2, episodeCount: 1 }
		];
		expect(allEpisodes(seasons)).toEqual([
			{ season: 1, episode: 1 },
			{ season: 1, episode: 2 },
			{ season: 2, episode: 1 }
		]);
	});
});

describe('nextEpisode', () => {
	const seasons = [
		{ seasonNumber: 0, episodeCount: 3 }, // Specials — ignored
		{ seasonNumber: 1, episodeCount: 2 },
		{ seasonNumber: 2, episodeCount: 2 }
	];

	it('returns S1E1 when nothing is watched', () => {
		expect(nextEpisode(seasons, new Set())).toEqual({ season: 1, episode: 1 });
	});

	it('returns the first gap in order across seasons', () => {
		const watched = new Set(['1:1', '1:2']);
		expect(nextEpisode(seasons, watched)).toEqual({ season: 2, episode: 1 });
	});

	it('skips already-watched episodes even mid-season', () => {
		const watched = new Set(['1:1']);
		expect(nextEpisode(seasons, watched)).toEqual({ season: 1, episode: 2 });
	});

	it('returns null once every real episode is watched', () => {
		const watched = new Set(['1:1', '1:2', '2:1', '2:2']);
		expect(nextEpisode(seasons, watched)).toBeNull();
	});
});
