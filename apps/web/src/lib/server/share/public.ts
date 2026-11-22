// Deliberately uncached (a cache key ignores the session cookie) and `noindex`, not a robots Disallow — that blocks chat unfurling.
export const PUBLIC_SHARE_HEADERS: Record<string, string> = {
	'cache-control': 'no-store',
	'x-robots-tag': 'noindex, noarchive'
};

// Off switch for the whole surface. Several spellings, because a control that fails silently on a variant fails mid-incident.
export function publicSharingEnabled(env: { SHARE_PUBLIC_DISABLED?: string } | undefined): boolean {
	const value = env?.SHARE_PUBLIC_DISABLED?.trim().toLowerCase();
	return !(value === '1' || value === 'true' || value === 'yes' || value === 'on');
}
