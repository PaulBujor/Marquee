<!--
	One table for every viewport, not a table that becomes cards. Narrow screens scroll it sideways: the first
	column stays pinned so the row is always identifiable, and a fade on the right edge hints that there is more.
	Sorting and paging are GET submissions, so both work without JavaScript and no query string is ever appended
	to a resolve()d path.
-->
<script lang="ts" generics="Row">
	import type { Column } from './types.js';

	let {
		base,
		columns,
		rows,
		sortKey,
		sortDir,
		params = {},
		empty = 'Nothing to show.'
	}: {
		base: string;
		columns: Column<Row>[];
		rows: Row[];
		sortKey?: string;
		sortDir?: 'asc' | 'desc';
		params?: Record<string, string | number | undefined>;
		empty?: string;
	} = $props();

	/** Encodes the toggle into the value itself, so flipping direction needs no JavaScript. */
	function nextValue(key: string): string {
		return key === sortKey ? `${key}:${sortDir === 'asc' ? 'desc' : 'asc'}` : `${key}:asc`;
	}

	function ariaSort(key: string): 'ascending' | 'descending' | undefined {
		if (key !== sortKey) return undefined;
		return sortDir === 'asc' ? 'ascending' : 'descending';
	}
</script>

<form method="GET" action={base}>
	{#each Object.entries(params) as [name, value] (name)}
		{#if value !== undefined && value !== ''}
			<input type="hidden" {name} value={String(value)} />
		{/if}
	{/each}

	<div class="relative mt-2 overflow-hidden rounded-lg border">
		<div class="overflow-x-auto overscroll-x-contain">
			<table class="w-full border-collapse text-sm">
				<thead>
					<tr class="border-b text-left text-xs text-muted-foreground">
						{#each columns as column, index (column.key)}
							<th
								scope="col"
								class="bg-background px-3 py-2 font-normal whitespace-nowrap sm:px-4 {index === 0
									? 'sticky left-0 z-10 border-r'
									: ''} {column.end ? 'text-right' : ''}"
								aria-sort={ariaSort(column.key)}
							>
								{#if column.sortable}
									<button
										type="submit"
										name="sort"
										value={nextValue(column.key)}
										class="inline-flex items-center gap-1 hover:text-foreground"
									>
										{column.label}
										{#if column.key === sortKey}
											<span aria-hidden="true">{sortDir === 'asc' ? '↑' : '↓'}</span>
										{/if}
									</button>
								{:else}
									{column.label}
								{/if}
							</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each rows as row, rowIndex (rowIndex)}
						<tr class="border-b last:border-0">
							{#each columns as column, index (column.key)}
								<td
									class="px-3 py-2 align-top whitespace-nowrap sm:px-4 {index === 0
										? 'sticky left-0 z-10 border-r bg-background'
										: ''} {column.end ? 'text-right' : ''}"
								>
									{@render column.cell(row)}
								</td>
							{/each}
						</tr>
					{:else}
						<tr>
							<td class="px-4 py-6 text-center text-muted-foreground" colspan={columns.length}>
								{empty}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<!-- Scroll affordance only: never intercepts a touch, and costs nothing when the table fits. -->
		<div
			aria-hidden="true"
			class="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-background to-transparent"
		></div>
	</div>
</form>
