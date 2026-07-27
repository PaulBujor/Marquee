<script lang="ts">
	// Shared back control for secondary pages (search, settings, timeline, the title skeleton/error
	// headers). When we arrived from within the app it pops browser history (`history.back()`), so
	// Back unwinds the existing stack instead of pushing a fresh entry; when the page was opened cold
	// (deep link / new tab) there's nothing in-app to pop, so it navigates to a fallback (home by
	// default). "Came from within the app" is read from the shared `navigation` state (fed by the root
	// layout), not a local `afterNavigate` — that fires from `onMount` and misses the navigation when a
	// control mounts late. Using a real anchor-free button avoids the extra history hop a plain `href`
	// link adds. The title-detail page keeps its own richer control (suggestion-chain origin).
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import { navigation } from '$lib/state/navigation.svelte.js';
	import { cn } from '$lib/utils.js';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';

	interface Props {
		/** Where to go on a cold open with no in-app history to pop. A resolved path; defaults to home. */
		fallback?: string;
		/** Accessible label. */
		label?: string;
		class?: string;
	}
	let { fallback = resolve('/'), label = 'Go back', class: className = '' }: Props = $props();

	function goBack() {
		if (navigation.canGoBack) history.back();
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- `fallback` is a resolved path
		else goto(fallback);
	}
</script>

<Button
	onclick={goBack}
	variant="outline"
	size="icon"
	shape="round"
	class={cn('shrink-0 text-muted-foreground', className)}
	aria-label={label}
>
	<ChevronLeftIcon class="size-4" />
</Button>
