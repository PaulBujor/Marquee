import { describe, expect, it } from 'vitest';
import type { Cookies } from '@sveltejs/kit';
import { deleteSessionCookie, SESSION_COOKIE, setSessionCookie } from './session.js';

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

	it('deletes with the same domain it set, so one logout clears every preview', () => {
		const { calls, cookies } = recorder();
		deleteSessionCookie(cookies, PREVIEW_DOMAIN);

		expect(calls[0]).toMatchObject({ kind: 'delete', name: SESSION_COOKIE });
		expect(calls[0].opts).toEqual({ path: '/', domain: PREVIEW_DOMAIN });
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
