/** Pure helpers for the bottom tab bar — split out from the rune singleton so they're unit-testable
 * (the same split `navigation-util.ts` uses) and so the bar component stays declarative. */

export type TabId = 'dashboard' | 'timeline' | 'settings' | 'search';

/** Route each tab owns. `/` is the dashboard; the rest also own everything nested beneath them. */
export const TAB_PATHS = {
	dashboard: '/',
	timeline: '/timeline',
	settings: '/settings',
	search: '/search'
} as const satisfies Record<TabId, string>;

export interface TabDef {
	readonly id: TabId;
	readonly label: string;
	readonly path: string;
}

/** Display order. Search sits at the trailing edge, where the thumb rests. The timeline route is
 * labelled "Upcoming" here because that's what it's called everywhere else in the app. */
export const TABS: readonly TabDef[] = [
	{ id: 'dashboard', label: 'Dashboard', path: TAB_PATHS.dashboard },
	{ id: 'timeline', label: 'Upcoming', path: TAB_PATHS.timeline },
	{ id: 'settings', label: 'Settings', path: TAB_PATHS.settings },
	{ id: 'search', label: 'Search', path: TAB_PATHS.search }
];

/** Which tab owns a pathname, or null for a route that isn't a tab (a title page, login). */
export function activeTab(pathname: string): TabId | null {
	const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
	if (path === '' || path === '/') return 'dashboard';
	for (const tab of TABS) {
		if (tab.path === '/') continue;
		if (path === tab.path || path.startsWith(`${tab.path}/`)) return tab.id;
	}
	return null;
}

/**
 * Where a tab should link to: the URL last visited on it (so its filters / query come back), or its
 * root. A remembered value is only trusted when it's a same-origin path that still belongs to this
 * tab — so a stale or corrupt entry can never point a tab at another route, or off-site.
 */
export function tabHref(id: TabId, remembered: string | null): string {
	const root = TAB_PATHS[id];
	if (!remembered || !remembered.startsWith('/') || remembered.startsWith('//')) return root;
	return activeTab(remembered.split('?', 1)[0]) === id ? remembered : root;
}

/** Below this scroll offset a re-tap isn't worth offering an undo for. */
export const SCROLL_UNDO_MIN = 400;

export type TabAction =
	| { kind: 'navigate'; to: string; focusSearch: boolean }
	| { kind: 'scroll-top'; undoFrom: number | null }
	| { kind: 'focus-search' };

export interface TabActionInput {
	/** The tapped tab. */
	id: TabId;
	/** The route currently displayed — not the *selected* tab, which lags on a title page. */
	currentPath: string;
	/** That tab's remembered URL, if any. */
	remembered: string | null;
	/** Current window scroll offset. */
	scrollY: number;
}

/**
 * What tapping a tab should do. Tapping a tab you're not on navigates; tapping the one you're
 * already on acts on the page instead — search focuses its field (no double tap needed), everything
 * else scrolls to the top. Only the dashboard offers to undo that scroll, and only from far enough
 * down to be worth rebuilding: its position is expensive (deep pagination + filters), while the
 * other destinations are cheap to scroll back through.
 */
export function tabAction({ id, currentPath, remembered, scrollY }: TabActionInput): TabAction {
	if (activeTab(currentPath) !== id) {
		return { kind: 'navigate', to: tabHref(id, remembered), focusSearch: id === 'search' };
	}
	if (id === 'search') return { kind: 'focus-search' };
	const undoFrom = id === 'dashboard' && scrollY >= SCROLL_UNDO_MIN ? scrollY : null;
	return { kind: 'scroll-top', undoFrom };
}

/** Viewport shrinkage that counts as an open soft keyboard. */
export const KEYBOARD_MIN_DELTA = 150;

/** Whether the soft keyboard is covering the viewport, so the fixed bar should get out of the way. */
export function isKeyboardOpen(innerHeight: number, viewportHeight: number | null): boolean {
	if (viewportHeight === null) return false;
	return innerHeight - viewportHeight >= KEYBOARD_MIN_DELTA;
}

/** Scroll offset below which the bar is always expanded. */
export const COMPACT_ANCHOR = 80;
/** Downward travel that collapses the labels. */
export const COMPACT_DOWN = 24;
/** Upward travel that brings them back — smaller, so restoring feels immediate. */
export const COMPACT_UP = 8;

export interface ScrollPhase {
	readonly lastY: number;
	/** Signed travel accumulated since the last direction change. */
	readonly travel: number;
	readonly compact: boolean;
}

export const initialScrollPhase: ScrollPhase = { lastY: 0, travel: 0, compact: false };

/**
 * Fold a scroll position into the bar's compact state. Travel accumulates in one direction and
 * resets when the direction flips, so a few pixels of jitter can't flap the labels; the thresholds
 * are asymmetric so collapsing reads as deliberate and restoring as instant. Near the top the bar
 * is always full, and near the bottom the state is held — iOS rubber-band overscroll otherwise
 * arrives as one large downward burst.
 *
 * `maxY` is the maximum scrollable offset (`scrollHeight - innerHeight`).
 */
export function foldScroll(phase: ScrollPhase, y: number, maxY: number): ScrollPhase {
	if (y <= COMPACT_ANCHOR) return { lastY: y, travel: 0, compact: false };
	if (maxY > 0 && y >= maxY - COMPACT_ANCHOR) return { ...phase, lastY: y };

	const delta = y - phase.lastY;
	if (delta === 0) return phase;

	const sameDirection = phase.travel === 0 || Math.sign(phase.travel) === Math.sign(delta);
	const travel = (sameDirection ? phase.travel : 0) + delta;

	if (travel >= COMPACT_DOWN) return { lastY: y, travel: 0, compact: true };
	if (travel <= -COMPACT_UP) return { lastY: y, travel: 0, compact: false };
	return { lastY: y, travel, compact: phase.compact };
}
