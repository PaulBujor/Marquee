<script lang="ts">
	import { resolve } from '$app/paths';
	import DataTable from '#lib/components/data-table/data-table.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type Row = PageData['rows'][number];

	const auditPath = resolve('/admin/audit');
	const lastPage = $derived(Math.max(1, Math.ceil(data.total / data.pageSize)));
	const sortValue = $derived(`${data.sort.key}:${data.sort.dir}`);

	function format(value: Date): string {
		return value.toISOString().replace('T', ' ').slice(0, 16);
	}
</script>

<p class="text-xs text-muted-foreground">
	{data.total} recorded action{data.total === 1 ? '' : 's'}
</p>

{#snippet whenCell(row: Row)}
	<time class="text-xs whitespace-nowrap" datetime={row.createdAt.toISOString()}>
		{format(row.createdAt)}
	</time>
{/snippet}

{#snippet actionCell(row: Row)}
	<Badge variant="outline">{row.action}</Badge>
{/snippet}

{#snippet targetCell(row: Row)}
	<span class="text-xs">{row.targetLabel ?? row.targetId}</span>
{/snippet}

{#snippet actorCell(row: Row)}
	<span class="text-xs">{row.actorEmail}</span>
{/snippet}

{#snippet ipCell(row: Row)}
	<span class="text-xs text-muted-foreground">{row.ip ?? '—'}</span>
{/snippet}

{#snippet reasonCell(row: Row)}
	<span class="text-xs text-muted-foreground">{row.reason ?? '—'}</span>
{/snippet}

<!-- When leads, so the sticky column carries the date on a phone and the rest scrolls. -->
<DataTable
	base={auditPath}
	rows={data.rows}
	sortKey={data.sort.key}
	sortDir={data.sort.dir}
	columns={[
		{ key: 'createdAt', label: 'When', sortable: true, cell: whenCell },
		{ key: 'action', label: 'Action', sortable: true, cell: actionCell },
		{ key: 'target', label: 'Target', cell: targetCell },
		{ key: 'actorEmail', label: 'Actor', sortable: true, cell: actorCell },
		{ key: 'ip', label: 'IP', cell: ipCell },
		{ key: 'reason', label: 'Reason', cell: reasonCell }
	]}
	empty="Nothing recorded yet — actions appear here as you use the admin page."
/>

{#if lastPage > 1}
	<form
		class="mt-4 flex items-center justify-between text-sm"
		method="GET"
		action={auditPath}
		aria-label="Pagination"
	>
		<input type="hidden" name="sort" value={sortValue} />
		{#if data.page > 1}
			<Button type="submit" name="page" value={data.page - 1} variant="ghost" size="sm"
				>Newer</Button
			>
		{:else}
			<span></span>
		{/if}
		<span class="text-xs text-muted-foreground">Page {data.page} of {lastPage}</span>
		{#if data.page < lastPage}
			<Button type="submit" name="page" value={data.page + 1} variant="ghost" size="sm"
				>Older</Button
			>
		{:else}
			<span></span>
		{/if}
	</form>
{/if}
