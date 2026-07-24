<script lang="ts">
	import './layout.css';
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import AppHeader from '$lib/components/app-header.svelte';
	import InstallPrompt from '$lib/components/install-prompt.svelte';
	import PwaUpdatePrompt from '$lib/components/pwa-update-prompt.svelte';
	import { theme } from '$lib/state/theme.svelte.js';
	import { setActiveUser } from '$lib/client/idb';
	import { sync } from '$lib/client/sync/engine.svelte.js';
	import type { LayoutData } from './$types';

	let { children, data }: { children: import('svelte').Snippet; data: LayoutData } = $props();

	// Scope the local store to the signed-in user *before* any tracking UI opens it (the layout
	// script runs before child pages mount). Per-user database (`marquee-<id>`) — a wrong-account
	// login opens a different DB, never clearing the prior user's data. `untrack`: a deliberate
	// one-shot read of the initial user; the effect below handles any later change.
	if (typeof window !== 'undefined') {
		const initialUser = untrack(() => data.user);
		if (initialUser) setActiveUser(initialUser.id);
	}

	// Drive background event sync while signed in; tear down (and detach the store) on logout.
	$effect(() => {
		if (!data.user) {
			sync.stop();
			setActiveUser(null);
			return;
		}
		setActiveUser(data.user.id);
		sync.start();
		return () => sync.stop();
	});

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

	// OS chrome matches the app background (not the accent); hex mirror `--background`.
	const themeColor = $derived(theme.isDark ? '#090a0e' : '#f7f6f3');
</script>

<svelte:head>
	<link rel="icon" href="/favicon.ico" sizes="any" />
	<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png" />
	<link rel="icon" type="image/png" sizes="16x16" href="/icons/favicon-16.png" />
	<!-- iOS home-screen icon; without it Safari probes /apple-touch-icon(-precomposed).png and 404s. -->
	<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
	<link rel="manifest" href="/manifest.json" />
	<meta name="theme-color" content={themeColor} />
	<!-- Standalone web-app mode. iOS only consults the apple-touch-startup-image
	links below when launched as a standalone web app, so this must be present. -->
	<meta name="mobile-web-app-capable" content="yes" />
	<meta name="apple-mobile-web-app-capable" content="yes" />
	<meta name="apple-mobile-web-app-title" content="Marquee" />
	<!-- Translucent status bar so the dark splash/app background extends under it. -->
	<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />

	<!-- iOS PWA splash screens: iOS matches a static image by exact device
	resolution + orientation. The light link (no prefers-color-scheme) is the
	default/fallback so a splash always shows; the dark link adds
	(prefers-color-scheme: dark) to override it in dark mode. -->
	<!-- iPhone 15 Pro (393x852 @3) -->
	<link
		rel="apple-touch-startup-image"
		media="screen and (device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"
		href="/splash/iphone15pro-portrait-light.png"
	/>
	<link
		rel="apple-touch-startup-image"
		media="screen and (prefers-color-scheme: dark) and (device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"
		href="/splash/iphone15pro-portrait-dark.png"
	/>
	<link
		rel="apple-touch-startup-image"
		media="screen and (device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)"
		href="/splash/iphone15pro-landscape-light.png"
	/>
	<link
		rel="apple-touch-startup-image"
		media="screen and (prefers-color-scheme: dark) and (device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)"
		href="/splash/iphone15pro-landscape-dark.png"
	/>
	<!-- iPad Air 5th gen (954x1373 @2) -->
	<link
		rel="apple-touch-startup-image"
		media="screen and (device-width: 954px) and (device-height: 1373px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)"
		href="/splash/ipadair-portrait-light.png"
	/>
	<link
		rel="apple-touch-startup-image"
		media="screen and (prefers-color-scheme: dark) and (device-width: 954px) and (device-height: 1373px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)"
		href="/splash/ipadair-portrait-dark.png"
	/>
	<link
		rel="apple-touch-startup-image"
		media="screen and (device-width: 954px) and (device-height: 1373px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)"
		href="/splash/ipadair-landscape-light.png"
	/>
	<link
		rel="apple-touch-startup-image"
		media="screen and (prefers-color-scheme: dark) and (device-width: 954px) and (device-height: 1373px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)"
		href="/splash/ipadair-landscape-dark.png"
	/>
</svelte:head>
<!-- The header (branding + nav) rides on the home page only; other pages carry their own
back navigation, keeping the movie/show page's immersive layout uncluttered. -->
{#if data.user && page.url.pathname === '/'}
	<AppHeader />
{/if}
{@render children()}
<InstallPrompt />
<PwaUpdatePrompt />
