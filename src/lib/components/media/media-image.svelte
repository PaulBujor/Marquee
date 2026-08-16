<script lang="ts">
	// An offline-capable <img>: renders the cached image Blob (kept in IndexedDB by the media
	// channel) when present, else the TMDB URL. Re-checks after each sync so a poster
	// swaps to its local blob once fetched, and revokes its object URL on teardown / id change.
	import { getMediaImages } from '$lib/client/idb/images';
	import { posterUrl, POSTER_SIZE, type TmdbImageSize } from '$lib/media';
	import { sync } from '$lib/client/sync/engine.svelte';
	import { cn } from '$lib/utils.js';
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

	// Non-reactive bookkeeping for the blob currently shown: its identity (`id:kind:updatedAt`) and
	// the object URL made from it. A sync re-check compares against this so an unchanged blob keeps
	// its existing URL instead of getting a brand-new one — recreating the URL makes the browser
	// reload the <img>, which is the visible "pop" on every event/sync.
	let loadedKey: string | null = null;
	let loadedUrl: string | null = null;

	// Reset the failed flag when the target changes so a new id/path (or a blob arriving on sync) gets
	// a fresh chance to load rather than staying stuck on the placeholder.
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

		// Target changed: the cached URL belongs to the previous title — drop it now so we fall back
		// to the network URL for the new one instead of briefly showing the old poster.
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

	// Revoke the last object URL when the component is destroyed (id-change revocation is handled
	// above; this covers plain unmount).
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
	<!-- No blob and no (reachable) network image — a graceful placeholder instead of a broken img. -->
	<div class={cn(className, 'flex items-center justify-center bg-secondary')} aria-hidden="true">
		<ImageOff class="size-8 text-muted-foreground/40" />
	</div>
{/if}
