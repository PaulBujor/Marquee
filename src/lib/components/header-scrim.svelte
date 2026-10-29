<script lang="ts">
	// A single backdrop-filter can't vary its blur radius over its height, so layers are stacked and
	// masked; the radius (not container opacity) is animated because an ancestor opacity fade doesn't
	// interpolate backdrop-filter. `strong` scales the blur over artwork; `show` fades the scrim in.
	let { strong = false, show = true }: { strong?: boolean; show?: boolean } = $props();

	// Bands overlap so the ramp is smooth; the biggest blur is pinned nearest the top.
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
		{@const radius = show ? layer.blur : 0}
		<div
			class="absolute inset-0"
			style="transition:backdrop-filter 300ms, -webkit-backdrop-filter 300ms; backdrop-filter:blur({radius}px); -webkit-backdrop-filter:blur({radius}px); -webkit-mask-image:{mask(
				layer
			)}; mask-image:{mask(layer)};"
		></div>
	{/each}
	<div
		class="absolute inset-0 transition-opacity duration-300"
		style="opacity:{show
			? 1
			: 0}; background:linear-gradient(to bottom, var(--color-background) 0%, color-mix(in oklab, var(--color-background) 70%, transparent) 55%, color-mix(in oklab, var(--color-background) 32%, transparent) 78%, transparent 100%);"
	></div>
</div>
