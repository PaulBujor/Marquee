import type { Snippet } from 'svelte';

export interface Column<Row> {
	/** Sort key. Validated server-side against a literal column map, never interpolated into SQL. */
	key: string;
	label: string;
	sortable?: boolean;
	end?: boolean;
	cell: Snippet<[Row]>;
}
