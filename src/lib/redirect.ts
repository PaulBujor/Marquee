/**
 * Where to send someone after they sign in. The value arrives from the client — a `?redirectTo=`
 * on `/login`, or the target we threaded into an emailed link — so it is attacker-controlled:
 * unvalidated it turns sign-in into an open redirect.
 */

const FALLBACK = '/';
/** A sentinel origin for parsing: never redirected to, only compared against. */
const PARSE_BASE = 'https://marquee.invalid';
const MAX_LENGTH = 512;
/** Destinations that would bounce straight back into the sign-in flow. */
const LOOPING_PREFIXES = ['/login', '/auth'];

/**
 * The path to redirect to, or `fallback` when the input is not a same-origin path for this origin.
 * Parsing is delegated to `URL`, the one component that knows every normalisation a browser applies —
 * backslashes, tabs, `//host`, `/./`, `%2e` — so the origin is compared on the parsed result rather
 * than on the string we were handed. What stays here is what a parser cannot know: a length cap, and
 * this app's rule about not bouncing back into the sign-in flow.
 */
export function safeRedirectPath(value: unknown, fallback: string = FALLBACK): string {
	if (typeof value !== 'string') return fallback;

	const input = value.trim();
	if (input.length === 0 || input.length > MAX_LENGTH) return fallback;
	// Rejected rather than silently encoded: a destination carrying control characters is not one
	// anybody meant to pass.
	if (hasControlCharacter(input)) return fallback;

	let url: URL;
	try {
		url = new URL(input, PARSE_BASE);
	} catch {
		return fallback;
	}
	if (url.origin !== PARSE_BASE) return fallback;

	const path = `${url.pathname}${url.search}${url.hash}`;
	// Whatever the input was, a path starting `//` is another origin once it reaches `Location`.
	if (path.startsWith('//')) return fallback;
	if (LOOPING_PREFIXES.some((prefix) => startsWithSegment(path, prefix))) return fallback;

	return path;
}

/** Any C0/C1 control character, which a parser may strip or encode away rather than reject. */
function hasControlCharacter(value: string): boolean {
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return true;
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
