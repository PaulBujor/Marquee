import { describe, expect, it } from 'vitest';
import { loginPathWithRedirect, safeRedirectPath } from './redirect';

describe('safeRedirectPath', () => {
	it('keeps a same-origin path, with its query and hash', () => {
		expect(safeRedirectPath('/title/movie/603')).toBe('/title/movie/603');
		expect(safeRedirectPath('/title/show/1399?season=2')).toBe('/title/show/1399?season=2');
		expect(safeRedirectPath('/person/287#credits')).toBe('/person/287#credits');
		expect(safeRedirectPath('  /settings  ')).toBe('/settings');
	});

	it('falls back on another origin', () => {
		expect(safeRedirectPath('https://evil.example/steal')).toBe('/');
		expect(safeRedirectPath('http://evil.example')).toBe('/');
		// Protocol-relative and backslash variants are the same thing to a browser.
		expect(safeRedirectPath('//evil.example')).toBe('/');
		expect(safeRedirectPath('/\\evil.example')).toBe('/');
		expect(safeRedirectPath('\\\\evil.example')).toBe('/');
	});

	it('falls back on anything that would bounce back into the sign-in flow', () => {
		expect(safeRedirectPath('/login')).toBe('/');
		expect(safeRedirectPath('/login?redirectTo=%2Fsettings')).toBe('/');
		expect(safeRedirectPath('/login/')).toBe('/');
		expect(safeRedirectPath('/auth/verify?token=abc')).toBe('/');
		// A path that merely starts with the same letters is fine.
		expect(safeRedirectPath('/login-history')).toBe('/login-history');
	});

	it('falls back on missing, non-string and over-long input', () => {
		expect(safeRedirectPath(null)).toBe('/');
		expect(safeRedirectPath(undefined)).toBe('/');
		expect(safeRedirectPath('')).toBe('/');
		expect(safeRedirectPath('   ')).toBe('/');
		expect(safeRedirectPath(['/settings'])).toBe('/');
		expect(safeRedirectPath(`/${'a'.repeat(600)}`)).toBe('/');
	});

	it('falls back on a path carrying control characters', () => {
		expect(safeRedirectPath('/set\u0000tings')).toBe('/');
		expect(safeRedirectPath('/set\ntings')).toBe('/');
	});

	it('falls back on a scheme that is not a path, and on anything normalising into another origin', () => {
		expect(safeRedirectPath('javascript:alert(1)')).toBe('/');
		expect(safeRedirectPath('mailto:someone@example.com')).toBe('/');
		expect(safeRedirectPath('/\tevil.example')).toBe('/');
		// `..` segments, and their encoded forms, are resolved by the parser — so the result can start `//`.
		expect(safeRedirectPath('/..//evil.example')).toBe('/');
		expect(safeRedirectPath('/%2e%2e//evil.example')).toBe('/');
		expect(safeRedirectPath('/./..//evil.example')).toBe('/');
	});

	it('returns the parser normalised path rather than the raw input', () => {
		expect(safeRedirectPath('/title/./movie/603')).toBe('/title/movie/603');
		expect(safeRedirectPath('/title/season/../movie/603')).toBe('/title/movie/603');
		// A backslash is a slash to a browser, so the path it meant is the one returned.
		expect(safeRedirectPath('/title\\movie\\603')).toBe('/title/movie/603');
	});

	it('honours a caller-supplied fallback', () => {
		expect(safeRedirectPath('https://evil.example', '')).toBe('');
	});
});

describe('loginPathWithRedirect', () => {
	it('encodes the destination', () => {
		expect(loginPathWithRedirect('/title/show/1399?season=2')).toBe(
			'/login?redirectTo=%2Ftitle%2Fshow%2F1399%3Fseason%3D2'
		);
	});

	it('drops a destination that is invalid or not worth preserving', () => {
		expect(loginPathWithRedirect('https://evil.example')).toBe('/login');
		expect(loginPathWithRedirect('/')).toBe('/login');
		expect(loginPathWithRedirect(null)).toBe('/login');
		expect(loginPathWithRedirect('/login')).toBe('/login');
	});
});
