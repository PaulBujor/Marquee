<script lang="ts">
	import { Dialog as DialogPrimitive } from 'bits-ui';
	import { cn } from '$lib/utils.js';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: DialogPrimitive.OverlayProps = $props();
</script>

<DialogPrimitive.Overlay
	bind:ref
	data-slot="dialog-overlay"
	class={cn(
		// Matches the content's 200ms so the scrim and the panel settle together. `data-[state=…]`
		// rather than the registry's `data-open:`/`data-closed:` — see `dialog-content.svelte`.
		'fixed inset-0 isolate z-50 bg-black/25 duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 supports-backdrop-filter:backdrop-blur-xs motion-reduce:animate-none dark:bg-black/60',
		className
	)}
	{...restProps}
/>
