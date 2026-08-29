<script lang="ts">
	import type { Snippet } from 'svelte';
	import { resolve } from '$app/paths';
	import { detailRoute, type DetailTarget } from '$lib/tracking/detail-route';

	/** Links a title to its detail page (custom or provider-backed), or renders inert when no page exists. */
	interface Props {
		item: DetailTarget;
		class?: string;
		ariaLabel?: string;
		children: Snippet;
	}
	let { item, class: className, ariaLabel, children }: Props = $props();

	const route = $derived(detailRoute(item));
	const href = $derived(
		route === null
			? null
			: route.kind === 'custom'
				? resolve('/custom/[id]', { id: route.id })
				: resolve('/title/[type]/[id]', { type: route.type, id: route.id })
	);
</script>

{#if href}
	<a {href} class={className} aria-label={ariaLabel}>
		{@render children()}
	</a>
{:else}
	<div class={className} aria-label={ariaLabel}>
		{@render children()}
	</div>
{/if}
