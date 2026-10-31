<script lang="ts">
	// Clears the iOS status bar / Dynamic Island; `children` holds the header content.
	import type { Snippet } from 'svelte';
	import HeaderScrim from '#lib/components/header-scrim.svelte';

	let { children }: { children: Snippet } = $props();
</script>

<header class="sticky top-0 z-40">
	<HeaderScrim />
	<div class="relative flex w-full flex-col gap-3 px-5 pt-[max(1rem,var(--top-inset))] pb-3">
		{@render children()}
	</div>
</header>
