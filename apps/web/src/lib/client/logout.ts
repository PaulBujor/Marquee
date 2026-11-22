/** A real logout needs the server (httpOnly cookie), so offline we queue it and tear down locally. */
import { goto, refreshAll } from '$app/navigation';
import { resolve } from '$app/paths';
import { setActiveUser } from '#lib/client/idb/index.js';
import { library } from '#lib/tracking/library.svelte.js';
import { sync } from '#lib/client/sync/engine.svelte.js';

// Holds the user id (not a boolean) so a deferred flush never signs out a newer session.
const PENDING_LOGOUT = 'marquee:pending-logout';

function readPending(): string | null {
	try {
		return localStorage.getItem(PENDING_LOGOUT);
	} catch {
		return null;
	}
}

export function clearPendingLogout(): void {
	try {
		localStorage.removeItem(PENDING_LOGOUT);
	} catch {
		// Storage disabled — nothing to clear.
	}
}

function teardownLocal(): void {
	sync.stop();
	setActiveUser(null);
	library.reset();
	// Drop the cached authed shells so a back/reload can't show the previous session offline.
	navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_PAGES' });
}

export async function signOutOffline(userId: string): Promise<void> {
	try {
		localStorage.setItem(PENDING_LOGOUT, userId);
	} catch {
		// Storage disabled (private mode) — the marker won't survive a reload, but the teardown and
		// navigation below still sign the user out for this session.
	}
	teardownLocal();
	await goto(resolve('login'));
}

/** Only a matching user id hits the server; an expired session or a newer account drops the marker. */
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
		await refreshAll(); // reflect the now-cleared session (data.user → null)
	} catch {
		// Still unreachable — keep the pending flag for the next attempt.
	}
}
