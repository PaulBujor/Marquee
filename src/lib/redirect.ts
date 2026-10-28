/**
 * Where to send someone after they sign in. The value arrives from the client — a `?redirectTo=`
 * on `/login`, or the target we threaded into an emailed link — so it is attacker-controlled:
 * unvalidated it turns sign-in into an open redirect.
 */

const FALLBACK = '/';
const MAX_LENGTH = 512;
/** Destinations that would bounce straight back into the sign-in flow. */
const LOOPING_PREFIXES = ['/login', '/auth'];

/**
 * The path to redirect to, or `fallback` when the input isn't a same-origin path. Only ever
 * returns a value starting with a single `/`: `//host` and `/\host` are protocol-relative URLs,
 * i.e. another origin.
 */
export function safeRedirectPath(value: unknown, fallback: string = FALLBACK): string {
	if (typeof value !== 'string') return fallback;

	const path = value.trim();
	if (path.length === 0 || path.length > MAX_LENGTH) return fallback;
	if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return fallback;
	// Control characters and backslashes: a browser may normalise `\/` and `	` away.
	if (hasControlCharacter(path)) return fallback;
	if (LOOPING_PREFIXES.some((prefix) => startsWithSegment(path, prefix))) return fallback;

	return path;
}

/** Any C0/C1 control character, or a backslash — all of which a URL parser may normalise away. */
function hasControlCharacter(value: string): boolean {
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f || char === '\\') return true;
	}
	return false;
}

/** Whether `path` *is* that segment or a child/query/hash of it. */
function startsWithSegment(path: string, segment: string): boolean {
	if (!path.startsWith(segment)) return false;
	return ['', '/', '?', '#'].includes(path[segment.length] ?? '');
}

/**
 * A `/login` path carrying the destination, so a shared link survives the sign-in detour. Plain
 * `/login` when there's nothing worth preserving.
 */
export function loginPathWithRedirect(target: unknown): string {
	const path = safeRedirectPath(target, '');
	return path === '' || path === '/' ? '/login' : `/login?redirectTo=${encodeURIComponent(path)}`;
}
