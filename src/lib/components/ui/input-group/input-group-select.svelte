<script lang="ts">
	import { cn } from '$lib/utils.js';
	import type { HTMLSelectAttributes } from 'svelte/elements';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';

	/** A native select as a segment of an InputGroup — borderless, with a divider facing the group. */
	type Props = Omit<HTMLSelectAttributes, 'size'> & {
		/** Which side of the group this segment sits on; decides where its divider goes. */
		side?: 'start' | 'end';
	};

	let {
		value = $bindable(),
		class: className,
		side = 'start',
		children,
		...restProps
	}: Props = $props();
</script>

<div
	data-slot="input-group-select"
	class={cn(
		'relative flex shrink-0 items-center',
		side === 'start' ? 'border-r border-input' : 'border-l border-input',
		className
	)}
>
	<select
		bind:value
		class="h-full w-full appearance-none bg-transparent py-0 pr-8 pl-4 text-sm outline-none select-none disabled:pointer-events-none disabled:cursor-not-allowed"
		{...restProps}
	>
		{@render children?.()}
	</select>
	<ChevronDownIcon
		class="pointer-events-none absolute right-2.5 size-4 text-muted-foreground"
		aria-hidden="true"
	/>
</div>
