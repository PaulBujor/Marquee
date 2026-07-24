<script lang="ts">
	// An offline-capable <img>: renders the cached image Blob (kept in IndexedDB by the media
	// channel, MRQ-111b) when present, else the TMDB URL. Re-checks after each sync so a poster
	// swaps to its local blob once fetched, and revokes its object URL on teardown / id change.
	import { getMediaImages } from '$lib/client/idb/images';
	import { posterUrl, POSTER_SIZE, type TmdbImageSize } from '$lib/media';
	import { sync } from '$lib/client/sync/engine.svelte';

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
	const networkUrl = $derived(posterUrl(path, size));
	const src = $derived(objectUrl ?? networkUrl);

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

{#if src}
	<img {src} {alt} class={className} decoding="async" loading="lazy" />
{/if}
