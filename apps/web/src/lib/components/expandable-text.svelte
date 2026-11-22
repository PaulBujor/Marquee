<script lang="ts">
	let {
		text,
		lines = 5,
		class: className = ''
	}: { text: string; lines?: number; class?: string } = $props();

	let expanded = $state(false);
	let paragraph = $state<HTMLParagraphElement | null>(null);
	let isTruncated = $state(false);
	let measuredContent = '';

	$effect(() => {
		const contentToMeasure = `${lines}:${text}`;
		if (!paragraph || expanded || contentToMeasure === measuredContent) return;
		measuredContent = contentToMeasure;
		isTruncated = paragraph.scrollHeight > paragraph.clientHeight + 1;
	});
</script>

<div class="flex flex-col items-start gap-1">
	<p
		bind:this={paragraph}
		style="--expandable-lines: {lines}"
		class="{className} {expanded ? '' : 'line-clamp-(--expandable-lines)'}"
	>
		{text}
	</p>
	{#if isTruncated}
		<button
			type="button"
			onclick={() => (expanded = !expanded)}
			aria-expanded={expanded}
			class="text-xs font-semibold text-primary hover:underline"
		>
			{expanded ? 'Show less' : 'Read more'}
		</button>
	{/if}
</div>
