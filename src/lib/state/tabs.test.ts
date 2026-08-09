import { describe, expect, it } from 'vitest';
import {
	COMPACT_ANCHOR,
	COMPACT_DOWN,
	COMPACT_UP,
	SCROLL_UNDO_MIN,
	activeTab,
	foldScroll,
	initialScrollPhase,
	isKeyboardOpen,
	tabAction,
	tabHref,
	viewportShift,
	type ScrollPhase
} from './tabs';

describe('activeTab', () => {
	it('maps each tab root to its id', () => {
		expect(activeTab('/')).toBe('dashboard');
		expect(activeTab('/timeline')).toBe('timeline');
		expect(activeTab('/settings')).toBe('settings');
		expect(activeTab('/search')).toBe('search');
	});

	it('treats an empty path as the dashboard', () => {
		expect(activeTab('')).toBe('dashboard');
	});

	it('ignores a trailing slash', () => {
		expect(activeTab('/timeline/')).toBe('timeline');
		expect(activeTab('/search/')).toBe('search');
	});

	it('claims routes nested under a tab', () => {
		expect(activeTab('/settings/notifications')).toBe('settings');
	});

	it('returns null for routes that belong to no tab', () => {
		expect(activeTab('/title/movie/123')).toBeNull();
		expect(activeTab('/login')).toBeNull();
		expect(activeTab('/nope')).toBeNull();
	});

	it("doesn't match a route that merely starts with a tab's path", () => {
		expect(activeTab('/settingsomething')).toBeNull();
	});
});

describe('tabHref', () => {
	it('returns the remembered URL, query included', () => {
		expect(tabHref('search', '/search?q=dune')).toBe('/search?q=dune');
		expect(tabHref('dashboard', '/?tab=watching&sort=title')).toBe('/?tab=watching&sort=title');
	});

	it('falls back to the tab root when nothing is remembered', () => {
		expect(tabHref('timeline', null)).toBe('/timeline');
		expect(tabHref('dashboard', null)).toBe('/');
	});

	it('rejects a remembered value belonging to another tab', () => {
		expect(tabHref('search', '/settings')).toBe('/search');
		expect(tabHref('dashboard', '/title/movie/1')).toBe('/');
	});

	it('rejects anything that could leave the origin', () => {
		expect(tabHref('search', '//evil.example/search')).toBe('/search');
		expect(tabHref('search', 'https://evil.example/search')).toBe('/search');
		expect(tabHref('search', 'search?q=x')).toBe('/search');
	});
});

describe('tabAction', () => {
	const base = { remembered: null, scrollY: 0 };

	it('navigates when the tapped tab is not the current route', () => {
		expect(tabAction({ ...base, id: 'timeline', currentPath: '/' })).toEqual({
			kind: 'navigate',
			to: '/timeline',
			focusSearch: false
		});
	});

	it('navigates to the remembered URL when there is one', () => {
		expect(
			tabAction({ ...base, id: 'search', currentPath: '/', remembered: '/search?q=alien' })
		).toEqual({ kind: 'navigate', to: '/search?q=alien', focusSearch: true });
	});

	it('asks for focus only when navigating to search', () => {
		expect(tabAction({ ...base, id: 'settings', currentPath: '/' })).toMatchObject({
			focusSearch: false
		});
		expect(tabAction({ ...base, id: 'search', currentPath: '/' })).toMatchObject({
			focusSearch: true
		});
	});

	it('focuses instead of navigating when already on search', () => {
		expect(tabAction({ ...base, id: 'search', currentPath: '/search', scrollY: 900 })).toEqual({
			kind: 'focus-search'
		});
	});

	it('scrolls to the top when re-tapping the current tab', () => {
		expect(tabAction({ ...base, id: 'timeline', currentPath: '/timeline', scrollY: 5000 })).toEqual(
			{ kind: 'scroll-top', undoFrom: null }
		);
		expect(tabAction({ ...base, id: 'settings', currentPath: '/settings', scrollY: 5000 })).toEqual(
			{ kind: 'scroll-top', undoFrom: null }
		);
	});

	it('offers an undo only on the dashboard, and only from far enough down', () => {
		const at = (scrollY: number) =>
			tabAction({ ...base, id: 'dashboard', currentPath: '/', scrollY });
		expect(at(SCROLL_UNDO_MIN - 1)).toEqual({ kind: 'scroll-top', undoFrom: null });
		expect(at(SCROLL_UNDO_MIN)).toEqual({ kind: 'scroll-top', undoFrom: SCROLL_UNDO_MIN });
		expect(at(5000)).toEqual({ kind: 'scroll-top', undoFrom: 5000 });
	});

	it('treats a title page as no tab, so the owning tab still navigates', () => {
		expect(
			tabAction({ ...base, id: 'dashboard', currentPath: '/title/movie/1', scrollY: 3000 })
		).toEqual({ kind: 'navigate', to: '/', focusSearch: false });
	});
});

