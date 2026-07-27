import { browser } from '$app/environment';
import { setActiveUser } from '$lib/client/idb';
import type { LayoutLoad } from './$types';

/**
 * Scope the offline IndexedDB store to the signed-in user **before any child `load` runs**. Child
 * loads (e.g. the title page's offline-first `buildOfflineDetail`) read the store during the load
 * phase — which happens *before* components mount — so scoping it in the layout component would be
 * too late on a fresh hydration, and `openDb` would throw "no active user" and 500 the page. A child
 * `await parent()` waits for this load, guaranteeing the store is scoped first. Server-side this is a
 * no-op (the store is browser-only); the component still owns the reactive logout/teardown.
 */
export const load: LayoutLoad = async ({ data }) => {
	if (browser) setActiveUser(data.user?.id ?? null);
	return data;
};
