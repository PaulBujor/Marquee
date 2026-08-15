<script lang="ts">
	// Progressive header blur, shared by every sticky/fixed header (home, search/settings via
	// PageHeader, and the title page). A single backdrop-filter can't vary its blur *radius* over
	// its height, so we stack several layers — each blurrier than the last and masked to a band that
	// reaches progressively higher — giving a true 0→max blur ramp from the bottom edge up to the
	// top. A separate tint layer fades the background colour solid→transparent over the same height,
	// so content scrolls blurred beneath the header and both effects ease off with no hard line.
	// `strong` scales the blur up over artwork (the title-page hero). `show` reveals the scrim: the
	// title page keeps it hidden over the hero and fades it in on scroll. We animate the blur *radius*
	// (down to 0 when hidden) rather than the container's opacity — an ancestor opacity fade doesn't
	// interpolate backdrop-filter, so the blur would pop in while only the tint faded. Absolutely
	// fills its (positioned) parent header; edit here, once.
	//
	// Two rules keep the header's own content out of the blur, and both are needed in WebKit.
	//
	// `z-0` here (with `z-10` on the content in each header that uses this) states the paint order
	// rather than leaving it to tree order. That alone is not enough: every layer below sets
	// `backdrop-filter`, and WebKit samples its backdrop from the enclosing *composited* layer — a
	// `sticky`/`fixed` header is composited — so the header's own text ends up inside the sampled
	// backdrop no matter where it paints, and comes out blurred and washed out. The headers therefore
	// also promote their content to its own layer (`transform-gpu`), which takes it out of the
	// backdrop entirely. Neither rule is decorative; dropping either brings the blurred wordmark back
	// on iOS.
	let { strong = false, show = true }: { strong?: boolean; show?: boolean } = $props();

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

<div class="pointer-events-none absolute inset-0 z-0">
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
