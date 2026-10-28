/**
 * Policy for the public share surface: whether it's on at all, and the headers every public
 * response must carry. Kept apart from the preview store so the read path stays a pure data
 * concern.
 */

/** Shared-cache lifetime for a public page. It holds catalogue data only, never user data. */
export const PUBLIC_SHARE_CACHE_SECONDS = 300;

/**
 * Headers for every public share page.
 *
 * `noindex` rather than a `robots.txt` Disallow: a Disallow also blocks Twitter/Slack unfurling,
 * whereas `noindex` only keeps the page out of search results, which is what's wanted here.
 */
export const PUBLIC_SHARE_HEADERS: Record<string, string> = {
	'cache-control': `public, s-maxage=${PUBLIC_SHARE_CACHE_SECONDS}, stale-while-revalidate=86400`,
	'x-robots-tag': 'noindex, noarchive'
};

/** The response for a signed-in visitor, who is sent on to the real page: never cache that. */
export const SIGNED_IN_REDIRECT_HEADERS: Record<string, string> = {
	'cache-control': 'private, no-store'
};

/** Off switch for the whole surface, so it can be withdrawn without a rollback. */
export function publicSharingEnabled(env: { SHARE_PUBLIC_DISABLED?: string } | undefined): boolean {
	return env?.SHARE_PUBLIC_DISABLED !== '1';
}
