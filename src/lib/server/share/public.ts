/**
 * Policy for the public share surface: whether it's on at all, and the headers every public
 * response must carry. Kept apart from the preview store so the read path stays a pure data
 * concern.
 */

/**
 * Headers for every public share page.
 *
 * Deliberately uncached, because a cache key ignores the session cookie: a stored anonymous copy
 * was served to signed-in readers (no redirect, no warm on view) and a cold card outlived the warm
 * that filled it. The service worker skips these paths for the same reason; caching can return once
 * a warm can purge its own URL.
 *
 * `noindex` rather than a `robots.txt` Disallow: a Disallow also blocks Twitter/Slack unfurling,
 * whereas `noindex` only keeps the page out of search results, which is what's wanted here.
 */
export const PUBLIC_SHARE_HEADERS: Record<string, string> = {
	'cache-control': 'no-store',
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
