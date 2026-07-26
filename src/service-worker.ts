/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />

import { build, files, version } from '$service-worker';
import { runSync } from '$lib/client/sync/sync';
import { setActiveUser } from '$lib/client/idb';

const CACHE = `cache-${version}`;
// The app build + everything in static/ (icons, splash, manifest, offline.html).
const ASSETS = [...build, ...files];
const BUILD = new Set(build);
const OFFLINE_URL = '/offline.html';
/** Background Sync tag: flush queued offline writes when connectivity returns (MRQ-44). */
const SYNC_TAG = 'marquee-sync';
/** Per-user IndexedDB name prefix (mirrors `setActiveUser`), used to find stores to flush. */
const DB_PREFIX = 'marquee-';

self.addEventListener('install', (event) => {
	// No skipWaiting: the worker waits for the update prompt so hashed chunks
	// aren't swapped under a live tab.
	event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches.keys().then(async (keys) => {
			for (const key of keys) {
				if (key !== CACHE) await caches.delete(key);
			}
			await self.clients.claim();
		})
	);
});

// Posted by the update prompt when the user accepts the new version.
self.addEventListener('message', (event) => {
	if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
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
 * views update); when the app is fully closed, push each per-user store's outbox directly via the
 * same `runSync` round trip — the server dedupes by event id, so a later foreground sync is safe.
 */
async function flushOfflineWrites(): Promise<void> {
	const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
	if (clients.length > 0) {
		for (const client of clients) client.postMessage({ type: 'SYNC' });
		return;
	}
	// No open tab. `databases()` is Chromium-only — same platforms as Background Sync — so this is safe.
	if (!('databases' in indexedDB)) return;
	for (const { name } of await indexedDB.databases()) {
		if (!name?.startsWith(DB_PREFIX)) continue;
		setActiveUser(name.slice(DB_PREFIX.length));
		try {
			await runSync();
		} catch (err) {
			// Best-effort: a failure just leaves events queued for the next trigger.
			console.warn('[sw] background sync flush failed', err);
		}
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
 * Network-first for navigations, but keep the last good copy so the app **boots offline**. The
 * shell then renders from IndexedDB (dashboard, timeline, and — via the title page's IDB fallback —
 * tracked titles). This deliberately caches authed SSR HTML: it's the user's own shell on their own
 * device (their data already lives in IndexedDB), the copy is versioned with the build (wiped on
 * update), and the client re-renders + re-syncs on reconnect, so a stale embedded value self-heals.
 */
async function handleNavigate(request: Request): Promise<Response> {
	const key = pageCacheKey(new URL(request.url));
	try {
		const response = await fetch(request);
		// Only cache real, same-origin 200s (not login redirects / errors).
		if (response.ok && response.type === 'basic') {
			const cache = await caches.open(CACHE);
			await cache.put(key, response.clone());
		}
		return response;
	} catch {
		return (await caches.match(key)) ?? offlineResponse();
	}
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

	// Navigations: network-first, caching the last good copy so the app boots offline
	// (see handleNavigate), then any cached copy, then the offline page.
	if (request.mode === 'navigate') {
		event.respondWith(handleNavigate(request));
		return;
	}

	// Everything else: cache-first.
	event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
});
