import { browser } from '$app/env';
import { setActiveUser } from '#lib/client/idb/index.js';
import type { LayoutLoad } from './$types';

/** Must run in the load phase, before any child `load`: a child reading the store earlier hits `openDb`'s "no active user" throw. */
export const load: LayoutLoad = async ({ data }) => {
	if (browser) setActiveUser(data.user?.id ?? null);
	return data;
};
