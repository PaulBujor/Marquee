<script lang="ts">
	import StarIcon from '@lucide/svelte/icons/star';
	import { cn } from '$lib/utils.js';

	// The user's own 1–5 rating control. Deliberately distinct from the single purple TMDB `/10`
	// star on the detail page: a five-star row in amber. Interactive when `onRate` is given
	// (click a star to set it, click the active star to clear); read-only otherwise, for list overlays.
	interface Props {
		/** Current rating 1–5, or null when unrated. */
		value: number | null;
		/** Set the rating (clicking the active star clears it → null). Omit to render read-only. */
		onRate?: (rating: number | null) => void;
		disabled?: boolean;
		size?: 'sm' | 'md';
		class?: string;
	}
	let { value, onRate, disabled = false, size = 'md', class: className }: Props = $props();

	const readonly = $derived(onRate === undefined);
	let hover = $state<number | null>(null);
	// Paint the hovered star (interactive preview) if any, otherwise the committed value.
	const shown = $derived(hover ?? value ?? 0);
	const starSize = $derived(size === 'sm' ? 'size-3.5' : 'size-5');

	function choose(n: number) {
		if (disabled || !onRate) return;
		onRate(value === n ? null : n); // click the active star to clear
	}
</script>

<div
	class={cn('flex items-center gap-0.5', className)}
	role={readonly ? undefined : 'group'}
	aria-label={readonly ? undefined : 'Your rating'}
	onmouseleave={() => (hover = null)}
>
	{#each [1, 2, 3, 4, 5] as n (n)}
		{@const filled = n <= shown}
		{#if readonly}
			<StarIcon
				class={cn(starSize, filled ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/40')}
			/>
		{:else}
			<button
				type="button"
				{disabled}
				onclick={() => choose(n)}
				onmouseenter={() => (hover = n)}
				onfocus={() => (hover = n)}
				onblur={() => (hover = null)}
				aria-label={value === n ? `Clear rating` : `Rate ${n} star${n === 1 ? '' : 's'}`}
				aria-pressed={value !== null && n <= value}
				title={value === n ? 'Clear rating' : `${n} / 5`}
				class="rounded-sm transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
			>
				<StarIcon
					class={cn(
						starSize,
						filled ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/40'
					)}
				/>
			</button>
		{/if}
	{/each}
</div>
