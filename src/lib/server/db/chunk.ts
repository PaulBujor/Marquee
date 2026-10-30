/** D1 caps bound params at 100 but better-sqlite3 (tests) does not, so unchunked queries only fail in production. */
export const D1_MAX_BOUND_PARAMS = 100;

/** Deliberately below the cap to leave room for the other bound values a query carries. */
export const ID_CHUNK = 90;

/** Split `items` into runs of at most `size`. An empty input yields no chunks. */
export function chunkBySize<T>(items: T[], size: number): T[][] {
	if (items.length === 0) return [];
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
	return chunks;
}

export function chunkIds<T>(ids: T[]): T[][] {
	return chunkBySize(ids, ID_CHUNK);
}

/** Chunk size derives from the row's column count — a 50-row insert of an 8-column table is 400 params. */
export function chunkRows<T extends object>(rows: T[]): T[][] {
	if (rows.length === 0) return [];
	const paramsPerRow = Object.keys(rows[0]).length;
	return chunkBySize(rows, Math.max(1, Math.floor(D1_MAX_BOUND_PARAMS / paramsPerRow)));
}
