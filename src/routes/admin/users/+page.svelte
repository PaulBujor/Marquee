<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import DataTable from '#lib/components/data-table/data-table.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type Row = PageData['rows'][number];

	// The same 300ms the search page and credit-row use, so typing feels identical across the app.
	const DEBOUNCE_MS = 300;

	// The input is the source of truth while typing; the URL follows one debounce after the last keystroke,
	// so the form still works without JavaScript but nobody has to press a button with it on.
	// Writable derived: it tracks `data.q` from navigations and also accepts local edits while typing.
	let q = $derived(data.q);
	let timer: ReturnType<typeof setTimeout> | undefined;

	function scheduleSearch(value: string) {
		q = value;
		clearTimeout(timer);
		timer = setTimeout(() => {
			const params: string[] = [];
			if (data.status) params.push(`status=${encodeURIComponent(data.status)}`);
			if (value.trim()) params.push(`q=${encodeURIComponent(value.trim())}`);
			params.push(`sort=${encodeURIComponent(sortValue)}`);
			const target = `${usersPath}?${params.join('&')}`;
			// The path is resolved; appending a query string drops resolve()'s branded type, which the rule keys on.
			// eslint-disable-next-line svelte/no-navigation-without-resolve
			goto(target, { replace: true, reset: false });
		}, DEBOUNCE_MS);
	}

	const usersPath = resolve('/admin/users');
	const statuses = ['pending', 'enabled', 'blocked'] as const;
	const lastPage = $derived(Math.max(1, Math.ceil(data.total / data.pageSize)));
	const sortValue = $derived(`${data.sort.key}:${data.sort.dir}`);
	const pill = 'inline-flex min-h-10 items-center rounded-full border px-4 text-xs capitalize';
	const pillActive = 'bg-foreground text-background';
	const pillIdle = 'text-muted-foreground';
</script>

<!-- One pill at every state: with scripting the debounce drives the search and only the input shows; without
     it the same pill gains an attached button, sharing the container's radius instead of floating beside it. -->
<form method="GET" action={usersPath} role="search">
	<div
		class="flex items-center overflow-hidden rounded-full border border-input transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
	>
		<Input
			class="h-10 rounded-none border-0 pr-3 focus-visible:ring-0"
			type="search"
			name="q"
			value={q}
			oninput={(event) => scheduleSearch(event.currentTarget.value)}
			placeholder="Search by email"
			aria-label="Search users by email"
			enterkeyhint="search"
		/>
		<button
			type="submit"
			class="h-10 shrink-0 border-l border-input px-4 text-sm [@media(scripting:enabled)]:hidden"
		>
			Search
		</button>
	</div>
	{#if data.status}
		<input type="hidden" name="status" value={data.status} />
	{/if}
	<input type="hidden" name="sort" value={sortValue} />
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
	<span class="truncate">{row.email}</span>
{/snippet}

{#snippet adminCell(row: Row)}
	{#if row.role === 'admin'}
		<Badge variant="outline">admin</Badge>
	{:else}
		<span class="text-muted-foreground">—</span>
	{/if}
{/snippet}

{#snippet statusCell(row: Row)}
	<Badge
		variant={row.status === 'blocked'
			? 'destructive'
			: row.status === 'pending'
				? 'secondary'
				: 'outline'}
		class="capitalize">{row.status}</Badge
	>
{/snippet}

{#snippet joinedCell(row: Row)}
	<span class="text-muted-foreground">{row.createdAt.toISOString().slice(0, 10)}</span>
{/snippet}

{#snippet ipCell(row: Row)}
	<span class="text-muted-foreground">{row.signupIp ?? '—'}</span>
{/snippet}

<DataTable
	base={usersPath}
	rows={data.rows}
	sortKey={data.sort.key}
	sortDir={data.sort.dir}
	params={{ q: data.q, status: data.status ?? undefined }}
	columns={[
		{ key: 'email', label: 'Email', sortable: true, cell: emailCell },
		{ key: 'status', label: 'Status', sortable: true, cell: statusCell },
		{ key: 'role', label: 'Admin', sortable: true, cell: adminCell },
		{ key: 'createdAt', label: 'Joined', sortable: true, cell: joinedCell },
		{ key: 'signupIp', label: 'Signup IP', cell: ipCell }
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
