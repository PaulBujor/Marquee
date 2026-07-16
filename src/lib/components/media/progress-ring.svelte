<script lang="ts">
	import { cn } from '$lib/utils.js';

	let {
		progress,
		size = 34,
		stroke = 3,
		class: className,
		...restProps
	}: {
		progress: number;
		size?: number;
		stroke?: number;
		class?: string;
	} = $props();

	const r = $derived((size - stroke) / 2);
	const circumference = $derived(2 * Math.PI * r);
	const offset = $derived(circumference * (1 - Math.min(1, Math.max(0, progress))));
</script>

<svg width={size} height={size} class={cn('shrink-0 -rotate-90', className)} {...restProps}>
	<circle
		cx={size / 2}
		cy={size / 2}
		{r}
		fill="none"
		stroke="currentColor"
		class="text-border"
		stroke-width={stroke}
	/>
	<circle
		cx={size / 2}
		cy={size / 2}
		{r}
		fill="none"
		stroke="currentColor"
		class="text-primary"
		stroke-width={stroke}
		stroke-dasharray={circumference}
		stroke-dashoffset={offset}
		stroke-linecap="round"
		style:transition="stroke-dashoffset 0.4s ease"
	/>
</svg>
