/** Pure helpers for the navigation rune — split out so they're unit-testable (the `.svelte.ts`
 * rune module can't be imported under the plain-node vitest config). */

/** Back-navigation state derived from completed client-side navigations. */
export interface NavHistoryState {
	/** True once at least one in-app navigation has happened, i.e. there's an entry to pop back to. */
	readonly canGoBack: boolean;
	/** The most recent navigation's origin (`pathname + search`), or null on a cold entry. */
	readonly lastFrom: string | null;
}

/** A cold entry (full load / first paint): nothing in-app to pop back to yet. */
export const initialNavState: NavHistoryState = { canGoBack: false, lastFrom: null };

/**
 * Fold a completed navigation's `from` target into the back-tracking state. A `null` `from` is the
 * initial `enter` navigation (a fresh load / deep link) — there's no in-app entry to pop, so the
 * state is left untouched. Any real in-app navigation flips `canGoBack` on and records its origin.
 */
export function recordNavigation(
	state: NavHistoryState,
	from: URL | null | undefined
): NavHistoryState {
	if (!from) return state;
	return { canGoBack: true, lastFrom: `${from.pathname}${from.search}` };
}

/**
 * The chain origin to remember for a title entered without a carried `?from` — where the user
 * arrived from, but only home or a search (never another title), else home. Mirrors the values the
 * suggestion-chain `?from=` param carries.
 */
export function entryOrigin(lastFrom: string | null): string {
	if (!lastFrom) return '/';
	const pathname = lastFrom.split('?', 1)[0];
	return pathname === '/' || pathname === '/search' ? lastFrom : '/';
}
