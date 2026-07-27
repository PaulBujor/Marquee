/**
 * Offline-aware sign-out. A real logout needs the server — it invalidates the DB session and clears
 * the **httpOnly** session cookie (which JS can't touch) — so it can't complete offline. When offline
 * the logout form POST just fails to an error page and the user stays signed in.
 *
 * Instead, offline we tear down the local signed-in state immediately and land on `/login`, and record
 * a pending logout that's flushed to the server the next time we're online, so the account genuinely
 * signs out. Online logout keeps using the plain form action.
 */
import { goto, invalidateAll } from '$app/navigation';
import { resolve } from '$app/paths';
import { setActiveUser } from '$lib/client/idb';
import { library } from '$lib/tracking/library.svelte';
import { sync } from '$lib/client/sync/engine.svelte';

const PENDING_LOGOUT = 'marquee:pending-logout';

/** Tear down the signed-in local state (mirrors the layout's logout branch). */
function teardownLocal(): void {
	sync.stop();
	setActiveUser(null);
	library.reset();
	// Drop the cached authed shells so a back/reload can't show the previous session offline.
	navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_PAGES' });
}

/** Begin an offline sign-out: mark a pending logout, tear down local state, then land on `/login`. */
export async function signOutOffline(): Promise<void> {
	try {
		localStorage.setItem(PENDING_LOGOUT, '1');
	} catch {
		// Storage disabled (private mode) — the pending logout won't survive a reload, but the local
		// teardown + navigation below still sign the user out for this session.
	}
	teardownLocal();
	await goto(resolve('/login'));
}

/**
 * Complete a deferred offline logout once we're back online: invoke the root `?/logout` form action
 * so the session is invalidated server-side and its Set-Cookie clears the (httpOnly) cookie in the
 * browser. No-op when nothing is pending or we're still offline; the flag is kept on failure so the
 * next online tick retries.
 */
export async function flushPendingLogout(): Promise<void> {
	if (typeof localStorage === 'undefined') return;
	if (localStorage.getItem(PENDING_LOGOUT) !== '1') return;
	if (typeof navigator !== 'undefined' && !navigator.onLine) return;
	try {
		const res = await fetch('/?/logout', {
			method: 'POST',
			headers: { 'x-sveltekit-action': 'true' },
			body: new FormData()
		});
		if (!res.ok) return; // reachable but the action didn't run — keep the flag, retry later
		localStorage.removeItem(PENDING_LOGOUT);
		await invalidateAll(); // reflect the now-cleared session (data.user → null)
	} catch {
		// Still unreachable — keep the pending flag for the next attempt.
	}
}
