<script lang="ts">
	import { cn } from '$lib/utils.js';

	let {
		variant = 'default',
		dashed = false,
		class: className,
		children,
		...restProps
	}: {
		variant?: 'default' | 'status' | 'genre' | 'custom' | 'airing';
		dashed?: boolean;
		class?: string;
		children?: import('svelte').Snippet;
	} = $props();
</script>

<span
	class={cn(
		'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[0.65rem] font-bold tracking-widest uppercase',
		variant === 'default' && 'border border-border text-muted-foreground',
		variant === 'status' && 'border border-border text-muted-foreground',
		variant === 'genre' && 'bg-secondary text-secondary-foreground',
		variant === 'custom' && 'border border-dashed border-border text-muted-foreground',
		// A currently-ongoing show is the one status worth calling out visually; everything else
		// (finished, genres, plain type/year) stays on the neutral pill treatment.
		variant === 'airing' && 'border border-primary/40 bg-primary/10 text-primary',
		dashed && 'border-dashed',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</span>
