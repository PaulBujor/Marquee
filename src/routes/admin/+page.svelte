<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const usersPath = resolve('/admin/users');

	const cards = $derived([
		{
			status: 'pending',
			label: 'Pending',
			value: data.counts.pending,
			hint: 'waiting to be admitted'
		},
		{ status: 'enabled', label: 'Enabled', value: data.counts.enabled, hint: 'can sign in' },
		{ status: 'blocked', label: 'Blocked', value: data.counts.blocked, hint: 'denied access' }
	]);

	const usage = $derived([
		{ label: 'Movies', value: data.usage.movies },
		{ label: 'Series', value: data.usage.shows },
		{ label: 'Watched', value: data.usage.watched },
		{ label: 'Episodes watched', value: data.usage.episodesWatched },
		{ label: 'Favourites', value: data.usage.favourites },
		{ label: 'Rated', value: data.usage.rated },
		{ label: 'Active 7d', value: data.usage.activeWeek },
		{ label: 'Active 30d', value: data.usage.activeMonth }
	]);
</script>

<form class="grid grid-cols-3 gap-3" method="GET" action={usersPath}>
	{#each cards as card (card.label)}
		<button
			type="submit"
			name="status"
			value={card.status}
			class="rounded-xl p-4 text-left ring-1 ring-foreground/10 transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
		>
			<span class="block text-xs text-muted-foreground">{card.label}</span>
			<span class="mt-1 block font-serif text-2xl font-semibold tabular-nums">{card.value}</span>
			<span class="mt-0.5 block text-[0.6875rem] text-muted-foreground">{card.hint}</span>
		</button>
	{/each}
</form>

<h2 class="mt-8 text-sm font-medium">Library</h2>
<dl class="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
	{#each usage as item (item.label)}
		<div class="rounded-xl p-4 ring-1 ring-foreground/10">
			<dt class="text-xs text-muted-foreground">{item.label}</dt>
			<dd class="mt-1 font-serif text-2xl font-semibold tabular-nums">{item.value}</dd>
		</div>
	{/each}
</dl>
