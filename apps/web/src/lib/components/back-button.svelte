<script lang="ts">
	// `navigation.canGoBack` (fed by the root layout) rather than a local `afterNavigate`, which fires
	// from `onMount` and misses the navigation when a control mounts late; a button, not an href, to
	// avoid the extra history hop a link adds.

	import { resolve } from '$app/paths';
	import type { ResolvedPathname } from '$app/types';
	import { Button } from '#lib/components/ui/button/index.js';
	import { navigation } from '#lib/state/navigation.svelte.js';
	import { cn } from '#lib/utils.js';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import { navigate } from '#lib/client/navigate.js';

	interface Props {
		/** Where to go on a cold open with no in-app history to pop. A resolved path; defaults to home. */
		fallback?: ResolvedPathname;
		label?: string;
		class?: string;
	}
	let { fallback = resolve('/'), label = 'Go back', class: className = '' }: Props = $props();

	function goBack() {
		if (navigation.canGoBack) history.back();
		else navigate(fallback);
	}
</script>

<!-- Ghost, matching the title page's own control (this stands in for it on the skeleton and error
states, so the two must not differ). -->
<Button
	onclick={goBack}
	variant="ghost"
	size="icon-lg"
	shape="round"
	class={cn('shrink-0', className)}
	aria-label={label}
>
	<ChevronLeftIcon class="size-5" />
</Button>
