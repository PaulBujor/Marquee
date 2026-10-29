<!--
	A server-driven table: sorting and paging are GET submissions, so they work without JavaScript and every
	value the server reads comes from the URL. Rows render as a table from `sm` up and as cards below it — the
	first column is the card's primary line, the second its right-aligned status, the rest a muted detail row.
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

	/** Encodes the toggle in the value itself, so no JavaScript is needed to flip direction. */
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

	<div class="mt-3 flex flex-wrap gap-1.5 sm:hidden" aria-label="Sort">
		{#each columns.filter((column) => column.sortable) as column (column.key)}
			<button
				type="submit"
				name="sort"
				value={nextValue(column.key)}
				aria-pressed={column.key === sortKey}
				class="rounded-full border px-3 py-1 text-xs {column.key === sortKey
					? 'bg-foreground text-background'
					: 'text-muted-foreground'}"
			>
				{column.label}{column.key === sortKey ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
			</button>
		{/each}
	</div>

	<div class="mt-2 hidden overflow-x-auto rounded-lg border sm:block">
		<table class="w-full text-sm">
			<thead>
				<tr class="border-b text-left text-xs text-muted-foreground">
					{#each columns as column (column.key)}
						<th
							scope="col"
							class="px-4 py-2 font-normal {column.end ? 'text-right' : ''}"
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
				{#each rows as row, index (index)}
					<tr class="border-b last:border-0">
						{#each columns as column (column.key)}
							<td class="px-4 py-2 align-top {column.end ? 'text-right' : ''}">
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

	<ul class="mt-2 divide-y rounded-lg border sm:hidden">
		{#each rows as row, index (index)}
			<li class="px-4 py-3">
				<div class="flex items-start justify-between gap-3">
					<div class="min-w-0">{@render columns[0].cell(row)}</div>
					{#if columns[1]}
						<div class="shrink-0 text-right">{@render columns[1].cell(row)}</div>
					{/if}
				</div>
				{#if columns.length > 2}
					<div class="mt-1 flex flex-wrap gap-x-3 text-[0.6875rem] text-muted-foreground">
						{#each columns.slice(2) as column (column.key)}
							<span>{@render column.cell(row)}</span>
						{/each}
					</div>
				{/if}
			</li>
		{:else}
			<li class="px-4 py-6 text-center text-sm text-muted-foreground">{empty}</li>
		{/each}
	</ul>
</form>
