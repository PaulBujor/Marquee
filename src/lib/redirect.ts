// `?redirectTo=` and emailed-link targets are attacker-controlled: unvalidated, this is an open redirect.

const FALLBACK = '/';
/** A sentinel origin for parsing: never redirected to, only compared against. */
const PARSE_BASE = 'https://marquee.invalid';
const MAX_LENGTH = 512;
const LOOPING_PREFIXES = ['/login', '/auth'];

// Delegated to `URL` because only it knows every normalisation a browser applies (backslashes, tabs, `//host`, `/./`, `%2e`); origin is compared on the parsed result, not the input.
export function safeRedirectPath(value: unknown, fallback: string = FALLBACK): string {
	if (typeof value !== 'string') return fallback;

	const input = value.trim();
	if (input.length === 0 || input.length > MAX_LENGTH) return fallback;
	// Rejected rather than silently encoded: a destination carrying control characters is not one anybody meant to pass.
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

function startsWithSegment(path: string, segment: string): boolean {
	if (!path.startsWith(segment)) return false;
	return ['', '/', '?', '#'].includes(path[segment.length] ?? '');
}

export function loginPathWithRedirect(target: unknown): string {
	const path = safeRedirectPath(target, '');
	return path === '' || path === '/' ? '/login' : `/login?redirectTo=${encodeURIComponent(path)}`;
}
