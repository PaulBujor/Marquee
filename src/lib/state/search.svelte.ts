// Client-only search-overlay state — mirrors the ThemeState/PwaState singleton pattern.
//
// Search is an in-place overlay (not a route) so that opening it can focus the input
// *synchronously within the triggering tap gesture*. That's the only way mobile browsers
// raise the soft keyboard — a programmatic `.focus()` after a navigation is ignored on
// iOS (and unreliable on Android).

class SearchState {
	isOpen = $state(false);
	/** The search `<input>`, registered by the overlay so `open()` can focus it synchronously. */
	input: HTMLInputElement | null = null;
	/** The overlay panel, so `open()` can clear `inert` before focusing (the state flip renders async). */
	panel: HTMLElement | null = null;

	open() {
		// While closed the panel is `inert`, which blocks focus; clear it synchronously and
		// focus in the same gesture so the mobile keyboard opens. The reactive `inert={!isOpen}`
		// binding then settles to the same value once `isOpen` flips.
		if (this.panel) this.panel.inert = false;
		this.input?.focus();
		this.isOpen = true;
	}

	close() {
		this.isOpen = false;
		this.input?.blur();
	}
}

export const search = new SearchState();
