<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const lastPage = $derived(Math.max(1, Math.ceil(data.total / data.pageSize)));

	function format(value: Date): string {
		return value.toISOString().replace('T', ' ').slice(0, 16);
	}
</script>

<p class="text-xs text-muted-foreground">
	{data.total} recorded action{data.total === 1 ? '' : 's'}
</p>

<ul class="mt-2 divide-y rounded-lg border">
	{#each data.rows as row (row.id)}
		<li class="px-4 py-3">
			<div class="flex items-baseline justify-between gap-3">
				<p class="text-sm">
					<span class="font-medium">{row.action}</span> · {row.targetLabel ?? row.targetId}
				</p>
				<time
					class="shrink-0 text-[0.6875rem] text-muted-foreground"
					datetime={row.createdAt.toISOString()}
				>
					{format(row.createdAt)}
				</time>
			</div>
			<p class="mt-0.5 text-[0.6875rem] text-muted-foreground">
				by {row.actorEmail}{#if row.ip}· {row.ip}{/if}
			</p>
			{#if row.reason}
				<p class="mt-1 text-xs">reason: {row.reason}</p>
			{/if}
		</li>
	{:else}
		<li class="px-4 py-6 text-center text-sm text-muted-foreground">
			Nothing recorded yet — actions appear here as you use the admin page.
		</li>
	{/each}
</ul>

{#if lastPage > 1}
	<form
		class="mt-4 flex items-center justify-between text-sm"
		method="GET"
		action={resolve('/admin/audit')}
		aria-label="Pagination"
	>
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
