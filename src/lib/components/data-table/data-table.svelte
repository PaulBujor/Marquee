<!--
	Built on the vendored shadcn-svelte Table primitives. Sorting and paging stay server-driven — the states
	live in the URL, not in the table — so the rank of every column comes from a GET submission rather than
	client-side sorting. That keeps it working with JavaScript off, and means the sort key reaches SQL only
	through the server's column whitelist.
-->
<script lang="ts" generics="Row">
	import * as Table from '#lib/components/ui/table/index.js';
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

	<div class="relative mt-2 overflow-hidden rounded-2xl ring-1 ring-foreground/10">
		<Table.Root>
			<Table.Header>
				<Table.Row>
					{#each columns as column, index (column.key)}
						<Table.Head
							class="h-12 px-3 {index === 0
								? 'sticky left-0 z-10 border-r bg-background'
								: ''} {column.end ? 'text-right' : ''}"
							aria-sort={ariaSort(column.key)}
						>
							{#if column.sortable}
								<button
									type="submit"
									name="sort"
									value={nextValue(column.key)}
									class="-mx-3 flex min-h-12 w-full items-center gap-1 px-3 font-medium hover:text-foreground {column.end
										? 'justify-end'
										: ''}"
								>
									{column.label}
									{#if column.key === sortKey}
										<span aria-hidden="true">{sortDir === 'asc' ? '↑' : '↓'}</span>
									{/if}
								</button>
							{:else}
								{column.label}
							{/if}
						</Table.Head>
					{/each}
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each rows as row, rowIndex (rowIndex)}
					<Table.Row>
						{#each columns as column, index (column.key)}
							<Table.Cell
								class="px-3 py-3 {index === 0
									? 'sticky left-0 z-10 border-r bg-background'
									: ''} {column.end ? 'text-right' : ''}"
							>
								{@render column.cell(row)}
							</Table.Cell>
						{/each}
					</Table.Row>
				{:else}
					<Table.Row>
						<Table.Cell class="py-6 text-center text-muted-foreground" colspan={columns.length}>
							{empty}
						</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
		<!-- Scroll affordance only: never intercepts a touch, and costs nothing when the table fits. -->
		<div
			aria-hidden="true"
			class="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-background to-transparent"
		></div>
	</div>
</form>
