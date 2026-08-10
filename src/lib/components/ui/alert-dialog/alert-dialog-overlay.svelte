<!--
	`data-[state=…]:` rather than the registry's `data-open:`/`data-closed:`, and the same motion as
	`dialog-overlay.svelte` — see `dialog-content.svelte` for both, and for why not to re-run
	`shadcn-svelte add alert-dialog` over this.
-->
<script lang="ts">
	import { AlertDialog as AlertDialogPrimitive } from 'bits-ui';
	import { cn } from '$lib/utils.js';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: AlertDialogPrimitive.OverlayProps = $props();
</script>

<AlertDialogPrimitive.Overlay
	bind:ref
	data-slot="alert-dialog-overlay"
	class={cn(
		'fixed inset-0 z-50 bg-black/25 duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 supports-backdrop-filter:backdrop-blur-xs motion-reduce:animate-none dark:bg-black/60',
		className
	)}
	{...restProps}
/>
