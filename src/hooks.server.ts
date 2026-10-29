import type { Handle, HandleServerError } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { createDb } from '$lib/server/db';
import { validateSession, deleteSessionCookie, SESSION_COOKIE } from '$lib/server/auth';
import { noteRateLimited, withinRateLimit } from '$lib/server/http/rate-limit';

// Attach a per-request Drizzle client. Only available when running with the platform
// bindings (dev proxy / deployed Worker) — absent during prerender/build, hence the guard.
const database: Handle = async ({ event, resolve }) => {
	if (event.platform) {
		event.locals.db = createDb(event.platform.env.DB);
	}
	return resolve(event);
};

// Resolve the session cookie to the current user. Runs after `database` so
// `locals.db` is available; a missing/expired cookie clears itself and leaves
// `locals.user` null. Load functions/actions read `locals.user` for auth.
const authentication: Handle = async ({ event, resolve }) => {
	event.locals.user = null;
	const token = event.cookies.get(SESSION_COOKIE);
	if (token && event.locals.db) {
		const result = await validateSession(event.locals.db, token);
		if (result) {
			event.locals.user = result.user;
		} else {
			deleteSessionCookie(event.cookies);
		}
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

// Cloudflare's limiter, first in the chain so a flood is shed before it reaches D1 or the auth
// lookup. Keyed per session when the caller has one, else per IP — see `rateLimitKey`. Loose on
// purpose (wrangler.jsonc); the public share pages carry their own budget.
const rateLimit: Handle = async ({ event, resolve }) => {
	if (!(await withinRateLimit(event.platform, 'APP_RATE_LIMITER', event.request))) {
		noteRateLimited('app', event.url.pathname);
		return new Response('Too many requests', {
			status: 429,
			headers: { 'content-type': 'text/plain', 'retry-after': '60' }
		});
	}
	return resolve(event);
};

export const handle: Handle = sequence(rateLimit, database, authentication, securityHeaders);

// Central capture for **unexpected** server errors (uncaught throws in load/actions/endpoints —
// e.g. a failed `/api/sync` projection or a D1 error; `error(status)` throws are "expected" and
// skip this). Logged structured so Cloudflare observability (logs/traces, see wrangler.jsonc)
// picks them up; a correlation `id` goes to the log only, never leaking internals to the client.
export const handleError: HandleServerError = ({ error, event }) => {
	const id = crypto.randomUUID();
	console.error(`[server-error ${id}] ${event.request.method} ${event.url.pathname}`, error);
	return { message: 'Something went wrong on our end.' };
};
