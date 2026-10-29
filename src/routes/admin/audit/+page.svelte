<script lang="ts">
	import { resolve } from '$app/paths';
	import DataTable from '#lib/components/data-table/data-table.svelte';
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

{#snippet actionCell(row: Row)}
	<p class="text-sm">
		<span class="font-medium">{row.action}</span> · {row.targetLabel ?? row.targetId}
	</p>
	{#if row.reason}
		<p class="mt-0.5 text-xs">reason: {row.reason}</p>
	{/if}
{/snippet}

{#snippet whenCell(row: Row)}
	<time class="text-xs text-muted-foreground" datetime={row.createdAt.toISOString()}>
		{format(row.createdAt)}
	</time>
{/snippet}

{#snippet actorCell(row: Row)}
	<span class="text-xs text-muted-foreground"
		>{row.actorEmail}{#if row.ip}
			· {row.ip}{/if}</span
	>
{/snippet}

<DataTable
	base={auditPath}
	rows={data.rows}
	sortKey={data.sort.key}
	sortDir={data.sort.dir}
	columns={[
		{ key: 'action', label: 'Action', sortable: true, cell: actionCell },
		{ key: 'createdAt', label: 'When', sortable: true, end: true, cell: whenCell },
		{ key: 'actorEmail', label: 'Actor', sortable: true, cell: actorCell }
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
			<button type="submit" name="page" value={data.page - 1} class="underline underline-offset-2">
				Newer
			</button>
		{:else}
			<span></span>
		{/if}
		<span class="text-xs text-muted-foreground">Page {data.page} of {lastPage}</span>
		{#if data.page < lastPage}
			<button type="submit" name="page" value={data.page + 1} class="underline underline-offset-2">
				Older
			</button>
		{:else}
			<span></span>
		{/if}
	</form>
{/if}
