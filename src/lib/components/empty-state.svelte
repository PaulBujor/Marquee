<script lang="ts">
	import { cn } from '$lib/utils.js';

	let {
		class: className,
		icon: Icon,
		message,
		action,
		...restProps
	}: {
		class?: string;
		icon?: import('svelte').Component;
		message: string;
		action?: import('svelte').Snippet;
	} = $props();
</script>

<div
	class={cn('flex flex-col items-center justify-center py-10 text-center', className)}
	{...restProps}
>
	{#if Icon}
		<Icon class="mb-3 size-10 text-muted-foreground/50" />
	{/if}
	<p class="text-sm text-muted-foreground">{message}</p>
	{#if action}
		<div class="mt-4">
			{@render action?.()}
		</div>
	{/if}
</div>
