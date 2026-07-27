<script lang="ts">
	// Progressive header blur, shared by every sticky/fixed header (home, search/settings via
	// PageHeader, and the title page). A single backdrop-filter can't vary its blur *radius* over
	// its height, so we stack several layers — each blurrier than the last and masked to a band that
	// reaches progressively higher — giving a true 0→max blur ramp from the bottom edge up to the
	// top. A separate tint layer fades the background colour solid→transparent over the same height,
	// so content scrolls blurred beneath the header and both effects ease off with no hard line.
	// `strong` scales the blur up over artwork (the title-page hero). Absolutely fills its
	// (positioned) parent header; edit here, once.
	let { strong = false }: { strong?: boolean } = $props();

	// Each layer: blur radius (px) plus the mask stops where it holds full then fades to transparent
	// (top→bottom, %). Bands overlap so the ramp is smooth; the biggest blur is pinned nearest the top.
	const layers = $derived(
		[
			{ blur: 0.5, solid: 78, end: 100 },
			{ blur: 1.5, solid: 60, end: 82 },
			{ blur: 3, solid: 42, end: 64 },
			{ blur: 6, solid: 24, end: 46 },
			{ blur: 12, solid: 0, end: 28 }
		].map((l) => ({ ...l, blur: l.blur * (strong ? 2 : 1) }))
	);

	function mask({ solid, end }: { solid: number; end: number }): string {
		return `linear-gradient(to bottom, #000 0%, #000 ${solid}%, transparent ${end}%)`;
	}
</script>

<div class="pointer-events-none absolute inset-0">
	{#each layers as layer (layer.blur)}
		<div
			class="absolute inset-0"
			style="backdrop-filter:blur({layer.blur}px); -webkit-backdrop-filter:blur({layer.blur}px); -webkit-mask-image:{mask(
				layer
			)}; mask-image:{mask(layer)};"
		></div>
	{/each}
	<div
		class="absolute inset-0"
		style="background:linear-gradient(to bottom, var(--color-background) 0%, color-mix(in oklab, var(--color-background) 70%, transparent) 55%, color-mix(in oklab, var(--color-background) 32%, transparent) 78%, transparent 100%);"
	></div>
</div>
