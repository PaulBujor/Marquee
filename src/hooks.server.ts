import type { Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { createDb } from '$lib/server/db';

// Attach a per-request Drizzle client. Only available when running with the platform
// bindings (dev proxy / deployed Worker) — absent during prerender/build, hence the guard.
const database: Handle = async ({ event, resolve }) => {
	if (event.platform) {
		event.locals.db = createDb(event.platform.env.DB);
	}
	return resolve(event);
};

// Baseline security headers on every response. CSP is configured separately via kit.csp
// in svelte.config.js (it needs SvelteKit's nonce/hash augmentation for inline scripts).
const securityHeaders: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
	return response;
};

export const handle: Handle = sequence(database, securityHeaders);
