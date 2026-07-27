/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />

import { build, files, version } from '$service-worker';
import { runSync } from '$lib/client/sync/sync';
import { setActiveUser } from '$lib/client/idb';

const CACHE = `cache-${version}`;
// Navigations (authed SSR HTML) live in their own cache so it can be cleared on logout without
// dropping the precached build assets — keeps one user's cached shells off the next user's account.
const PAGES = `pages-${version}`;
// The app build + everything in static/ (icons, splash, manifest, offline.html).
const ASSETS = [...build, ...files];
const BUILD = new Set(build);
const OFFLINE_URL = '/offline.html';
/** Background Sync tag: flush queued offline writes when connectivity returns (MRQ-44). */
const SYNC_TAG = 'marquee-sync';

self.addEventListener('install', (event) => {
	// No skipWaiting: the worker waits for the update prompt so hashed chunks
	// aren't swapped under a live tab.
	event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches.keys().then(async (keys) => {
			for (const key of keys) {
				if (key !== CACHE && key !== PAGES) await caches.delete(key);
			}
			await self.clients.claim();
		})
	);
});

// Posted by the update prompt when the user accepts the new version; and by the app on logout /
// account switch to drop the previous user's cached navigation shells.
self.addEventListener('message', (event) => {
	if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
	if (event.data?.type === 'CLEAR_PAGES') event.waitUntil(caches.delete(PAGES));
});

// Background Sync (Chromium/Android): fires when connectivity returns, even if the app was closed —
// so writes queued offline get flushed without waiting for the user to reopen. Registered from the
// sync engine when a sync can't complete offline. iOS has no Background Sync API; there the
// foreground/reconnect triggers (and a future daily-push piggyback) cover it.
interface SyncEvent extends ExtendableEvent {
	readonly tag: string;
}
self.addEventListener('sync', ((event: SyncEvent) => {
	if (event.tag === SYNC_TAG) event.waitUntil(flushOfflineWrites());
}) as EventListener);

/**
 * Drain queued offline events. Prefer an open tab (it holds the active user + reactive state, so its
 * views update); when the app is fully closed, push the outbox directly via the same `runSync` round
 * trip — the server dedupes by event id, so a later foreground sync is safe.
 *
 * Crucially, the no-tab path flushes **only the store of the user the session cookie authenticates
 * as** (asked of the server), never every local store. On a shared device, blindly syncing each
 * `marquee-<id>` DB under the ambient cookie would write one account's queued events into another's
 * account (the server attributes them to the cookie's user) — silent cross-account corruption.
 */
async function flushOfflineWrites(): Promise<void> {
	const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
	if (clients.length > 0) {
		for (const client of clients) client.postMessage({ type: 'SYNC' });
		return;
	}
	// No open tab: confirm who the cookie belongs to before touching any store. If we can't (offline
	// or signed out), flush nothing and let the next foreground sync handle it.
	let userId: string | null = null;
	try {
		const res = await fetch('/api/whoami');
		if (res.ok) userId = ((await res.json()) as { userId: string }).userId;
	} catch {
		return;
	}
	if (!userId) return;
	setActiveUser(userId);
	try {
		await runSync();
	} catch (err) {
		// Best-effort: a failure just leaves events queued for the next trigger.
		console.warn('[sw] background sync flush failed', err);
	}
}

// Cloudflare redirects /offline.html → /offline, so the precached response is
// flagged `redirected` — WebKit refuses those for navigations. Rebuild a clean copy.
async function offlineResponse(): Promise<Response> {
	const cached = await caches.match(OFFLINE_URL);
	if (!cached) return Response.error();
	return new Response(await cached.text(), {
		status: 200,
		headers: { 'Content-Type': 'text/html; charset=utf-8' }
	});
}

// Navigations cache under their **path only** (query stripped) so a page's many query variants
// (`?from=…`, `?q=…`, `?season=…`) share one entry and the cache stays bounded. The shell boots and
// reads the real URL client-side, so dropping the query for the cache key is safe.
function pageCacheKey(url: URL): Request {
	return new Request(`${url.origin}${url.pathname}`);
}

/**
 * Cache-first (stale-while-revalidate) for navigations, so the app **boots instantly** — offline or
 * on a slow network — instead of waiting on a server round-trip every launch. Serve the last cached
 * shell immediately, then revalidate in the background. The shell renders from IndexedDB (dashboard,
 * timeline, and — via the title page's IDB fallback — tracked titles) and re-syncs, so a stale
 * cached copy self-heals; only the *first* visit to a path (nothing cached yet) waits on the
 * network. This deliberately caches authed SSR HTML: it's the user's own shell on their own device,
 * versioned with the build (wiped on update) and cleared on logout (CLEAR_PAGES).
 */
async function handleNavigate(request: Request, event: FetchEvent): Promise<Response> {
	const key = pageCacheKey(new URL(request.url));
	const cache = await caches.open(PAGES);
	const cached = await cache.match(key);

	const revalidate = fetch(request)
		.then(async (response) => {
			// Only cache real, same-origin 200s. Skip redirects (`redirected`): an auth-gated load that
			// 303s to /login resolves to a 200 basic response, and caching that under the requested path
			// would serve the login page in place of the real shell.
			if (response.ok && response.type === 'basic' && !response.redirected) {
				await cache.put(key, response.clone());
			}
			return response;
		})
		.catch(() => null);

	if (cached) {
		event.waitUntil(revalidate); // refresh the cache for next time without blocking this response
		return cached;
	}
	// First visit to this path — nothing cached yet; wait on the network, else the offline page.
	return (await revalidate) ?? offlineResponse();
}

self.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;

	const url = new URL(request.url);

	// Versioned build assets: cache-first.
	if (url.origin === self.location.origin && BUILD.has(url.pathname)) {
		event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
		return;
	}

	// Navigations: cache-first (stale-while-revalidate) so the app boots instantly, then the
	// offline page on a first-visit miss (see handleNavigate).
	if (request.mode === 'navigate') {
		event.respondWith(handleNavigate(request, event));
		return;
	}

	// Everything else: cache-first.
	event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
});
