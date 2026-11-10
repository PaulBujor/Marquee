import { describe, expect, it } from 'vitest';
import type { Cookies } from '@sveltejs/kit';
import {
	deleteSessionCookie,
	sessionCookieDomain,
	SESSION_COOKIE,
	setSessionCookie
} from './session.js';

type Call = { kind: 'set' | 'delete'; name: string; value?: string; opts: Record<string, unknown> };

function recorder() {
	const calls: Call[] = [];
	const cookies = {
		set: (name: string, value: string, opts: Record<string, unknown>) => {
			calls.push({ kind: 'set', name, value, opts });
		},
		delete: (name: string, opts: Record<string, unknown>) => {
			calls.push({ kind: 'delete', name, opts });
		}
	} as unknown as Cookies;
	return { calls, cookies };
}

const PREVIEW_DOMAIN = '.preview.marquee.paulbujor.net';
const EXPIRES = new Date('2026-12-01T00:00:00Z');

describe('session cookie scope', () => {
	it('stays host-only when no preview domain is configured', () => {
		const { calls, cookies } = recorder();
		setSessionCookie(cookies, 'token', EXPIRES);

		expect(calls).toHaveLength(1);
		expect('domain' in calls[0].opts).toBe(false);
		expect(calls[0].opts.domain).toBeUndefined();
	});

	it('widens to the preview parent domain when one is configured', () => {
		const { calls, cookies } = recorder();
		setSessionCookie(cookies, 'token', EXPIRES, PREVIEW_DOMAIN);

		expect(calls[0].opts.domain).toBe(PREVIEW_DOMAIN);
	});

	it('clears both scopes, so a cookie minted under the other one cannot shadow the logout', () => {
		const { calls, cookies } = recorder();
		deleteSessionCookie(cookies, PREVIEW_DOMAIN);

		expect(calls).toHaveLength(2);
		expect(calls[0]).toMatchObject({ kind: 'delete', name: SESSION_COOKIE });
		expect(calls[0].opts).toEqual({ path: '/' });
		expect(calls[1].opts).toEqual({ path: '/', domain: PREVIEW_DOMAIN });
	});

	it('deletes host-only when no preview domain is configured', () => {
		const { calls, cookies } = recorder();
		deleteSessionCookie(cookies);

		expect(calls[0].opts).toEqual({ path: '/' });
	});

	it('keeps the hardening flags on both paths', () => {
		for (const domain of [undefined, PREVIEW_DOMAIN]) {
			const { calls, cookies } = recorder();
			setSessionCookie(cookies, 'token', EXPIRES, domain);

			expect(calls[0].value).toBe('token');
			expect(calls[0].opts).toMatchObject({
				path: '/',
				httpOnly: true,
				sameSite: 'lax',
				secure: true,
				expires: EXPIRES
			});
		}
	});
});

describe('preview cookie domain', () => {
	const parent = '.preview.marquee.paulbujor.net';
	const preview = { PREVIEW_NOINDEX: '1', PREVIEW_COOKIE_DOMAIN: parent };

	it('is dropped when nothing is configured', () => {
		expect(sessionCookieDomain('marquee.paulbujor.net', {})).toBeUndefined();
	});

	it('applies on a preview host that sits under it', () => {
		expect(preview && sessionCookieDomain('marquee.preview.marquee.paulbujor.net', preview)).toBe(
			parent
		);
		expect(sessionCookieDomain('pr-281.preview.marquee.paulbujor.net', preview)).toBe(parent);
	});

	it('is dropped on a host that is not under it, where the browser rejects the cookie', () => {
		// A version preview URL (`*.workers.dev`) or any other host: a Domain the host isn't under is
		// discarded silently, which is what made preview sign-ins bounce back to `/login`.
		expect(sessionCookieDomain('abc-marquee.paul.workers.dev', preview)).toBeUndefined();
		expect(sessionCookieDomain('marquee.paulbujor.net', preview)).toBeUndefined();
	});

	it('does not match a look-alike host that merely ends with the same text', () => {
		expect(sessionCookieDomain('preview.marquee.paulbujor.net.evil.test', preview)).toBeUndefined();
		expect(sessionCookieDomain('evil-preview.marquee.paulbujor.net', preview)).toBeUndefined();
	});

	it('never widens the cookie outside a preview deployment', () => {
		// A stray value on prod must not hand the session to every sibling host.
		expect(
			sessionCookieDomain('marquee.paulbujor.net', { PREVIEW_COOKIE_DOMAIN: '.paulbujor.net' })
		).toBeUndefined();
	});

	it('rejects a configured value shallower than a subdomain', () => {
		expect(
			sessionCookieDomain('paulbujor.net', {
				PREVIEW_NOINDEX: '1',
				PREVIEW_COOKIE_DOMAIN: '.paulbujor.net'
			})
		).toBeUndefined();
	});
});
