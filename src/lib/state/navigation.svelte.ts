// Client-only back-navigation state — a rune singleton, like theme/pwa/notifications.
//
// The single source of truth for "is there an in-app entry to pop back to" and "where did we come
// from". It's fed by ONE `afterNavigate` in the persistent root layout, so it reliably captures
// every navigation. Per-page back controls used to run their own `afterNavigate`, but that fires
// from `onMount` — a component that mounts *after* the navigation settles (e.g. the title page
// upgrading its skeleton to content, or any base-less hard reload) registers too late and never
// sees the entering navigation, so its back button wrongly fell back to home. Reading this shared
// state instead makes the decision independent of when a control happens to mount.

import {
	initialNavState,
	recordNavigation,
	entryOrigin,
	type NavHistoryState
} from './navigation-util';

class NavigationState {
	#history = $state<NavHistoryState>(initialNavState);

	/** Whether there's an in-app history entry to pop (else a back control uses its fallback). */
	get canGoBack(): boolean {
		return this.#history.canGoBack;
	}

	/** The origin (`pathname + search`) of the most recent navigation, or null on a cold entry. */
	get lastFrom(): string | null {
		return this.#history.lastFrom;
	}

	/** The chain origin (home / a search) to return to for a freshly-entered title — see the helper. */
	get entryOrigin(): string {
		return entryOrigin(this.#history.lastFrom);
	}

	/** Record a completed navigation. Called once, from the root layout's `afterNavigate`. */
	record(from: URL | null | undefined): void {
		this.#history = recordNavigation(this.#history, from);
	}
}

export const navigation = new NavigationState();
