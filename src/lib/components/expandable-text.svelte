<script lang="ts">
	// A long body of prose, clamped with a Read more / Show less toggle.
	//
	// The toggle only appears when the text is actually cut off — a short paragraph fits inside the
	// clamp, and a "Read more" that reveals nothing is worse than no control at all. That can only
	// be known by measuring the rendered element, so it's measured while collapsed and skipped while
	// open (expanding removes the clamp, so re-measuring then would make the control vanish the
	// moment it was used).
	//
	// Reset by keying the call site on whatever chose the text, so switching to a different one
	// starts collapsed.
	let {
		text,
		lines = 5,
		class: className = ''
	}: { text: string; lines?: number; class?: string } = $props();

	let open = $state(false);
	let el = $state<HTMLParagraphElement | null>(null);
	let clamped = $state(false);

	$effect(() => {
		const node = el;
		// `text` and `lines` are read so a change re-measures: the same element can be handed longer
		// prose in place, e.g. when a season's full synopsis replaces its summary on enrichment.
		void text;
		void lines;
		if (!node || open) return;
		clamped = node.scrollHeight > node.clientHeight + 1;
	});
</script>

<div class="flex flex-col items-start gap-1">
	<p
		bind:this={el}
		style="--expandable-lines: {lines}"
		class="{className} {open ? '' : 'line-clamp-(--expandable-lines)'}"
	>
		{text}
	</p>
	{#if clamped}
		<button
			type="button"
			onclick={() => (open = !open)}
			aria-expanded={open}
			class="text-xs font-semibold text-primary hover:underline"
		>
			{open ? 'Show less' : 'Read more'}
		</button>
	{/if}
</div>
