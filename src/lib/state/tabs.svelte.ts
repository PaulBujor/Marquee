// Client-only tab-bar state — a rune singleton, like theme/navigation/pwa.
//
// Holds what makes the bar feel app-like rather than like four links: where you last were on each
// destination (URL *and* scroll offset), which tab owns the current detail page, and two one-shot
// signals the bar raises for a page to act on (focus the search field, offer to undo a scroll).
//
// Deliberately in-memory only. On a reload the URL is authoritative and the service worker serves
// the cached shell — resurrecting a stale per-tab URL across a cold boot would be surprising.

import { activeTab, tabHref, type TabId } from './tabs';

type UrlMemory = Record<TabId, string | null>;
type ScrollMemory = Record<TabId, number>;

function emptyUrls(): UrlMemory {
	return { dashboard: null, timeline: null, settings: null, search: null };
}

function emptyScroll(): ScrollMemory {
	return { dashboard: 0, timeline: 0, settings: 0, search: 0 };
}

export class TabsState {
	/** Last `pathname + search` seen on each tab. Reactive — the bar's hrefs read it directly. */
	#urls = $state<UrlMemory>(emptyUrls());
	/** Last scroll offset on each tab. Never rendered, so it doesn't need to be reactive. */
	#scroll: ScrollMemory = emptyScroll();
	/** The last tab route visited — what a title page (which is no tab's route) shows as selected. */
	#owner = $state<TabId>('dashboard');
	/** Set just before a tab-bar navigation, consumed once on arrival. See `takeRestore`. */
	#pendingRestore: TabId | null = null;

	/** Monotonic ticket: incrementing it asks the search page to focus its field. A counter rather
	 * than a flag so repeated taps re-fire, and so it doesn't matter whether the request is raised
	 * before or after that page mounts. */
	searchFocusRequest = $state(0);

	/** Scroll offset a re-tap of the dashboard scrolled away from, while the undo pill is offered. */
	undoOffer = $state<number | null>(null);

	get owner(): TabId {
		return this.#owner;
	}

	/** Where a tab should link to right now. */
	href(id: TabId): string {
		return tabHref(id, this.#urls[id]);
	}

	/** Fold a completed navigation into the per-tab URL memory. Non-tab routes leave it untouched,
	 * so opening a title keeps the tab it was opened from as the owner. */
	record(url: URL): void {
		const id = activeTab(url.pathname);
		if (!id) return;
		this.#urls[id] = `${url.pathname}${url.search}`;
		this.#owner = id;
	}

	/** Remember where a tab was scrolled to, on the way out of it. */
	captureScroll(pathname: string, y: number): void {
		const id = activeTab(pathname);
		if (!id) return;
		this.#scroll[id] = y;
	}

	/** Mark the next navigation as tab-initiated, so its arrival restores the remembered scroll. */
	armRestore(id: TabId): void {
		this.#pendingRestore = id;
	}

	/**
	 * Consume an armed restore, returning the offset to scroll to or null when this arrival isn't
	 * ours (a link, a back/forward, a cold entry — all of which keep SvelteKit's own behaviour).
	 * One-shot and unconditional: a superseded or mismatched arm is cleared rather than left to fire
	 * on some later navigation.
	 */
	takeRestore(id: TabId | null): number | null {
		const pending = this.#pendingRestore;
		this.#pendingRestore = null;
		if (pending === null || pending !== id) return null;
		return this.#scroll[pending];
	}

	requestSearchFocus(): void {
		this.searchFocusRequest += 1;
	}

	offerUndo(y: number): void {
		this.undoOffer = y;
	}

	clearUndo(): void {
		this.undoOffer = null;
	}

	/** Drop everything on logout / account switch — one user's filters must not reach the next. */
	reset(): void {
		this.#urls = emptyUrls();
		this.#scroll = emptyScroll();
		this.#owner = 'dashboard';
		this.#pendingRestore = null;
		this.undoOffer = null;
	}
}

export const tabs = new TabsState();
