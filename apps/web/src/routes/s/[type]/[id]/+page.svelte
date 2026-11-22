<script lang="ts">
	import { page } from '$app/state';
	import ShareCta from '#lib/components/share/share-cta.svelte';
	import ShareMeta from '#lib/components/share/share-meta.svelte';
	import SharedTitle from '#lib/components/share/shared-title.svelte';
	import { posterUrl } from '#lib/media.js';
	import { TMDB_ATTRIBUTION } from '#lib/share-preview.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const preview = $derived(data.state === 'ready' ? data.preview : null);
	const name = $derived(preview?.name ?? 'A title shared from Marquee');
	const summary = $derived(
		preview?.summary ?? 'Marquee is a private watch list for films and series.'
	);
	const appIcon = $derived(`${page.url.origin}/icons/icon-512.png`);
	const image = $derived(posterUrl(preview?.imagePath ?? null, 'w500') ?? appIcon);
	const loginHref = $derived(
		`/login?redirectTo=${encodeURIComponent(`/title/${data.type}/${data.id}`)}`
	);
</script>

<ShareMeta
	title={name}
	description={summary}
	url={`${page.url.origin}${page.url.pathname}`}
	{image}
/>

{#if preview}
	<SharedTitle {preview} {loginHref} />
	<p class="mx-auto w-full max-w-3xl px-5 pb-10 text-center text-[0.7rem] text-muted-foreground">
		{TMDB_ATTRIBUTION}
	</p>
{:else}
	<main
		class="mx-auto flex min-h-dvh w-full max-w-lg flex-col items-center justify-center gap-7 px-6 py-12"
	>
		<div class="flex flex-col items-center gap-2 text-center">
			<h1 class="font-serif text-xl font-semibold">
				{data.state === 'disabled'
					? 'Shared links are unavailable'
					: "This preview isn't ready yet"}
			</h1>
			<p class="max-w-prose text-sm text-muted-foreground">
				{data.state === 'disabled'
					? 'Marquee is not sharing links at the moment.'
					: "Marquee hasn't stored a page for this title yet. Open it in the app to see it."}
			</p>
		</div>
		{#if data.state !== 'disabled'}
			<ShareCta href={loginHref} />
		{/if}
		<p class="max-w-prose text-center text-[0.7rem] text-muted-foreground">{TMDB_ATTRIBUTION}</p>
	</main>
{/if}
