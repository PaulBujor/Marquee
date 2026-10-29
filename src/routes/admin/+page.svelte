<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const usersPath = resolve('/admin/users');

	const cards = $derived([
		{ label: 'Pending', value: data.counts.pending, hint: 'waiting to be admitted' },
		{ label: 'Enabled', value: data.counts.enabled, hint: 'can sign in' },
		{ label: 'Blocked', value: data.counts.blocked, hint: 'denied access' }
	]);
</script>

<div class="grid grid-cols-3 gap-3">
	{#each cards as card (card.label)}
		<div class="rounded-lg border p-4">
			<p class="text-xs text-muted-foreground">{card.label}</p>
			<p class="mt-1 font-serif text-2xl font-semibold tabular-nums">{card.value}</p>
			<p class="mt-0.5 text-[0.6875rem] text-muted-foreground">{card.hint}</p>
		</div>
	{/each}
</div>

{#if data.counts.pending > 0}
	<p class="mt-4 text-sm text-muted-foreground">
		{data.counts.pending} account{data.counts.pending === 1 ? '' : 's'} waiting on you —
		<a class="underline underline-offset-2" href={usersPath}>review the waitlist</a>
	</p>
{/if}
