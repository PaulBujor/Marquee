<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { buttonVariants } from '$lib/components/ui/button';
	import { cn } from '$lib/utils.js';

	// A button-styled control that's inert while offline, explaining why on hover/focus. It renders a
	// real (enabled) Tooltip trigger — `type="button"` with no action — styled to look disabled, which
	// sidesteps the "disabled elements don't fire tooltip events" gap. Drop it in place of the live
	// control when `!sync.online`.
	let {
		message = 'You need an internet connection for this.',
		variant = 'default',
		class: className,
		children
	}: {
		message?: string;
		variant?: 'default' | 'destructive' | 'outline';
		class?: string;
		children: Snippet;
	} = $props();
</script>

<Tooltip.Provider delayDuration={150}>
	<Tooltip.Root>
		<Tooltip.Trigger
			type="button"
			aria-disabled="true"
			class={cn(buttonVariants({ variant }), 'cursor-not-allowed opacity-50', className)}
		>
			{@render children()}
		</Tooltip.Trigger>
		<Tooltip.Content>{message}</Tooltip.Content>
	</Tooltip.Root>
</Tooltip.Provider>
