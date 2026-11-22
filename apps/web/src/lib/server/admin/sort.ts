import { asc, desc, type SQL } from 'drizzle-orm';

export type SortDir = 'asc' | 'desc';

export interface SortSpec<Key extends string> {
	key: Key;
	dir: SortDir;
}

// The key arrives from the URL and lands in an ORDER BY, so it is only ever a lookup — never interpolated text.
export function parseSort<Key extends string>(
	raw: string | null,
	allowed: readonly Key[],
	fallback: SortSpec<Key>
): SortSpec<Key> {
	const [key, dir] = (raw ?? '').split(':');
	if (!allowed.includes(key as Key)) return fallback;
	return { key: key as Key, dir: dir === 'asc' || dir === 'desc' ? dir : fallback.dir };
}

export function orderBy<Key extends string>(
	columns: Record<Key, SQL | Parameters<typeof asc>[0]>,
	spec: SortSpec<Key>
) {
	return spec.dir === 'asc' ? asc(columns[spec.key]) : desc(columns[spec.key]);
}
