import { env, waitUntil } from '#lib/server/bindings.js';
import { error, redirect } from '@sveltejs/kit';
import { readPreview, warmTitlePreview } from '#lib/server/share/preview.js';
import { noteRateLimited, rateLimitKey, withinRateLimit } from '#lib/server/http/rate-limit.js';
import { PUBLIC_SHARE_HEADERS, publicSharingEnabled } from '#lib/server/share/public.js';
import type { PageServerLoad } from './$types';

/** Server-rendered because an unfurler runs no JavaScript; warmed previews only, so a crawler costs no provider call. */
export const load: PageServerLoad = async ({ params, locals, request, setHeaders }) => {
	// SvelteKit throws if one header is set twice, so the policy is decided once, up front, for every outcome.
	setHeaders(PUBLIC_SHARE_HEADERS);

	// Before any read: this is the unauthenticated route that serves shared content.
	if (!(await withinRateLimit(env, 'PUBLIC_SHARE_LIMITER', await rateLimitKey(request)))) {
		noteRateLimited('share', new URL(request.url).pathname);
		error(429, 'Too many requests.');
	}

	const type = params.type === 'movie' || params.type === 'show' ? params.type : null;
	const id = Number(params.id);
	if (!type || !Number.isInteger(id) || id <= 0) error(404, 'Not found.');
	if (!locals.db) error(503, 'Service unavailable');
	const db = locals.db;

	// The kill switch covers the writes too: nothing is warmed for a page nobody can open.
	if (!publicSharingEnabled(env)) {
		if (locals.user) redirect(303, `/title/${type}/${id}`);
		return { state: 'disabled' as const, type, id };
	}

	if (locals.user) {
		// Warm on the way past, detached: the redirect must not wait on a provider call.
		const apiKey = env.TMDB_API_KEY;
		if (apiKey) {
			waitUntil(
				warmTitlePreview(db, apiKey, { userId: locals.user.id, type, id }).catch((err: unknown) => {
					// The cause carries D1's own message; the wrapper's stack alone doesn't name the failing column.
					const wrapped = err as { message?: string; cause?: unknown };
					console.error(
						'share page: warm on view failed',
						wrapped?.message,
						String(wrapped?.cause ?? '')
					);
				})
			);
		}
		redirect(303, `/title/${type}/${id}`);
	}

	const preview = await readPreview(db, type, id);
	return preview
		? { state: 'ready' as const, type, id, preview }
		: { state: 'cold' as const, type, id };
};
