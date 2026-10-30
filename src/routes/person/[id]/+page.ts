import { error, isHttpError, redirect } from '@sveltejs/kit';
import type { PersonCreditsPage } from '#lib/server/tmdb/index.js';
import type { PageLoad } from './$types';

/** Universal so an offline navigation still renders: a server load can't run offline and would fail the whole navigation. */
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
		// The 404 above is an HttpError, not a fetch failure — it must not become "needs a connection".
		if (isHttpError(err)) throw err;
		return { id, reachable: false as const, initial: null };
	}
};
