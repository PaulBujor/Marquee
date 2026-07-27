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
