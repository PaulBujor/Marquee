<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const usersPath = resolve('/admin/users');
	const statuses = ['pending', 'enabled', 'blocked'] as const;
	const lastPage = $derived(Math.max(1, Math.ceil(data.total / data.pageSize)));

	const pill = 'rounded-full border px-3 py-1 text-xs capitalize';
	const pillActive = 'bg-foreground text-background';
	const pillIdle = 'text-muted-foreground';
</script>

<form class="flex flex-wrap items-center gap-2" method="GET" action={resolve('/admin/users')}>
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
	<button class="h-9 rounded-md border px-3 text-sm" type="submit">Search</button>
</form>

<!-- Filters are GET forms rather than links: a query string appended to resolve()d path loses resolve()'s
     branded type, and a form keeps them working without JavaScript. -->
<form class="mt-3 flex gap-1.5" method="GET" action={usersPath} aria-label="Filter by status">
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

<ul class="mt-2 divide-y rounded-lg border">
	{#each data.rows as row (row.id)}
		<li class="flex items-start justify-between gap-3 px-4 py-3">
			<div class="min-w-0">
				<p class="truncate text-sm">{row.email}</p>
				<p class="mt-0.5 text-[0.6875rem] text-muted-foreground">
					joined {row.createdAt.toISOString().slice(0, 10)}
					{#if row.signupIp}· {row.signupIp}{/if}
					{#if row.role === 'admin'}· admin{/if}
				</p>
				{#if row.blockedReason}
					<p class="mt-1 text-[0.6875rem] text-muted-foreground">reason: {row.blockedReason}</p>
				{/if}
			</div>
			<span class="shrink-0 rounded-full border px-2 py-0.5 text-[0.6875rem] capitalize">
				{row.status}
			</span>
		</li>
	{:else}
		<li class="px-4 py-6 text-center text-sm text-muted-foreground">No accounts match.</li>
	{/each}
</ul>

{#if lastPage > 1}
	<form
		class="mt-4 flex items-center justify-between text-sm"
		method="GET"
		action={usersPath}
		aria-label="Pagination"
	>
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
