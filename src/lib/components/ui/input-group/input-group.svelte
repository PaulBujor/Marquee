<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	/**
	 * A row of controls that reads as one field: the group owns the border, the radius and the focus
	 * ring, and everything inside it is borderless. That's the difference from `button-group`, which
	 * keeps each child's own border and just squares off the seams — fine for buttons, wrong for a
	 * select sitting against a text input, where two outlines make one control look like two.
	 *
	 * Same height, radius and focus treatment as `Input`, so a group and a plain field line up in the
	 * same form.
	 */
	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
	bind:this={ref}
	data-slot="input-group"
	class={cn(
		'flex h-10 w-full min-w-0 items-stretch overflow-hidden rounded-full border border-input bg-transparent transition-colors',
		// The ring belongs to the group, not the focused child — otherwise it draws inside the
		// rounded edge and reads as a control within a control.
		'focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50',
		'has-[[aria-invalid=true]]:border-destructive has-[[aria-invalid=true]]:ring-3 has-[[aria-invalid=true]]:ring-destructive/20',
		'has-[:disabled]:opacity-50 dark:bg-input/30 dark:has-[[aria-invalid=true]]:ring-destructive/40',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>
