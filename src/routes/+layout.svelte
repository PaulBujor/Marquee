<script lang="ts">
	import './layout.css';
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
	<link rel="icon" href="/favicon.ico" sizes="any" />
	<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png" />
	<link rel="icon" type="image/png" sizes="16x16" href="/icons/favicon-16.png" />
	<!-- iOS home-screen icon; without it Safari probes /apple-touch-icon(-precomposed).png and 404s. -->
	<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
	<link rel="manifest" href="/manifest.json" />
	<meta name="theme-color" content="#8B5CF6" />
	<!-- Standalone web-app mode. iOS only consults the apple-touch-startup-image
	links below when launched as a standalone web app, so this must be present. -->
	<meta name="mobile-web-app-capable" content="yes" />
	<meta name="apple-mobile-web-app-capable" content="yes" />

	<!-- iOS PWA splash screens: iOS matches a static image by exact device
	resolution + orientation. Single (dark) set while we confirm iOS honours
	these at all; prefers-color-scheme on startup images is unreliable. -->
	<!-- iPhone 15 Pro (393x852 @3) -->
	<link
		rel="apple-touch-startup-image"
		media="(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"
		href="/splash/iphone15pro-portrait-dark.png"
	/>
	<link
		rel="apple-touch-startup-image"
		media="(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)"
		href="/splash/iphone15pro-landscape-dark.png"
	/>
	<!-- iPad Air M1 (820x1180 @2) -->
	<link
		rel="apple-touch-startup-image"
		media="(device-width: 820px) and (device-height: 1180px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)"
		href="/splash/ipadair-portrait-dark.png"
	/>
	<link
		rel="apple-touch-startup-image"
		media="(device-width: 820px) and (device-height: 1180px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)"
		href="/splash/ipadair-landscape-dark.png"
	/>
</svelte:head>
{#if data.user}
	<AppHeader />
{/if}
{@render children()}
