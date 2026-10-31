<script lang="ts">
	import { resolve } from '$app/paths';
	import HeaderScrim from '#lib/components/header-scrim.svelte';
	import SyncIndicator from '#lib/components/sync-indicator.svelte';
</script>

<header class="sticky top-0 z-40">
	<HeaderScrim />
	<!-- The same inset above, left and below keeps the wordmark evenly set in the content column. -->
	<div
		class="relative flex w-full items-center justify-between px-5 pt-[max(1.25rem,var(--top-inset))] pb-5"
	>
		<a href={resolve('/')} class="flex items-center gap-2">
			<!-- The theme rune's `isDark` reads the system preference non-reactively and is true during SSR,
			so "auto" would render the wrong mark and never update; the `.dark` class is already set before
			first paint, so let CSS choose. The favicon art (not the PWA icons, which are padded for
			masking) is used at 24px, so a 3x phone needs the 144 srcset entry. -->
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
			<!-- `leading-none` so the wordmark's line box adds no invisible height and throws the inset off. -->
			<span class="font-serif text-xl leading-none font-semibold">Marquee</span>
		</a>
		<SyncIndicator />
	</div>
</header>
