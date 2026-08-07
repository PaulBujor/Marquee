<script lang="ts">
	import MediaBadge from './media-badge.svelte';

	let {
		type,
		year,
		seasons = 0
	}: {
		type: 'movie' | 'show';
		year: number | null;
		/** Season count (excluding Specials) — appended for shows only, when known and non-zero. */
		seasons?: number;
	} = $props();
</script>

<MediaBadge>
	{type === 'movie' ? 'Movie' : 'Show'}{year ? ` · ${year}` : ''}{seasons > 0
		? ` · ${seasons} season${seasons === 1 ? '' : 's'}`
		: ''}
</MediaBadge>
