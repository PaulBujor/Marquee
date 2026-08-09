<script lang="ts">
	// Escape hatch for a mis-tapped Dashboard tab. Re-tapping the tab you're already on scrolls to the
	// top, which is the right default but destroys a hard-won position in a long, paginated grid — so
	// for a few seconds we offer the way back. Only the dashboard raises the offer; the other
	// destinations are cheap enough to scroll through again that a pill there would read as an error
	// message after an ordinary gesture.
	import { afterNavigate } from '$app/navigation';
	import { fly } from 'svelte/transition';
	import { prefersReducedMotion } from 'svelte/motion';
	import { tabs } from '$lib/state/tabs.svelte.js';
	import Undo2Icon from '@lucide/svelte/icons/undo-2';

	const VISIBLE_MS = 3000;

	const offer = $derived(tabs.undoOffer);
	const motionMs = $derived(prefersReducedMotion.current ? 0 : 200);

	$effect(() => {
		if (offer === null) return;
		const timer = setTimeout(() => tabs.clearUndo(), VISIBLE_MS);
		return () => clearTimeout(timer);
	});

	// A navigation supersedes the offer — the position it points at belongs to a page we've left.
	afterNavigate(() => tabs.clearUndo());

	function undo(y: number) {
		tabs.clearUndo();
		window.scrollTo({ top: y, behavior: prefersReducedMotion.current ? 'auto' : 'smooth' });
	}
</script>

<div
	aria-live="polite"
	class="pointer-events-none fixed inset-x-0 bottom-[calc(var(--tab-bar-live)+1.5rem)] z-40 flex justify-center px-4"
>
	{#if offer !== null}
		<button
			type="button"
			onclick={() => undo(offer)}
			transition:fly={{ y: 8, duration: motionMs }}
			class="glass pointer-events-auto flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-popover-foreground"
		>
			<Undo2Icon class="size-4 text-muted-foreground" />
			Back to where you were
		</button>
	{/if}
</div>
