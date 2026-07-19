/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />

import { build, files, version } from '$service-worker';

const CACHE = `cache-${version}`;
// The app build + everything in static/ (icons, splash, manifest, offline.html).
const ASSETS = [...build, ...files];
const BUILD = new Set(build);
const OFFLINE_URL = '/offline.html';

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

self.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;

	const url = new URL(request.url);

	// Versioned build assets: cache-first.
	if (url.origin === self.location.origin && BUILD.has(url.pathname)) {
		event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
		return;
	}

	// Navigations: network-first (authed HTML is never cached), then any cached
	// copy, then the offline page.
	if (request.mode === 'navigate') {
		event.respondWith(
			fetch(request).catch(
				async () =>
					(await caches.match(request)) ?? (await caches.match(OFFLINE_URL)) ?? Response.error()
			)
		);
		return;
	}

	// Everything else: cache-first.
	event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
});
