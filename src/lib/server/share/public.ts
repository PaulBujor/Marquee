/**
 * Policy for the public share surface: whether it's on at all, and the headers every public
 * response must carry. Kept apart from the preview store so the read path stays a pure data
 * concern.
 */

/**
 * Headers for every public share page. Deliberately uncached: a cache key ignores the session
 * cookie, so a stored copy served signed-in readers the anonymous page. `noindex` rather than a
 * `robots.txt` Disallow, which would also block chat unfurling.
 */
export const PUBLIC_SHARE_HEADERS: Record<string, string> = {
	'cache-control': 'no-store',
	'x-robots-tag': 'noindex, noarchive'
};

/**
 * Off switch for the whole surface, so it can be withdrawn without a rollback. `1`, `true`, `yes` and
 * `on` all disable it, in any case: an emergency control that accepts one spelling fails silently while
 * someone types another.
 */
export function publicSharingEnabled(env: { SHARE_PUBLIC_DISABLED?: string } | undefined): boolean {
	const value = env?.SHARE_PUBLIC_DISABLED?.trim().toLowerCase();
	return !(value === '1' || value === 'true' || value === 'yes' || value === 'on');
}
