<script lang="ts">
	import { resolve } from '$app/paths';
	import { buttonVariants } from '$lib/components/ui/button';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<main class="mx-auto flex max-w-2xl flex-col items-start justify-center gap-4 p-6">
	<h1 class="font-serif text-3xl font-semibold">Marquee</h1>
	{#if data.user}
		<p class="text-muted-foreground">Track the movies and shows you're watching.</p>
	{:else}
		<p class="text-muted-foreground">Track the movies and shows you're watching.</p>
		<a href={resolve('/login')} class={buttonVariants()}>Sign in</a>
	{/if}
</main>
