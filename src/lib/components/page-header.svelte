<script lang="ts">
	// Sticky page header shared by the search + settings pages: content scrolls blurred beneath it,
	// faded out by the same curved top→transparent gradient the home/title headers use, and it
	// clears the iOS status bar / Dynamic Island. `children` holds the header content (a back
	// control, title, and optionally a search field). Aligned to the max-w-2xl content column.
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();
</script>

<header class="sticky top-0 z-40">
	<div
		class="pointer-events-none absolute inset-0 backdrop-blur-md"
		style="background:linear-gradient(to bottom, var(--color-background) 0%, var(--color-background) 18%, color-mix(in oklab, var(--color-background) 72%, transparent) 42%, color-mix(in oklab, var(--color-background) 28%, transparent) 66%, transparent 100%); -webkit-mask-image:linear-gradient(to bottom, #000 0%, #000 42%, rgb(0 0 0 / 0.55) 64%, rgb(0 0 0 / 0.2) 84%, transparent 100%); mask-image:linear-gradient(to bottom, #000 0%, #000 42%, rgb(0 0 0 / 0.55) 64%, rgb(0 0 0 / 0.2) 84%, transparent 100%);"
	></div>
	<div
		class="relative mx-auto flex w-full max-w-2xl flex-col gap-3 px-5 pt-[max(1rem,env(safe-area-inset-top))] pb-3"
	>
		{@render children()}
	</div>
</header>
