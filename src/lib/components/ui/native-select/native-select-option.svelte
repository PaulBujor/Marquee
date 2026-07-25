<script lang="ts">
	import type { HTMLOptionAttributes } from 'svelte/elements';
	import { cn } from '$lib/utils.js';

	let { class: className, children, ...restProps }: HTMLOptionAttributes = $props();
</script>

<option
	data-slot="native-select-option"
	class={cn('bg-[Canvas] text-[CanvasText]', className)}
	{...restProps}
>
	{@render children?.()}
</option>
