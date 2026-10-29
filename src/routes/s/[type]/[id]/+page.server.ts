import { error, redirect } from '@sveltejs/kit';
import { readPreview, warmTitlePreview } from '$lib/server/share/preview';
import { noteRateLimited, withinRateLimit } from '$lib/server/http/rate-limit';
import { PUBLIC_SHARE_HEADERS, publicSharingEnabled } from '$lib/server/share/public';
import type { PageServerLoad } from './$types';

/**
 * The page a shared title link opens: server-rendered (an unfurler runs no JavaScript) and uncached
 * (see PUBLIC_SHARE_HEADERS). It reads warmed previews only, so a crawler costs no provider call.
 */
export const load: PageServerLoad = async ({ params, locals, platform, request, setHeaders }) => {
	// Exactly one call per response: SvelteKit throws if the same header is set twice (see its
	// `respond.js`), so the policy has to be decided once, up front, for every outcome — including the
	// refusals below. `no-store` is stricter than `private, no-store`, so one policy covers both the
	// anonymous page and the redirect a signed-in reader gets.
	setHeaders(PUBLIC_SHARE_HEADERS);

	// Before any read: this is the unauthenticated route that serves shared content.
	if (!(await withinRateLimit(platform, 'PUBLIC_SHARE_LIMITER', request))) {
		noteRateLimited('share', new URL(request.url).pathname);
		error(429, 'Too many requests.');
	}

	const type = params.type === 'movie' || params.type === 'show' ? params.type : null;
	const id = Number(params.id);
	if (!type || !Number.isInteger(id) || id <= 0) error(404, 'Not found.');
	if (!locals.db) error(503, 'Service unavailable');
	const db = locals.db;

	if (locals.user) {
		// The sharer (or any signed-in reader) opening the link: warm it on the way past, so the
		// card is there for everyone else. Detached — the redirect must not wait on a provider call.
		const apiKey = platform?.env.TMDB_API_KEY;
		if (platform && apiKey) {
			platform.ctx.waitUntil(
				warmTitlePreview(db, apiKey, { userId: locals.user.id, type, id }).catch((err: unknown) => {
					// The cause carries D1's own message; the wrapper's stack alone does not name the
					// column or constraint that failed.
					const wrapped = err as { message?: string; cause?: unknown };
					console.error('share page: warm on view failed', wrapped?.message, wrapped?.cause);
				})
			);
		}
		redirect(303, `/title/${type}/${id}`);
	}

	if (!publicSharingEnabled(platform?.env)) return { state: 'disabled' as const, type, id };

	const preview = await readPreview(db, type, id);
	return preview
		? { state: 'ready' as const, type, id, preview }
		: { state: 'cold' as const, type, id };
};
