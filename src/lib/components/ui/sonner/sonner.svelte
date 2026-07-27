<script lang="ts">
	import { Toaster as Sonner, type ToasterProps } from 'svelte-sonner';
	import { theme } from '$lib/state/theme.svelte.js';

	let { ...restProps }: ToasterProps = $props();
</script>

<Sonner
	theme={theme.isDark ? 'dark' : 'light'}
	class="toaster group"
	position="bottom-center"
	style="--normal-bg: var(--color-popover); --normal-text: var(--color-popover-foreground); --normal-border: var(--color-border);"
	{...restProps}
/>

<!-- Reshape Sonner's defaults to fit the app design system: rounder card, pill action button,
     and the dismiss (Sonner's close button) pulled inline to the LEFT so it mirrors the action
     button on the right. Toasts render in a portal, so these are global + scoped under `.toaster`
     (higher specificity than Sonner's own `[data-sonner-toast]` rules). -->
<style>
	:global(.toaster [data-sonner-toast][data-styled='true']) {
		gap: 0.625rem;
		padding: 0.75rem;
		border-radius: calc(var(--radius) + 4px);
	}

	:global(.toaster [data-sonner-toast][data-styled='true']) :global([data-title]) {
		font-size: 0.875rem;
		font-weight: 400;
	}

	/* Message fills the row so the action sits flush right and the dismiss flush left. */
	:global(.toaster [data-sonner-toast][data-styled='true']) :global([data-content]) {
		flex: 1 1 auto;
	}

	/* Action (confirm) — primary pill with a comfortable touch target. */
	:global(.toaster [data-sonner-toast][data-styled='true']) :global([data-button]) {
		order: 1;
		height: 2.25rem;
		padding-inline: 1rem;
		margin: 0;
		border-radius: 9999px;
		font-size: 0.875rem;
		font-weight: 500;
		background: var(--primary);
		color: var(--primary-foreground);
	}
	:global(.toaster [data-sonner-toast][data-styled='true']) :global([data-button]:hover) {
		background: color-mix(in oklab, var(--primary) 90%, transparent);
	}
	:global(.toaster [data-sonner-toast][data-styled='true']) :global([data-button]:active) {
		background: color-mix(in oklab, var(--primary) 80%, transparent);
	}

	/* Dismiss — Sonner's close button, moved inline to the LEFT to mirror the action button. */
	:global(.toaster [data-sonner-toast][data-styled='true']) :global([data-close-button]) {
		position: static;
		order: -1;
		transform: none;
		height: 2.25rem;
		width: 2.25rem;
		border: none;
		border-radius: 9999px;
		background: transparent;
		color: var(--muted-foreground);
		opacity: 1;
	}
	:global(.toaster [data-sonner-toast][data-styled='true']) :global([data-close-button] svg) {
		height: 1.05rem;
		width: 1.05rem;
	}
	:global(.toaster [data-sonner-toast][data-styled='true']) :global([data-close-button]:hover) {
		background: var(--muted);
		color: var(--foreground);
	}
</style>
