<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import AppHeader from '$lib/components/app-header.svelte';
	import { theme } from '$lib/state/theme.svelte.js';
	import type { LayoutData } from './$types';

	let { children, data }: { children: import('svelte').Snippet; data: LayoutData } = $props();

	$effect(() => {
		document.documentElement.classList.toggle('dark', theme.isDark);
	});

	$effect(() => {
		if (typeof window === 'undefined') return;
		const mq = window.matchMedia('(prefers-color-scheme: dark)');
		const handler = () => {
			if (theme.mode === 'auto') {
				document.documentElement.classList.toggle('dark', mq.matches);
			}
		};
		mq.addEventListener('change', handler);
		return () => mq.removeEventListener('change', handler);
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<!-- iOS home-screen icon; without it Safari probes /apple-touch-icon(-precomposed).png and 404s. -->
	<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
	<link rel="manifest" href="/manifest.json" />
	<meta name="theme-color" content="#8B5CF6" />
</svelte:head>
{#if data.user}
	<AppHeader user={data.user} />
{/if}
{@render children()}
