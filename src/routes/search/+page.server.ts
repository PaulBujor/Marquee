import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	// Search is a signed-in-only surface; the API endpoint enforces this too.
	if (!locals.user) redirect(303, '/login');
	return {};
};
