/**
 * D1 bound-parameter chunking, in one place.
 *
 * D1 caps bound parameters per query at 100. Exceeding it fails at runtime with "too many SQL
 * variables" — and **not** in tests: the in-memory better-sqlite3 the suite runs against has no
 * such cap, so an unchunked query passes locally and fails in production. That asymmetry is why
 * this lives in a shared module rather than being re-derived per call site.
 */

/** D1's hard ceiling on bound parameters in a single query. */
export const D1_MAX_BOUND_PARAMS = 100;

/**
 * Chunk size for a list of ids spliced into one `IN (...)` predicate. Deliberately below
 * {@link D1_MAX_BOUND_PARAMS} to leave room for the other bound values a query carries.
 */
export const ID_CHUNK = 90;

/** Split `items` into runs of at most `size`. An empty input yields no chunks. */
export function chunkBySize<T>(items: T[], size: number): T[][] {
	if (items.length === 0) return [];
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
	return chunks;
}

/** Split an id list for an `IN (...)` predicate, at {@link ID_CHUNK} per query. */
export function chunkIds<T>(ids: T[]): T[][] {
	return chunkBySize(ids, ID_CHUNK);
}

/**
 * Split rows for a multi-row insert, deriving the chunk size from the row's column count — a
 * 50-row insert of an 8-column table is 400 bound parameters and would fail on D1.
 */
export function chunkRows<T extends object>(rows: T[]): T[][] {
	if (rows.length === 0) return [];
	const paramsPerRow = Object.keys(rows[0]).length;
	return chunkBySize(rows, Math.max(1, Math.floor(D1_MAX_BOUND_PARAMS / paramsPerRow)));
}
