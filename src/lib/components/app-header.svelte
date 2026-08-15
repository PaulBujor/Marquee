<script lang="ts">
	import { resolve } from '$app/paths';
	import HeaderScrim from '$lib/components/header-scrim.svelte';
	import SyncIndicator from '$lib/components/sync-indicator.svelte';
</script>

<!-- Sticky app header: content scrolls blurred beneath it, faded out by a top→transparent
gradient. Aligned to the dashboard's max-w-3xl content column; clears the iOS status bar.
Branding only — the destinations live in the bottom tab bar. -->
<header class="sticky top-0 z-40">
	<HeaderScrim />
	<!-- The inset is the same on all three sides that frame the wordmark — above it, to its left, and
	below it down to the first control — so the header reads as evenly set into the content column
	rather than as a band. `px-5` is the app-wide column inset, so it sets the value; the page's own
	`<main>` adds no top padding of its own. -->
	<div
		class="relative z-10 mx-auto flex w-full max-w-3xl transform-gpu items-center justify-between px-5 pt-[max(1.25rem,env(safe-area-inset-top))] pb-5"
	>
		<a href={resolve('/')} class="flex items-center gap-2">
			<!-- Two marks rather than one `src` picked in JS: the theme rune's `isDark` is derived from a
			non-reactive read of the system preference and is true during SSR, so it would render the
			wrong mark and never update in "auto" mode. The `.dark` class is already correct before first
			paint (see the inline script in app.html), so let CSS choose. The favicon art is used, not the
			PWA icons — those are padded for masking and would sit visibly inset beside the wordmark.
			The mark draws at 24px, so a 3x phone needs 144: without the srcset it upscaled 48 and read
			visibly soft. -->
			<img
				src="/icons/favicon-48.png"
				srcset="/icons/favicon-48.png 1x, /icons/favicon-96.png 2x, /icons/favicon-144.png 3x"
				alt=""
				aria-hidden="true"
				width="48"
				height="48"
				class="size-6 dark:hidden"
			/>
			<img
				src="/icons/favicon-48-dark.png"
				srcset="/icons/favicon-48-dark.png 1x, /icons/favicon-96-dark.png 2x, /icons/favicon-144-dark.png 3x"
				alt=""
				aria-hidden="true"
				width="48"
				height="48"
				class="hidden size-6 dark:block"
			/>
			<!-- `leading-none` so the wordmark's line box doesn't add invisible height to the row and
			throw the even inset off. -->
			<span class="font-serif text-xl leading-none font-semibold">Marquee</span>
		</a>
		<SyncIndicator />
	</div>
</header>
