<script lang="ts">
	// They must be in the server-rendered HTML: a chat app's unfurler doesn't run JavaScript.
	interface Props {
		title: string;
		description: string;
		url: string;
		image: string;
	}
	let { title, description, url, image }: Props = $props();
</script>

<svelte:head>
	<title>{title} · Marquee</title>
	<meta name="description" content={description} />
	<!-- Belt and braces with the `x-robots-tag` response header, for anything that only reads HTML. -->
	<meta name="robots" content="noindex, noarchive" />
	<meta property="og:site_name" content="Marquee" />
	<meta property="og:type" content="website" />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="og:url" content={url} />
	<meta property="og:image" content={image} />
	<meta name="twitter:card" content="summary_large_image" />
</svelte:head>
