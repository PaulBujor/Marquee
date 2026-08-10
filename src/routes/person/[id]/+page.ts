import { error, isHttpError, redirect } from '@sveltejs/kit';
import type { PersonCreditsPage } from '$lib/server/tmdb';
import type { PageLoad } from './$types';

/**
 * Universal (not server) load, like the other offline-reachable routes: a server load can't run
 * during an offline client-side navigation, which would fail the whole navigation rather than let
 * the page render its own message. People are the one surface with no offline copy — they aren't
 * part of the local replica — so `reachable: false` is how the page says "this needs a connection"
 * instead of looking broken.
 *
 * Only the first page of credits is loaded here; the component appends the rest as you scroll.
 */
export const load: PageLoad = async ({ params, fetch, parent }) => {
	const { user } = await parent();
	if (!user) redirect(303, '/login');

	const id = Number(params.id);
	if (!Number.isInteger(id) || id <= 0) error(404, 'Not found.');

	try {
		const res = await fetch(`/api/person/${id}?page=1`);
		if (res.status === 404) error(404, 'Not found.');
		if (!res.ok) return { id, reachable: false as const, initial: null };
		return { id, reachable: true as const, initial: (await res.json()) as PersonCreditsPage };
	} catch (err) {
		// The 404 thrown above is an HttpError, not a fetch failure — it must not be swallowed here
		// and turned into "needs a connection".
		if (isHttpError(err)) throw err;
		// Network failure — offline, or the API is unreachable.
		return { id, reachable: false as const, initial: null };
	}
};
