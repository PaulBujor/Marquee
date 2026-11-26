<script lang="ts">
	import { cn } from '#lib/utils.js';

	let {
		variant = 'default',
		dashed = false,
		class: className,
		children,
		...restProps
	}: {
		variant?: 'default' | 'status' | 'genre' | 'custom' | 'production' | 'unavailable';
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
		variant === 'production' && 'border border-primary/40 bg-primary/10 text-primary',
		// Informational, not an error: a solid backing keeps it legible where it sits over a poster.
		variant === 'unavailable' &&
			'border border-border bg-card/90 text-muted-foreground backdrop-blur-sm',
		dashed && 'border-dashed',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</span>
