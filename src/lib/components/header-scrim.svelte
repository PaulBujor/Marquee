<script lang="ts">
	// Progressive header blur, shared by every sticky/fixed header (home, search/settings via
	// PageHeader, and the title page). A background tint + masked backdrop-filter that hold full for
	// the top half of the header, then fade out to the bottom edge — so content scrolls blurred
	// beneath it and the blur eases off with no hard line. `strong` bumps the blur over artwork
	// (the title-page hero). Absolutely fills its (positioned) parent header; edit here, once.
	let { strong = false }: { strong?: boolean } = $props();
</script>

<div
	class="pointer-events-none absolute inset-0 {strong ? 'backdrop-blur-xl' : 'backdrop-blur-md'}"
	style="background:linear-gradient(to bottom, var(--color-background) 0%, var(--color-background) 50%, transparent 100%); -webkit-mask-image:linear-gradient(to bottom, #000 0%, #000 50%, transparent 100%); mask-image:linear-gradient(to bottom, #000 0%, #000 50%, transparent 100%);"
></div>
