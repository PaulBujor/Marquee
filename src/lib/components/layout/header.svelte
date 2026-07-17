<script lang="ts">
	import { cn } from '$lib/utils.js';

	let {
		class: className,
		actions,
		children,
		...restProps
	}: {
		class?: string;
		actions?: import('svelte').Snippet;
		children?: import('svelte').Snippet;
	} = $props();
</script>

<header
	class={cn('flex shrink-0 items-center justify-between px-5 pt-5 pb-3', className)}
	{...restProps}
>
	{@render children?.()}

	{#if actions}
		<div class="flex gap-2">
			{@render actions?.()}
		</div>
	{/if}
</header>
