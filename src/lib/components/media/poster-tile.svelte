<script lang="ts">
	import { cn } from '$lib/utils.js';
	import { Film, Tv, Heart, FileQuestion } from '@lucide/svelte';

	let {
		type = 'movie',
		isCustom = false,
		isFavorite = false,
		gradientFrom,
		gradientTo,
		class: className,
		children,
		...restProps
	}: {
		type?: 'movie' | 'show';
		isCustom?: boolean;
		isFavorite?: boolean;
		gradientFrom?: string;
		gradientTo?: string;
		class?: string;
		children?: import('svelte').Snippet;
	} = $props();
</script>

<div
	class={cn(
		'relative flex aspect-[2/3] w-full flex-col items-end justify-end overflow-hidden rounded-[14px] bg-secondary',
		isCustom && 'border border-dashed border-border',
		className
	)}
	style:background={!isCustom && gradientFrom
		? `linear-gradient(155deg, ${gradientFrom}, ${gradientTo ?? gradientFrom})`
		: undefined}
	{...restProps}
>
	{#if isCustom}
		<div class="absolute inset-0 flex items-center justify-center">
			<FileQuestion class="size-[26px] text-muted-foreground" />
		</div>
	{/if}

	<div class="absolute top-2 left-2 opacity-50">
		{#if type === 'movie'}
			<Film class="size-3.5 text-white" />
		{:else}
			<Tv class="size-3.5 text-white" />
		{/if}
	</div>

	{#if isFavorite}
		<div class="absolute top-1.5 right-1.5">
			<Heart class="size-4 fill-primary text-primary" />
		</div>
	{/if}

	{@render children?.()}
</div>
