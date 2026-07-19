<script lang="ts">
	import { resolve } from '$app/paths';
	import { buttonVariants } from '$lib/components/ui/button';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<!-- Signed in, the app header carries the branding, so the landing copy shows only when signed out. -->
<main
	class="mx-auto flex max-w-2xl flex-col items-start justify-center gap-4 p-6 {data.user
		? ''
		: 'min-h-svh'}"
>
	{#if !data.user}
		<h1 class="font-serif text-3xl font-semibold">Marquee</h1>
		<p class="text-muted-foreground">Track the movies and shows you're watching.</p>
		<a href={resolve('/login')} class={buttonVariants()}>Sign in</a>
	{/if}
</main>
