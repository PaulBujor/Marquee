import { describe, expect, it } from 'vitest';
import { nextFavorite, statusEventType, toTrackingView } from './actions';

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
