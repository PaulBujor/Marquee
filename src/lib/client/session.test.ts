import { describe, expect, it } from 'vitest';
import { assertAuthed, isAuthFailure, SessionExpiredError } from './session';

describe('SessionExpiredError', () => {
	it('carries the source that detected the expiry', () => {
		const err = new SessionExpiredError('sync');
		expect(err.source).toBe('sync');
		expect(err.message).toBe('session expired: HTTP 401 from sync');
		expect(err.name).toBe('SessionExpiredError');
	});
});

describe('isAuthFailure', () => {
	it('returns true for 401', () => {
		expect(isAuthFailure(401)).toBe(true);
	});

	it('returns false for any other status', () => {
		expect(isAuthFailure(200)).toBe(false);
		expect(isAuthFailure(403)).toBe(false);
		expect(isAuthFailure(429)).toBe(false);
		expect(isAuthFailure(500)).toBe(false);
		expect(isAuthFailure(0)).toBe(false);
	});
});

describe('assertAuthed', () => {
	it('throws SessionExpiredError on a 401', () => {
		const res = new Response(null, { status: 401 });
		expect(() => assertAuthed(res, 'sync')).toThrow(SessionExpiredError);
	});

	it('includes the source in the thrown error', () => {
		const res = new Response(null, { status: 401 });
		try {
			assertAuthed(res, 'media-sync');
		} catch (err) {
			expect(err).toBeInstanceOf(SessionExpiredError);
			expect((err as SessionExpiredError).source).toBe('media-sync');
		}
	});

	it('is a no-op for a non-401 status', () => {
		const res = new Response(null, { status: 503 });
		expect(() => assertAuthed(res, 'sync')).not.toThrow();
	});

	it('is a no-op for a 200 status', () => {
		const res = new Response(null, { status: 200 });
		expect(() => assertAuthed(res, 'sync')).not.toThrow();
	});
});