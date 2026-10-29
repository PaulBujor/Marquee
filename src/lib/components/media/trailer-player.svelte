<script lang="ts">
	import PlayIcon from '@lucide/svelte/icons/play';

	let {
		trailer,
		playing = $bindable(false)
	}: {
		trailer: { key: string; name: string } | null;
		playing?: boolean;
	} = $props();
</script>

{#if trailer}
	<section class="flex flex-col gap-3">
		<h2 class="text-xs font-bold tracking-widest text-muted-foreground uppercase">Trailer</h2>
		{#if playing}
			<div class="aspect-video w-full overflow-hidden rounded-md">
				<iframe
					src={`https://www.youtube-nocookie.com/embed/${trailer.key}?autoplay=1`}
					title={trailer.name}
					allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
					allowfullscreen
					class="h-full w-full border-0"
				></iframe>
			</div>
		{:else}
			<button
				type="button"
				onclick={() => (playing = true)}
				class="group relative aspect-video w-full overflow-hidden rounded-md bg-secondary"
				aria-label={`Play trailer: ${trailer.name}`}
			>
				<img
					src={`https://img.youtube.com/vi/${trailer.key}/hqdefault.jpg`}
					alt=""
					loading="lazy"
					decoding="async"
					class="absolute inset-0 h-full w-full object-cover"
				/>
				<span
					class="absolute inset-0 flex items-center justify-center bg-black/20 transition-colors group-hover:bg-black/30"
				>
					<span
						class="flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground"
					>
						<PlayIcon class="size-5 translate-x-0.5 fill-current" />
					</span>
				</span>
			</button>
		{/if}
	</section>
{/if}
