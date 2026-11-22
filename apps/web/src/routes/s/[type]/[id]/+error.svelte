<script lang="ts">
	// Public readers get this instead of the app's shell: nothing here is theirs to see.
	import { page } from '$app/state';
	import ShareCta from '#lib/components/share/share-cta.svelte';
	import { TMDB_ATTRIBUTION } from '#lib/share-preview.js';

	const title = $derived(
		page.status === 429 ? 'Too many requests' : 'This link has nothing to show'
	);
	const detail = $derived(
		page.status === 429
			? 'Give it a minute and open the link again.'
			: 'The link may be mistyped, or point at something that was never shareable.'
	);
</script>

<main
	class="mx-auto flex min-h-dvh w-full max-w-lg flex-col items-center justify-center gap-7 px-6 py-12"
>
	<div class="flex flex-col items-center gap-2 text-center">
		<h1 class="font-serif text-xl font-semibold">{title}</h1>
		<p class="max-w-prose text-sm text-muted-foreground">{detail}</p>
	</div>
	{#if page.status !== 429}
		<ShareCta href="/login" />
	{/if}
	<p class="max-w-prose text-center text-[0.7rem] text-muted-foreground">{TMDB_ATTRIBUTION}</p>
</main>
