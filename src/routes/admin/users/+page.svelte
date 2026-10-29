<script lang="ts">
	import { resolve } from '$app/paths';
	import DataTable from '#lib/components/data-table/data-table.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type Row = PageData['rows'][number];

	const usersPath = resolve('/admin/users');
	const statuses = ['pending', 'enabled', 'blocked'] as const;
	const lastPage = $derived(Math.max(1, Math.ceil(data.total / data.pageSize)));
	const sortValue = $derived(`${data.sort.key}:${data.sort.dir}`);
	const pill = 'rounded-full border px-3 py-1 text-xs capitalize';
	const pillActive = 'bg-foreground text-background';
	const pillIdle = 'text-muted-foreground';
</script>

<form class="flex flex-wrap items-center gap-2" method="GET" action={usersPath}>
	<input
		class="h-9 flex-1 rounded-md border bg-transparent px-3 text-sm"
		type="search"
		name="q"
		value={data.q}
		placeholder="Search by email"
		aria-label="Search users by email"
	/>
	{#if data.status}
		<input type="hidden" name="status" value={data.status} />
	{/if}
	<input type="hidden" name="sort" value={sortValue} />
	<button class="h-9 rounded-md border px-3 text-sm" type="submit">Search</button>
</form>

<!-- Filters and sorting are GET forms rather than links: a query string appended to a resolve()d path loses
     resolve()'s branded type, and forms keep both working without JavaScript. -->
<form
	class="mt-3 flex flex-wrap gap-1.5"
	method="GET"
	action={usersPath}
	aria-label="Filter by status"
>
	<input type="hidden" name="sort" value={sortValue} />
	{#if data.q}
		<input type="hidden" name="q" value={data.q} />
	{/if}
	<button
		type="submit"
		name="status"
		value=""
		aria-current={data.status === null ? 'page' : undefined}
		class="{pill} {data.status === null ? pillActive : pillIdle}">All</button
	>
	{#each statuses as status (status)}
		<button
			type="submit"
			name="status"
			value={status}
			aria-current={data.status === status ? 'page' : undefined}
			class="{pill} {data.status === status ? pillActive : pillIdle}">{status}</button
		>
	{/each}
</form>

<p class="mt-4 text-xs text-muted-foreground">
	{data.total} account{data.total === 1 ? '' : 's'}{data.q ? ` matching “${data.q}”` : ''}
</p>

{#snippet emailCell(row: Row)}
	<p class="truncate text-sm">{row.email}</p>
	<p class="mt-0.5 text-[0.6875rem] text-muted-foreground">
		joined {row.createdAt.toISOString().slice(0, 10)}
		{#if row.signupIp}· {row.signupIp}{/if}
	</p>
	{#if row.blockedReason}
		<p class="mt-0.5 text-[0.6875rem] text-muted-foreground">reason: {row.blockedReason}</p>
	{/if}
{/snippet}

{#snippet statusCell(row: Row)}
	<span class="rounded-full border px-2 py-0.5 text-[0.6875rem] capitalize">{row.status}</span>
{/snippet}

{#snippet roleCell(row: Row)}
	<span class="text-xs text-muted-foreground">{row.role}</span>
{/snippet}

<DataTable
	base={usersPath}
	rows={data.rows}
	sortKey={data.sort.key}
	sortDir={data.sort.dir}
	params={{ q: data.q, status: data.status ?? undefined }}
	columns={[
		{ key: 'email', label: 'Email', sortable: true, cell: emailCell },
		{ key: 'status', label: 'Status', sortable: true, end: true, cell: statusCell },
		{ key: 'role', label: 'Role', cell: roleCell }
	]}
	empty="No accounts match."
/>

{#if lastPage > 1}
	<form
		class="mt-4 flex items-center justify-between text-sm"
		method="GET"
		action={usersPath}
		aria-label="Pagination"
	>
		<input type="hidden" name="sort" value={sortValue} />
		{#if data.status}
			<input type="hidden" name="status" value={data.status} />
		{/if}
		{#if data.q}
			<input type="hidden" name="q" value={data.q} />
		{/if}
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
