<script lang="ts">
	import { cn } from '$lib/utils.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';

	let {
		lines = 3,
		class: className,
		...restProps
	}: {
		lines?: number;
		class?: string;
	} = $props();
</script>

<div class={cn('space-y-3 py-4', className)} {...restProps}>
	{#each Array.from({ length: lines }, (_, i) => i) as index (index)}
		<div class="flex items-center gap-3">
			<Skeleton class="aspect-[2/3] w-10 shrink-0 rounded-lg" />
			<div class="flex-1 space-y-2">
				<Skeleton class="h-3.5 w-3/4" />
				<Skeleton class="h-2.5 w-1/2" />
			</div>
		</div>
	{/each}
</div>
