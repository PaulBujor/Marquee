<script lang="ts">
	import { cn } from '$lib/utils.js';

	let {
		variant = 'default',
		class: className,
		title: ariaLabel,
		children,
		...restProps
	}: {
		variant?: 'default' | 'accent';
		class?: string;
		title?: string;
		children?: import('svelte').Snippet;
		[key: string]: unknown;
	} = $props();
</script>

<button
	type="button"
	title={ariaLabel}
	class={cn(
		'flex size-[34px] shrink-0 items-center justify-center rounded-full border text-muted-foreground transition-colors',
		variant === 'default' && 'border-border bg-secondary hover:bg-secondary/80',
		variant === 'accent' && 'border-primary bg-primary text-primary-foreground hover:bg-primary/90',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</button>
