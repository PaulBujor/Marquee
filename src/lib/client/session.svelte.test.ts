import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reportClientError } from './report-error';
import { session } from './session.svelte';

vi.mock('./report-error', () => ({ reportClientError: vi.fn() }));

describe('session state', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		session.reset();
	});

	describe('expire', () => {
		it('flips expired to true on the first call', () => {
			expect(session.expired).toBe(false);
			session.expire('sync');
			expect(session.expired).toBe(true);
		});

		it('is idempotent — subsequent calls do nothing', () => {
			session.expire('sync');
			session.expire('media-sync');
			session.expire('image-sync');

			expect(session.expired).toBe(true);
			// Only the first call should have reported.
			expect(reportClientError).toHaveBeenCalledTimes(1);
		});

		it('reports to the diagnostics sink with handled: true', () => {
			session.expire('sync');

			expect(reportClientError).toHaveBeenCalledWith(
				expect.objectContaining({
					message: 'Session expired (sync)',
					source: 'session-expiry',
					handled: true
				})
			);
		});

		it('includes the source in the reported message', () => {
			session.expire('media-sync');

			expect(reportClientError).toHaveBeenCalledWith(
				expect.objectContaining({ message: 'Session expired (media-sync)' })
			);
		});
	});

	describe('reset', () => {
		it('clears expired and announced', () => {
			session.expire('sync');
			session.announced = true;

			session.reset();

			expect(session.expired).toBe(false);
			expect(session.announced).toBe(false);
		});

		it('allows a fresh expire after reset', () => {
			session.expire('sync');
			session.reset();

			session.expire('sync');

			expect(session.expired).toBe(true);
			expect(reportClientError).toHaveBeenCalledTimes(2);
		});
	});

	describe('authFailed', () => {
		it('returns true and marks expired on a 401', () => {
			const res = new Response(null, { status: 401 });

			const result = session.authFailed(res, 'sync');
			expect(result).toBe(true);
			expect(session.expired).toBe(true);
		});

		it('returns false and does nothing on a non-401 status', () => {
			const res200 = new Response(null, { status: 200 });
			const res403 = new Response(null, { status: 403 });
			const res500 = new Response(null, { status: 500 });

			expect(session.authFailed(res200, 'sync')).toBe(false);
			expect(session.authFailed(res403, 'sync')).toBe(false);
			expect(session.authFailed(res500, 'sync')).toBe(false);
			expect(session.expired).toBe(false);
		});

		it('is idempotent like expire — second 401 is a no-op', () => {
			const res = new Response(null, { status: 401 });

			session.authFailed(res, 'sync');
			session.authFailed(res, 'media-sync');

			expect(session.expired).toBe(true);
			expect(reportClientError).toHaveBeenCalledTimes(1);
		});
	});
});