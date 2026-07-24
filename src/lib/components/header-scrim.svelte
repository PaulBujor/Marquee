<script lang="ts">
	// Progressive header blur, shared by every sticky/fixed header (home, search/settings via
	// PageHeader, and the title page). A curved top→transparent gradient tint over a masked
	// backdrop-filter: content scrolls blurred beneath it and the blur fades out with no hard line.
	// `strong` bumps the blur for a header sitting over artwork (the title-page hero).
	// Absolutely fills its (positioned) parent header; edit the look here, once, for all of them.
	let { strong = false }: { strong?: boolean } = $props();
</script>

<div
	class="pointer-events-none absolute inset-0 {strong ? 'backdrop-blur-xl' : 'backdrop-blur-md'}"
	style="background:linear-gradient(to bottom, var(--color-background) 0%, var(--color-background) 18%, color-mix(in oklab, var(--color-background) 72%, transparent) 42%, color-mix(in oklab, var(--color-background) 28%, transparent) 66%, transparent 100%); -webkit-mask-image:linear-gradient(to bottom, #000 0%, #000 42%, rgb(0 0 0 / 0.55) 64%, rgb(0 0 0 / 0.2) 84%, transparent 100%); mask-image:linear-gradient(to bottom, #000 0%, #000 42%, rgb(0 0 0 / 0.55) 64%, rgb(0 0 0 / 0.2) 84%, transparent 100%);"
></div>
