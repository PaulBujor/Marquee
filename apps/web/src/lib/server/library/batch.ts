/**
 * Limits and wire shape for the bulk library endpoint.
 *
 * These live here rather than beside the handler because SvelteKit only permits handler exports from
 * a route module — anything else fails the build with `invalid_export`, which no type check catches.
 */

/** Ceiling on one batch, because a truncated import that reports success is worse than a refused one. */
export const LIBRARY_BATCH_MAX = 500;

/** Why one item of a batch could not be applied. `unresolved` is permanent, `upstream_unavailable` retryable. */
export type LibraryBatchFailureCode = 'unresolved' | 'not_found' | 'upstream_unavailable';

export interface LibraryBatchResult {
	applied: number;
	unchanged: number;
	failed: { id: string; code: LibraryBatchFailureCode; reason: string }[];
}
