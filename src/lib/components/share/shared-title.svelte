<script lang="ts">
	// The body of a shared title page: the same layout as the signed-in title page, minus what needs
	// a user (tracking controls, similar, seasons/episodes), the back control and the nav bar. The CTA
	// takes the tracking row's place.
	import { slide } from 'svelte/transition';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import StarIcon from '@lucide/svelte/icons/star';
	import MediaBadge from '$lib/components/media/media-badge.svelte';
	import MediaTypeLabel from '$lib/components/media/media-type-label.svelte';
	import PersonAvatar from '$lib/components/media/person-avatar.svelte';
	import PosterTile from '$lib/components/media/poster-tile.svelte';
	import ShareCta from '$lib/components/share/share-cta.svelte';
	import { BACKDROP_SIZE, posterUrl } from '$lib/media.js';
	import type { SharePreview } from '$lib/share-preview';

	interface Props {
		preview: SharePreview;
		/** Where the reader signs in, carrying the title through the detour. */
		loginHref: string;
	}
	let { preview, loginHref }: Props = $props();

	// The app's detail page formats a date-only value in UTC, so a timezone can't shift the day.
	const dateFmt = new Intl.DateTimeFormat(undefined, {
		day: 'numeric',
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC'
	});
	const formatDate = (iso: string) => dateFmt.format(new Date(`${iso}T00:00:00Z`));

	const backdrop = $derived(posterUrl(preview.backdropPath, BACKDROP_SIZE));
	const crew = $derived(preview.crew);
	const hasCrew = $derived(
		Boolean(crew.director) ||
			crew.creators.length > 0 ||
			crew.writers.length > 0 ||
			crew.producers.length > 0
	);

	let detailsOpen = $state(true);
</script>

<main class="mx-auto w-full">
	{#if backdrop}
		<div class="relative">
			<img src={backdrop} alt="" class="aspect-video max-h-[300px] w-full object-cover" />
			<div
				class="absolute inset-0 bg-gradient-to-t from-background via-background/30 to-transparent"
			></div>
		</div>
	{/if}

	<div
		class="mx-auto flex w-full max-w-3xl flex-col gap-4 px-5 pb-10 {backdrop
			? '-mt-14'
			: 'pt-[calc(4.75rem+env(safe-area-inset-top))]'}"
	>
		<!-- Poster overlaps the bottom of the backdrop; title/badges sit alongside it. -->
		<div class="flex items-end gap-4">
			<div class="w-24 shrink-0">
				<PosterTile
					type={preview.type}
					posterUrl={posterUrl(preview.imagePath)}
					alt={preview.name}
					class="shadow-xl ring-4 ring-background"
				/>
			</div>
			<div class="flex min-w-0 flex-1 flex-col gap-2 pb-1">
				<h1 class="font-serif text-2xl leading-tight font-semibold text-balance break-words">
					{preview.name}
				</h1>
				<div class="flex flex-wrap items-center gap-2">
					<MediaTypeLabel type={preview.type} year={preview.year} seasons={preview.seasons} />
					{#if preview.production === 'in_production'}
						<MediaBadge variant="production">
							<span class="size-1.5 rounded-full bg-primary"></span>In production
						</MediaBadge>
					{:else if preview.production === 'ended'}
						<MediaBadge variant="status">Ended</MediaBadge>
					{/if}
				</div>
			</div>
		</div>

		<div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
			{#if preview.rating !== null}
				<span class="flex items-center gap-1.5">
					<StarIcon class="size-4 fill-primary text-primary" />
					<span class="font-semibold">{preview.rating.toFixed(1)}</span>
					<span class="text-muted-foreground">/10</span>
				</span>
			{/if}
			{#if preview.runtime !== null}
				<span class="flex items-center gap-1.5 text-muted-foreground">
					<ClockIcon class="size-4" />
					{preview.runtime} min{preview.type === 'show' ? ' / ep' : ''}
				</span>
			{/if}
			{#each preview.genres as genre (genre)}
				<MediaBadge variant="genre">{genre}</MediaBadge>
			{/each}
		</div>

		<!-- Where the signed-in page keeps its tracking controls. -->
		<ShareCta href={loginHref} />

		<!-- Collapsible details: overview, crew, cast. -->
		<div class="flex flex-col gap-4">
			<button
				type="button"
				onclick={() => (detailsOpen = !detailsOpen)}
				aria-expanded={detailsOpen}
				class="flex items-center gap-1.5 self-start text-xs font-bold tracking-widest text-muted-foreground uppercase"
			>
				<ChevronDownIcon
					class="size-3.5 transition-transform duration-150 {detailsOpen ? '' : '-rotate-90'}"
				/>
				Details
			</button>

			{#if detailsOpen}
				<div class="flex flex-col gap-4" transition:slide={{ duration: 200 }}>
					{#if preview.summary}
						<p class="text-sm leading-relaxed">{preview.summary}</p>
					{/if}

					{#if preview.releasedOn || hasCrew}
						<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
							{#if preview.releasedOn}
								<dt class="text-muted-foreground">Released</dt>
								<dd>{formatDate(preview.releasedOn)}</dd>
							{/if}
							{#if crew.director}
								<dt class="text-muted-foreground">Director</dt>
								<dd>{crew.director}</dd>
							{/if}
							{#if crew.creators.length > 0}
								<dt class="text-muted-foreground">
									{crew.creators.length > 1 ? 'Creators' : 'Creator'}
								</dt>
								<dd>{crew.creators.join(', ')}</dd>
							{/if}
							{#if crew.writers.length > 0}
								<dt class="text-muted-foreground">
									{crew.writers.length > 1 ? 'Writers' : 'Writer'}
								</dt>
								<dd>{crew.writers.join(', ')}</dd>
							{/if}
							{#if crew.producers.length > 0}
								<dt class="text-muted-foreground">
									{crew.producers.length > 1 ? 'Producers' : 'Producer'}
								</dt>
								<dd>{crew.producers.join(', ')}</dd>
							{/if}
						</dl>
					{/if}

					{#if preview.cast.length > 0}
						<section class="flex flex-col gap-3">
							<h2 class="text-xs font-bold tracking-widest text-muted-foreground uppercase">
								Cast
							</h2>
							<ul class="no-scrollbar flex gap-3.5 overflow-x-auto pb-1">
								{#each preview.cast as member, i (i)}
									<!-- Faces and names only: a shared page links to nobody. -->
									<li class="flex w-16 shrink-0 flex-col items-center text-center">
										<PersonAvatar
											name={member.name}
											profilePath={member.profilePath}
											class="size-14"
										/>
										<span class="mt-1.5 text-[0.7rem] leading-tight font-medium">{member.name}</span
										>
									</li>
								{/each}
							</ul>
						</section>
					{/if}
				</div>
			{/if}
		</div>
	</div>
</main>
