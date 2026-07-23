/**
 * Pure decision helpers for the detail-page tracking controls. Kept free of any
 * IndexedDB/DOM dependency so the branching (add vs. change status, favorite
 * toggle direction) is unit-testable; the component composes these with
 * `recordEvent`. See `TrackingControls.svelte`.
 */
import type { TrackingStatus } from '$lib/sync/events';

/** The user-facing tracking state of a title, derived from its local tracking row. */
export type TrackingView =
	{ tracked: false } | { tracked: true; status: TrackingStatus; favorite: boolean };

/** Minimal shape of a local tracking row this module reads (see `ClientTracking`). */
interface TrackingRow {
	status: TrackingStatus;
	favorite: boolean;
	removed: boolean;
}

/** Collapse a local tracking row (or its absence) into a view. A removed row reads as untracked. */
export function toTrackingView(row: TrackingRow | undefined): TrackingView {
	if (!row || row.removed) return { tracked: false };
	return { tracked: true, status: row.status, favorite: row.favorite };
}

/**
 * Which event a status change emits: the first status on an untracked title is an
 * `added` (which asserts the row); any later change is a `status_changed`.
 */
export function statusEventType(view: TrackingView): 'tracking.added' | 'tracking.status_changed' {
	return view.tracked ? 'tracking.status_changed' : 'tracking.added';
}

/** The favorite value a toggle should write next — favoriting an untracked title implicitly adds it. */
export function nextFavorite(view: TrackingView): boolean {
	return !(view.tracked && view.favorite);
}
