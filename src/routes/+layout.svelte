<script lang="ts">
	import './layout.css';
	import { tick, untrack } from 'svelte';
	import { afterNavigate, beforeNavigate, onNavigate } from '$app/navigation';
	import { prefersReducedMotion } from 'svelte/motion';
	import { page } from '$app/state';
	import AppHeader from '$lib/components/app-header.svelte';
	import InstallPrompt from '$lib/components/install-prompt.svelte';
	import NotificationPrompt from '$lib/components/notification-prompt.svelte';
	import PwaUpdatePrompt from '$lib/components/pwa-update-prompt.svelte';
	import ScrollUndoPill from '$lib/components/scroll-undo-pill.svelte';
	import TabBar from '$lib/components/tab-bar.svelte';
	import { Toaster } from '$lib/components/ui/sonner';
	import { goto } from '$app/navigation';
	import { theme } from '$lib/state/theme.svelte.js';
	import { activeTab } from '$lib/state/tabs';
	import { tabs } from '$lib/state/tabs.svelte.js';
	import { getReferencedMediaIds, setActiveUser } from '$lib/client/idb';
	import { library } from '$lib/tracking/library.svelte';
	import { flushPendingLogout } from '$lib/client/logout';
	import { pruneMediaImages } from '$lib/client/idb/images';
	import { pruneStaleMedia } from '$lib/client/idb/media';
	import { requestPersistentStorage } from '$lib/client/storage';
	import { sync } from '$lib/client/sync/engine.svelte.js';
	import { navigation } from '$lib/state/navigation.svelte.js';
	import type { LayoutData } from './$types';

	let { children, data }: { children: import('svelte').Snippet; data: LayoutData } = $props();

	// Track in-app navigation once, here in the persistent root layout, so the shared back-navigation
	// state reliably sees every navigation regardless of when a per-page back control mounts. The
	// same pass feeds the tab bar's memory of where you were on each destination — the dashboard and
	// search both mirror their state into the URL with `goto`, so their filters and query land here
	// for free, with no per-page hook.
	afterNavigate((nav) => {
		navigation.record(nav.from?.url);
		const to = nav.to?.url ?? page.url;
		tabs.record(to);
		const restore = tabs.takeRestore(activeTab(to.pathname));
		if (restore !== null) void restoreScroll(restore);
	});

	// Remember the scroll offset of the destination being left.
	beforeNavigate(() => tabs.captureScroll(page.url.pathname, window.scrollY));

	/**
	 * Scroll a freshly-entered tab back to where it was. Only ever called for a tab-bar navigation
	 * (the arm/consume ticket above) — every other arrival keeps SvelteKit's own scroll handling.
	 * Runs as a short convergence loop because a lazily-paginated page (the dashboard) remounts
	 * shorter than it was: each clamped scroll pulls its load-more sentinel into range, growing the
	 * list so the next frame can reach deeper. Bounded, so it can never spin.
	 */
	async function restoreScroll(y: number) {
		for (let i = 0; i < 5 && window.scrollY < y - 1; i++) {
			await tick();
			window.scrollTo(0, y);
			await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
		}
	}

	// Cross-fade between pages. Skipped when the pathname is unchanged: the dashboard's filter
	// mirroring and the search page's `?q=` push are same-page `goto`s that would otherwise fade the
	// whole screen on every keystroke. Back/forward are deliberately included, and browsers without
	// the API just navigate as before.
	onNavigate((nav) => {
		if (!document.startViewTransition) return;
		if (prefersReducedMotion.current) return;
		if (nav.from?.url.pathname === nav.to?.url.pathname) return;
		return new Promise((resolve) => {
			document.startViewTransition(async () => {
				resolve();
				await nav.complete;
			});
		});
	});

	// Scope the local store to the signed-in user *before* any tracking UI opens it (the layout
	// script runs before child pages mount). Per-user database (`marquee-<id>`) — a wrong-account
	// login opens a different DB, never clearing the prior user's data. `untrack`: a deliberate
	// one-shot read of the initial user; the effect below handles any later change.
	if (typeof window !== 'undefined') {
		const initialUser = untrack(() => data.user);
		if (initialUser) {
			setActiveUser(initialUser.id);
			void initOfflineStorage(); // once per boot: request persistence + prune the image cache
		}
		// Complete a logout that was started offline — now if we're already online, else on reconnect.
		// Pass the currently-authenticated user so a stale queued logout can't sign out a newer session.
		void flushPendingLogout(untrack(() => data.user?.id ?? null));
		window.addEventListener('online', () => void flushPendingLogout(data.user?.id ?? null));
	}

	// Ask the browser to keep our IndexedDB from being evicted, and bound the media + image cache to
	// titles still on a list. Boot-time backstop for a removal made offline — the sync engine sweeps
	// again on any cycle that moves events. Best-effort; all guarded.
	async function initOfflineStorage() {
		await requestPersistentStorage();
		const keepIds = new Set(await getReferencedMediaIds());
		await pruneStaleMedia(keepIds);
		await pruneMediaImages(keepIds);
	}

	// Drive background event sync while signed in; tear down (and detach the store) on logout.
	$effect(() => {
		if (!data.user) {
			sync.stop();
			setActiveUser(null);
			library.reset(); // don't keep the prior user's dashboard in memory once signed out
			return;
		}
		setActiveUser(data.user.id);
		sync.start();
		return () => sync.stop();
	});

	// When the account changes (logout or switching users), drop the previous user's cached page
	// shells so they can't be served offline to the next session on a shared device — the service
	// worker owns the `pages-*` cache and clears it on this message. Seeded from the initial user so a
	// normal signed-in boot doesn't wipe the shell it just cached.
	let cachedForUser = untrack(() => data.user?.id ?? null);
	$effect(() => {
		const uid = data.user?.id ?? null;
		if (uid !== cachedForUser) {
			navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_PAGES' });
			library.reset(); // the previous user's titles must not carry into the new session
			tabs.reset(); // nor their per-destination filters, query and scroll offsets

			// Drop the previous user's "last synced" timestamp on the actual account change (not on
			// every sync teardown, which invalidateAll() would trigger) so it can't briefly show for
			// the next account; start() reloads the new user's value.
			sync.lastSyncAt = null;
			cachedForUser = uid;
		}
	});

	// A notification tap deep-links here: the service worker focuses this tab and posts the target
	// path (see `notificationclick` in the service worker), which we navigate to client-side.
	$effect(() => {
		if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
		const onMessage = (e: MessageEvent) => {
			if (e.data?.type === 'NOTIFICATION_NAVIGATE' && typeof e.data.url === 'string') {
				void goto(e.data.url);
			}
		};
		navigator.serviceWorker.addEventListener('message', onMessage);
		return () => navigator.serviceWorker.removeEventListener('message', onMessage);
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
	const themeColor = $derived(theme.isDark ? '#000000' : '#ffffff');

	// The tab bar is the app's primary navigation, so it rides every signed-in page — including a
	// title page, which stays inside the stack of whichever tab opened it. The two signed-out
	// surfaces have nothing to navigate between.
	const showTabBar = $derived(!!data.user && page.url.pathname !== '/login');
	// Lift bottom-anchored toasts clear of the bar. Sonner uses the mobile set below 600px, so both
	// have to be given; the variable already tracks the bar's measured height.
	const toastOffset = $derived(
		showTabBar ? { bottom: 'calc(var(--tab-bar-space) + 1.5rem)' } : undefined
	);
</script>

<svelte:head>
	<!-- The .ico carries no colour-scheme variant, so it stays the unqualified
	fallback; the PNGs below swap the mark between the light and dark teal. -->
	<link rel="icon" href="/favicon.ico" sizes="any" />
	<link
		rel="icon"
		type="image/png"
		sizes="32x32"
		media="(prefers-color-scheme: light)"
		href="/icons/favicon-32.png"
	/>
	<link
		rel="icon"
		type="image/png"
		sizes="16x16"
		media="(prefers-color-scheme: light)"
		href="/icons/favicon-16.png"
	/>
	<link
		rel="icon"
		type="image/png"
		sizes="32x32"
		media="(prefers-color-scheme: dark)"
		href="/icons/favicon-32-dark.png"
	/>
	<link
		rel="icon"
		type="image/png"
		sizes="16x16"
		media="(prefers-color-scheme: dark)"
		href="/icons/favicon-16-dark.png"
	/>
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
	<!-- iPad Air (10.9"/11", 4th/5th/M2): 820x1180 pt @2 -->
	<link
		rel="apple-touch-startup-image"
		media="screen and (device-width: 820px) and (device-height: 1180px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)"
		href="/splash/ipadair-portrait-light.png"
	/>
	<link
		rel="apple-touch-startup-image"
		media="screen and (prefers-color-scheme: dark) and (device-width: 820px) and (device-height: 1180px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)"
		href="/splash/ipadair-portrait-dark.png"
	/>
	<link
		rel="apple-touch-startup-image"
		media="screen and (device-width: 820px) and (device-height: 1180px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)"
		href="/splash/ipadair-landscape-light.png"
	/>
	<link
		rel="apple-touch-startup-image"
		media="screen and (prefers-color-scheme: dark) and (device-width: 820px) and (device-height: 1180px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)"
		href="/splash/ipadair-landscape-dark.png"
	/>
</svelte:head>
<!-- The branding header rides on the home page only; other pages carry their own title, keeping the
movie/show page's immersive layout uncluttered. Navigation itself lives in the bottom bar below. -->
{#if data.user && page.url.pathname === '/'}
	<AppHeader />
{/if}
{@render children()}
<!-- After the content, so the bar comes last in tab order — matching where it sits on screen. -->
{#if showTabBar}
	<ScrollUndoPill />
	<TabBar />
{/if}
<Toaster offset={toastOffset} mobileOffset={toastOffset} />
<InstallPrompt />
<NotificationPrompt />
<PwaUpdatePrompt />
