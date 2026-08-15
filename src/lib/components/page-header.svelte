<script lang="ts">
	// Sticky page header shared by the search + settings + upcoming pages: content scrolls blurred
	// beneath it, faded out by the same curved top→transparent gradient the home/title headers use,
	// and it clears the iOS status bar / Dynamic Island. `children` holds the header content (a
	// title, or a search field). Aligned to the max-w-2xl content column.
	import type { Snippet } from 'svelte';
	import HeaderScrim from '$lib/components/header-scrim.svelte';

	let { children }: { children: Snippet } = $props();
</script>

<header class="sticky top-0 z-40">
	<HeaderScrim />
	<div
		class="relative z-10 mx-auto flex w-full max-w-2xl transform-gpu flex-col gap-3 px-5 pt-[max(1rem,env(safe-area-inset-top))] pb-3"
	>
		{@render children()}
	</div>
</header>
