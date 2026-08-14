<script lang="ts">
	import type { Snippet } from 'svelte';
	import { resolve } from '$app/paths';
	import { detailRoute, type DetailTarget } from '$lib/tracking/detail-route';

	/**
	 * Links a row to its title's detail page, whichever kind of title it is. One component so the
	 * route decision and the two `resolve()` shapes live in one place rather than at every grid,
	 * list and strip that shows a poster.
	 *
	 * A title whose media hasn't synced yet has no page to open, so it renders as a plain wrapper
	 * instead — visibly inert rather than a link that 404s.
	 */
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
