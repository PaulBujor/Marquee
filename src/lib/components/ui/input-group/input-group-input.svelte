<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLInputAttributes } from 'svelte/elements';

	/** The text field inside an {@link InputGroup} — borderless, because the group draws the border. */
	let {
		ref = $bindable(null),
		value = $bindable(),
		class: className,
		...restProps
	}: WithElementRef<HTMLInputAttributes> = $props();
</script>

<input
	bind:this={ref}
	bind:value
	data-slot="input-group-input"
	class={cn(
		'h-full min-w-0 flex-1 bg-transparent px-4 text-base outline-none placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed md:text-sm',
		className
	)}
	{...restProps}
/>
