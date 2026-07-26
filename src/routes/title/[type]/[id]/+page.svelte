<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import ErrorState from '$lib/components/error-state.svelte';
	import DetailSkeleton from './detail-skeleton.svelte';
	import TitleDetail from './title-detail.svelte';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import type { PageData } from './$types';

	// Thin loader: stream the title in (skeleton while it resolves), then render the detail — or a
	// friendly not-found / offline-unavailable / error state. The rich page lives in TitleDetail so
	// its many derivations always see a non-null `detail`.
	let { data }: { data: PageData } = $props();

	function goBack() {
		if (history.length > 1) history.back();
		else goto(resolve('/'));
	}
</script>

{#snippet backHeader()}
	<header class="fixed inset-x-0 top-0 z-40">
		<div
			class="mx-auto flex w-full max-w-2xl items-center gap-3 px-5 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3"
		>
			<Button
				onclick={goBack}
				variant="outline"
				size="icon"
				shape="round"
				class="shrink-0 text-muted-foreground"
				aria-label="Go back"
			>
				<ChevronLeftIcon class="size-4" />
			</Button>
		</div>
	</header>
{/snippet}

{#await data.content}
	{@render backHeader()}
	<DetailSkeleton />
{:then result}
	{#if result.status === 'ok'}
		{#key result.detail.tmdbId}
			<TitleDetail detail={result.detail} season={result.season} offline={result.offline} />
		{/key}
	{:else}
		{@render backHeader()}
		<main class="mx-auto w-full max-w-2xl px-5 pt-[calc(4.5rem+env(safe-area-inset-top))]">
			<ErrorState
				message={result.status === 'notfound'
					? "We couldn't find this title."
					: "This title isn't available offline yet."}
			/>
		</main>
	{/if}
{:catch}
	{@render backHeader()}
	<main class="mx-auto w-full max-w-2xl px-5 pt-[calc(4.5rem+env(safe-area-inset-top))]">
		<ErrorState message="Could not load this title." retry={() => location.reload()} />
	</main>
{/await}
