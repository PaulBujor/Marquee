<script lang="ts">
	// An offline-capable <img>: renders the cached image Blob (kept in IndexedDB by the media
	// channel, MRQ-111b) when present, else the TMDB URL. Re-checks after each sync so a poster
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
		void sync.revision; // re-check for a freshly-cached blob after a sync
		const currentId = id;
		const currentKind = kind;
		let created: string | null = null;
		let cancelled = false;

		getMediaImages(currentId).then((images) => {
			if (cancelled) return;
			const blob = currentKind === 'poster' ? images?.poster : images?.backdrop;
			if (blob) {
				created = URL.createObjectURL(blob);
				objectUrl = created;
			}
		});

		return () => {
			cancelled = true;
			if (created) URL.revokeObjectURL(created);
			objectUrl = null;
		};
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
