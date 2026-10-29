import { sequence, type Handle, type HandleServerError } from '@sveltejs/kit/hooks';
import { createDb } from '#lib/server/db/index.js';
import { validateSession, deleteSessionCookie, SESSION_COOKIE } from '#lib/server/auth/index.js';
import {
	actorRateLimitKey,
	noteRateLimited,
	rateLimitKey,
	withinRateLimit
} from '#lib/server/http/rate-limit.js';

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

// Cloudflare's limiter, first in the chain so a flood is shed before it reaches D1 or the auth lookup.
// Keyed by client IP, which is all we know before authenticating — see `rateLimitKey`. Loose on purpose
// (wrangler.jsonc); the public share pages carry their own budget.
const rateLimit: Handle = async ({ event, resolve }) => {
	if (
		!(await withinRateLimit(event.platform, 'APP_RATE_LIMITER', await rateLimitKey(event.request)))
	) {
		noteRateLimited('app', event.url.pathname);
		return new Response('Too many requests', {
			status: 429,
			headers: { 'content-type': 'text/plain', 'retry-after': '60' }
		});
	}
	return resolve(event);
};

// The same budget again, keyed by the account, once `authentication` has verified the session:
// neighbours behind one NAT shouldn't spend each other's allowance, and only here is the key one the
// caller cannot choose for themselves.
const actorRateLimit: Handle = async ({ event, resolve }) => {
	const key = actorRateLimitKey(event.locals.user?.id);
	if (!key) return resolve(event);

	if (!(await withinRateLimit(event.platform, 'APP_RATE_LIMITER', key))) {
		noteRateLimited('app', event.url.pathname);
		return new Response('Too many requests', {
			status: 429,
			headers: { 'content-type': 'text/plain', 'retry-after': '60' }
		});
	}
	return resolve(event);
};

export const handle: Handle = sequence(
	rateLimit,
	database,
	authentication,
	actorRateLimit,
	securityHeaders
);

// Central capture for **unexpected** server errors (uncaught throws in load/actions/endpoints —
// e.g. a failed `/api/sync` projection or a D1 error; `error(status)` throws are "expected" and
// skip this). Logged structured so Cloudflare observability (logs/traces, see wrangler.jsonc)
// picks them up; a correlation `id` goes to the log only, never leaking internals to the client.
export const handleError: HandleServerError = ({ kind, error, event }) => {
	// SvelteKit 3 tags every error it catches, including the ones this app raises on purpose with
	// `error(...)`, and merges whatever this hook returns over its own status and message. So the
	// expected kinds return nothing — their status and message survive — and only an unknown error
	// (a genuine server fault) gets an id and the generic message.
	if (kind !== 'unknown') return;

	const id = crypto.randomUUID();
	console.error(`[server-error ${id}] ${event.request.method} ${event.url.pathname}`, error);
	return { message: 'Something went wrong on our end.' };
};
