import { self } from '$app/service-worker';
import { version } from '$app/env';
import { assets, immutable } from '$app/manifest';
import { asset } from '$app/paths';
import { runSync } from '#lib/client/sync/sync.js';
import { setActiveUser } from '#lib/client/idb/index.js';

const CACHE = `cache-${version}`;
// Own cache so logout clears it without dropping precached build assets — one user's shells never reach the next.
const PAGES = `pages-${version}`;
// Build paths are cache-ready; static ones need `asset()` to pick up the base path.
const BUILD_PATHS = immutable.map(({ path }) => path);
const ASSETS = [...BUILD_PATHS, ...assets.map(({ path }) => asset(path))];
const BUILD = new Set(BUILD_PATHS);
const OFFLINE_URL = asset('offline.html');
/** Must match the tag the sync engine registers. */
const SYNC_TAG = 'marquee-sync';

self.addEventListener('install', (event) => {
	// No skipWaiting: the worker waits for the update prompt so hashed chunks aren't swapped under a live tab.
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

// Sent by the update prompt on accept, and by the app on logout/account switch to drop the previous user's cached shells.
self.addEventListener('message', (event) => {
	if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
	if (event.data?.type === 'CLEAR_PAGES') event.waitUntil(caches.delete(PAGES));
});

// Fires even if the app was closed; iOS has no Background Sync API, so foreground/reconnect triggers cover it.
interface SyncEvent extends ExtendableEvent {
	readonly tag: string;
}
self.addEventListener('sync', ((event: SyncEvent) => {
	if (event.tag === SYNC_TAG) event.waitUntil(flushOfflineWrites());
}) as EventListener);

interface PushPayload {
	title: string;
	body: string;
	url?: string;
	/** Collapse key — a later notification with the same tag replaces an earlier one. */
	tag?: string;
}

// Show the notification, then wake a background sync so local data is fresh on open — also covers iOS, which has no Background Sync API.
self.addEventListener('push', (event) => {
	event.waitUntil(handlePush(event));
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const url = (event.notification.data as { url?: string } | null)?.url ?? '/';
	event.waitUntil(openOrFocus(url));
});

async function handlePush(event: PushEvent): Promise<void> {
	let payload: PushPayload | undefined;
	try {
		payload = event.data?.json() as PushPayload | undefined;
	} catch {
		payload = undefined;
	}
	const title = payload?.title || 'Marquee';
	await self.registration.showNotification(title, {
		body: payload?.body ?? '',
		icon: '/icons/icon-192.png',
		badge: '/icons/favicon-48.png',
		tag: payload?.tag,
		data: { url: payload?.url ?? '/' }
	});
	// Best-effort refresh; never let a sync failure suppress the notification (already shown above).
	await flushOfflineWrites().catch(() => {});
}

async function openOrFocus(url: string): Promise<void> {
	const target = new URL(url, self.location.origin);
	const path = target.pathname + target.search;
	const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
	// `type: 'window'` guarantees WindowClients (focus()), which the Client[] return type doesn't reflect.
	const client = clients[0] as WindowClient | undefined;
	if (client) {
		client.postMessage({ type: 'NOTIFICATION_NAVIGATE', url: path });
		await client.focus();
		return;
	}
	await self.clients.openWindow(target.href);
}

// The no-tab path flushes **only** the store of the user the cookie authenticates as: syncing every local DB would write one account's events into another's.
async function flushOfflineWrites(): Promise<void> {
	const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
	if (clients.length > 0) {
		for (const client of clients) client.postMessage({ type: 'SYNC' });
		return;
	}
	// Confirm the cookie's owner before touching any store; if we can't, flush nothing and let the next foreground sync handle it.
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

// Path only, query stripped, so a page's many query variants share one entry; the shell reads the real URL client-side.
function pageCacheKey(url: URL): Request {
	return new Request(`${url.origin}${url.pathname}`);
}

// Stale-while-revalidate so the app boots instantly offline; deliberately caches authed SSR HTML — the user's own shell, versioned with the build and cleared on logout.
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
		event.waitUntil(revalidate);
		return cached;
	}
	return (await revalidate) ?? offlineResponse();
}

self.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;

	const url = new URL(request.url);

	// Public share pages belong to whoever follows the link, not to this device: a cached cold card
	// outlives the warm that filled it and hides the redirect for a signed-in reader.
	if (
		url.origin === self.location.origin &&
		(url.pathname === '/s' || url.pathname.startsWith('/s/'))
	)
		return;

	// Admin pages must never be replayed from the navigation cache — a cached copy outlives a logout. Offline shows nothing rather than a stale copy.
	if (
		url.origin === self.location.origin &&
		(url.pathname === '/admin' || url.pathname.startsWith('/admin/'))
	) {
		event.respondWith(fetch(request).catch(() => offlineResponse()));
		return;
	}

	if (url.origin === self.location.origin && BUILD.has(url.pathname)) {
		event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
		return;
	}

	if (request.mode === 'navigate') {
		event.respondWith(handleNavigate(request, event));
		return;
	}

	event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
});
