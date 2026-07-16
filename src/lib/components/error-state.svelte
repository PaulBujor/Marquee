<script lang="ts">
	import { cn } from '$lib/utils.js';
	import { AlertTriangle } from '@lucide/svelte';

	let {
		class: className,
		message = 'Something went wrong.',
		retry,
		...restProps
	}: {
		class?: string;
		message?: string;
		retry?: () => void;
	} = $props();
</script>

<div
	class={cn('flex flex-col items-center justify-center py-10 text-center', className)}
	{...restProps}
>
	<AlertTriangle class="mb-3 size-10 text-destructive/60" />
	<p class="text-sm text-muted-foreground">{message}</p>
	{#if retry}
		<button
			type="button"
			onclick={retry}
			class="mt-3 text-sm font-semibold text-primary hover:underline"
		>
			Try again
		</button>
	{/if}
</div>