describe('isKeyboardOpen', () => {
	it('is false without a visual viewport to compare against', () => {
		expect(isKeyboardOpen(800, null)).toBe(false);
	});

	it('needs the viewport to shrink by the threshold', () => {
		expect(isKeyboardOpen(800, 800)).toBe(false);
		expect(isKeyboardOpen(800, 660)).toBe(false);
		expect(isKeyboardOpen(800, 650)).toBe(true);
		expect(isKeyboardOpen(800, 400)).toBe(true);
	});
});

describe('viewportShift', () => {
	// Measured on an iPhone 15 Pro running the installed app: a 393x852 screen that paints only 793
	// until the first touch — short by the 59px status bar — then re-lays-out to the full height.
	const iphone = {
		screenWidth: 393,
		screenHeight: 852,
		innerWidth: 393,
		innerHeight: 793,
		standalone: true
	};

	it('fills the strip left unpainted before the first touch', () => {
		expect(viewportShift({ ...iphone, visualBottom: 793 })).toBe(59);
	});

	it('drops to zero once the page re-lays-out to the full screen', () => {
		// The regression this replaced: holding the shift here pushed the bar off the bottom, because
		// `bottom: 0` has already corrected itself by this point.
		expect(viewportShift({ ...iphone, visualBottom: 852, innerHeight: 852 })).toBe(0);
	});

	it('never consults the screen in a browser tab, where the window is not the screen', () => {
		// A tab is usually far shorter than the display; treating the difference as a shift would
		// throw the bar way past the bottom of the window.
		expect(viewportShift({ ...iphone, visualBottom: 793, standalone: false })).toBe(0);
		expect(viewportShift({ ...iphone, visualBottom: 400, standalone: false })).toBe(0);
	});

	it('picks the screen edge matching the current orientation', () => {
		// Landscape: `screen` still calls 852 its height, which would otherwise read as a 459px
		// shortfall and fling the bar far below the screen.
		expect(viewportShift({ ...iphone, visualBottom: 393, innerWidth: 852, innerHeight: 393 })).toBe(
			0
		);
	});

	it('never returns a negative shift', () => {
		expect(viewportShift({ ...iphone, visualBottom: 900, innerHeight: 900 })).toBe(0);
	});
});

describe('foldScroll', () => {
	const MAX = 10_000;
	const at = (y: number, compact = false, travel = 0, lastY = y): ScrollPhase => ({
		lastY,
		travel,
		compact
	});

	it('stays expanded near the top whatever the travel', () => {
		const phase = foldScroll(at(0, true, 500, 0), COMPACT_ANCHOR, MAX);
		expect(phase.compact).toBe(false);
		expect(phase.travel).toBe(0);
	});

	it('collapses once the downward travel reaches the threshold', () => {
		const start = at(200);
		const short = foldScroll(start, 200 + COMPACT_DOWN - 1, MAX);
		expect(short.compact).toBe(false);
		expect(foldScroll(start, 200 + COMPACT_DOWN, MAX).compact).toBe(true);
	});

	it('accumulates travel across several small scrolls', () => {
		let phase = at(200);
		for (const y of [206, 212, 218, 224]) phase = foldScroll(phase, y, MAX);
		expect(phase.compact).toBe(true);
	});

	it('restores on a smaller upward travel', () => {
		const collapsed = at(600, true);
		expect(foldScroll(collapsed, 600 - COMPACT_UP + 1, MAX).compact).toBe(true);
		expect(foldScroll(collapsed, 600 - COMPACT_UP, MAX).compact).toBe(false);
	});

	it('never flaps on jitter below both thresholds', () => {
		let phase = at(600, false);
		for (let i = 0; i < 10; i++) {
			phase = foldScroll(phase, 605, MAX);
			phase = foldScroll(phase, 600, MAX);
		}
		expect(phase.compact).toBe(false);
	});

	it('resets accumulated travel when the direction flips', () => {
		// 20px down (short of collapsing), then 5px up — the reversal must discard the 20, not net to 15.
		let phase = foldScroll(at(400), 420, MAX);
		expect(phase.travel).toBe(20);
		phase = foldScroll(phase, 415, MAX);
		expect(phase.travel).toBe(-5);
		expect(phase.compact).toBe(false);
	});

	it('holds state through overscroll at the end of the document', () => {
		const collapsed = at(MAX - 200, true);
		const bounced = foldScroll(collapsed, MAX - 10, MAX);
		expect(bounced.compact).toBe(true);
		expect(bounced.lastY).toBe(MAX - 10);
	});

	it('ignores a scroll event that did not move', () => {
		const phase = at(600, true, 5);
		expect(foldScroll(phase, 600, MAX)).toBe(phase);
	});

	it('starts expanded', () => {
		expect(initialScrollPhase.compact).toBe(false);
	});
});
