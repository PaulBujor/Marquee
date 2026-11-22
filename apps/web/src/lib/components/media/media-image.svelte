<script lang="ts">
	// Renders the cached Blob when present, else the TMDB URL, and re-checks after each sync.
	import { getMediaImages } from '#lib/client/idb/images.js';
	import { posterUrl, POSTER_SIZE, type TmdbImageSize } from '#lib/media.js';
	import { sync } from '#lib/client/sync/engine.svelte.js';
	import { cn } from '#lib/utils.js';
	import ImageOff from '@lucide/svelte/icons/image-off';

	interface Props {
		id: string;
		path: string | null;
		kind?: 'poster' | 'backdrop';
		size?: TmdbImageSize;
		alt?: string;
		class?: string;
	}
	let {
		id,
		path,
		kind = 'poster',
		size = POSTER_SIZE,
		alt = '',
		class: className = ''
	}: Props = $props();

	let objectUrl = $state<string | null>(null);
	let failed = $state(false);
	const networkUrl = $derived(posterUrl(path, size));
	const src = $derived(objectUrl ?? networkUrl);

	// Comparing identity keeps the existing object URL; recreating it reloads the <img> — the visible pop.
	let loadedKey: string | null = null;
	let loadedUrl: string | null = null;

	// Reset the failed flag when the target changes so a new id/path gets a fresh chance to load.
	$effect(() => {
		void id;
		void path;
		void kind;
		void objectUrl;
		failed = false;
	});

	$effect(() => {
		const currentId = id;
		const currentKind = kind;
		void sync.revision; // re-check for a freshly-cached blob after a sync
		const targetPrefix = `${currentId}:${currentKind}:`;

		// Target changed: drop the cached URL so the old poster doesn't briefly show for the new one.
		if (loadedKey && !loadedKey.startsWith(targetPrefix)) {
			if (loadedUrl) URL.revokeObjectURL(loadedUrl);
			loadedUrl = loadedKey = null;
			objectUrl = null;
		}

		let cancelled = false;
		getMediaImages(currentId).then((images) => {
			if (cancelled) return;
			const blob = currentKind === 'poster' ? images?.poster : images?.backdrop;
			const key = blob ? `${targetPrefix}${images!.updatedAt}` : null;
			if (key === loadedKey) return; // same blob already shown — keep the URL, no reload/pop
			if (loadedUrl) URL.revokeObjectURL(loadedUrl);
			loadedUrl = blob ? URL.createObjectURL(blob) : null;
			loadedKey = key;
			objectUrl = loadedUrl;
		});

		return () => {
			cancelled = true;
		};
	});

	// Covers plain unmount; id-change revocation is handled above.
	$effect(() => () => {
		if (loadedUrl) URL.revokeObjectURL(loadedUrl);
	});
</script>

{#if src && !failed}
	<img
		{src}
		{alt}
		class={className}
		onerror={() => (failed = true)}
		decoding="async"
		loading="lazy"
	/>
{:else}
	<div class={cn(className, 'flex items-center justify-center bg-secondary')} aria-hidden="true">
		<ImageOff class="size-8 text-muted-foreground/40" />
	</div>
{/if}
