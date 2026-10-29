import { error, redirect } from '@sveltejs/kit';
import { readPreview, warmTitlePreview } from '$lib/server/share/preview';
import {
	PUBLIC_SHARE_HEADERS,
	SIGNED_IN_REDIRECT_HEADERS,
	publicSharingEnabled
} from '$lib/server/share/public';
import type { PageServerLoad } from './$types';

/**
 * The page a shared title link opens. Server-rendered because a link unfurler does not run
 * JavaScript — the card has to be in the initial HTML — and never cached; see PUBLIC_SHARE_HEADERS.
 *
 * It reads warmed previews only. Warming needs a session (see `/api/share/preview`), so following
 * a shared link can never cost a provider call, however many crawlers walk it.
 */
export const load: PageServerLoad = async ({ params, locals, platform, setHeaders }) => {
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
		setHeaders(SIGNED_IN_REDIRECT_HEADERS);
		redirect(303, `/title/${type}/${id}`);
	}

	setHeaders(PUBLIC_SHARE_HEADERS);
	if (!publicSharingEnabled(platform?.env)) return { state: 'disabled' as const, type, id };

	const preview = await readPreview(db, id);
	return preview
		? { state: 'ready' as const, type, id, preview }
		: { state: 'cold' as const, type, id };
};
