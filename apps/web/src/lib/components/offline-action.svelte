<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { buttonVariants } from '#lib/components/ui/button/index.js';
	import { cn } from '#lib/utils.js';

	// An enabled button styled as disabled sidesteps "disabled elements don't fire tooltip events".
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
