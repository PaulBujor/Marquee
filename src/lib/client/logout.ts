/**
 * Offline-aware sign-out. A real logout needs the server — it invalidates the DB session and clears
 * the **httpOnly** session cookie (which JS can't touch) — so it can't complete offline. When offline
 * the logout form POST just fails to an error page and the user stays signed in.
 *
 * Instead, offline we tear down the local signed-in state immediately and land on `/login`, and record
 * a pending logout (scoped to the user id) that's flushed to the server the next time we're online, so
 * the account genuinely signs out. Online logout keeps using the plain form action.
 */
import { goto, invalidateAll } from '$app/navigation';
import { resolve } from '$app/paths';
import { setActiveUser } from '$lib/client/idb';
import { library } from '$lib/tracking/library.svelte';
import { sync } from '$lib/client/sync/engine.svelte';

// Holds the id of the user whose logout is queued (not just a boolean) so a deferred flush can tell
// "still the same session — finish signing it out" from "that session is already gone / a different
// account is signed in now — drop the stale marker" and never sign out a newer session.
const PENDING_LOGOUT = 'marquee:pending-logout';

function readPending(): string | null {
	try {
		return localStorage.getItem(PENDING_LOGOUT);
	} catch {
		return null;
	}
}

/** Drop the queued-logout marker (called once it's completed, stale, or superseded by a new login). */
export function clearPendingLogout(): void {
	try {
		localStorage.removeItem(PENDING_LOGOUT);
	} catch {
		// Storage disabled — nothing to clear.
	}
}

/** Tear down the signed-in local state (mirrors the layout's logout branch). */
function teardownLocal(): void {
	sync.stop();
	setActiveUser(null);
	library.reset();
	// Drop the cached authed shells so a back/reload can't show the previous session offline.
	navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_PAGES' });
}

/** Begin an offline sign-out: mark a pending logout for `userId`, tear down local state, land on `/login`. */
export async function signOutOffline(userId: string): Promise<void> {
	try {
		localStorage.setItem(PENDING_LOGOUT, userId);
	} catch {
		// Storage disabled (private mode) — the pending logout won't survive a reload, but the local
		// teardown + navigation below still sign the user out for this session.
	}
	teardownLocal();
	await goto(resolve('/login'));
}

/**
 * Complete a deferred offline logout once we're back online. `currentUserId` is the account the app is
 * currently authenticated as (`data.user?.id`, or null when the session is already gone). Only when it
 * still matches the queued user do we hit the server logout — so an **already-expired/cleared session**
 * (currentUserId === null) or a **different account signed in since** just drops the stale marker
 * instead of firing a pointless request or, worse, signing out a newer session. On a match, invoking
 * the root `?/logout` action invalidates the session server-side and its Set-Cookie clears the
 * (httpOnly) cookie. The flag is kept on network failure so the next online tick retries.
 */
export async function flushPendingLogout(currentUserId: string | null): Promise<void> {
	if (typeof localStorage === 'undefined') return;
	const queuedFor = readPending();
	if (!queuedFor) return;
	if (currentUserId === null || currentUserId !== queuedFor) {
		clearPendingLogout(); // session already ended, or a different account is active — nothing to do
		return;
	}
	if (typeof navigator !== 'undefined' && !navigator.onLine) return;
	try {
		const res = await fetch('/?/logout', {
			method: 'POST',
			headers: { 'x-sveltekit-action': 'true' },
			body: new FormData()
		});
		if (!res.ok) return; // reachable but the action didn't run — keep the flag, retry later
		clearPendingLogout();
		await invalidateAll(); // reflect the now-cleared session (data.user → null)
	} catch {
		// Still unreachable — keep the pending flag for the next attempt.
	}
}
