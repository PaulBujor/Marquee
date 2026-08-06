import { describe, expect, it } from 'vitest';
import { isAuthorizedCronRequest, timingSafeEqual } from './secret';

const req = (headers: Record<string, string> = {}) =>
	new Request('https://example.test/api/cron/refresh', { method: 'POST', headers });

describe('timingSafeEqual', () => {
	it('accepts identical secrets', async () => {
		await expect(timingSafeEqual('s3cret', 's3cret')).resolves.toBe(true);
	});

	it('rejects a differing secret of the same length', async () => {
		await expect(timingSafeEqual('s3cret', 's3crXt')).resolves.toBe(false);
	});

	it('rejects secrets of different lengths', async () => {
		await expect(timingSafeEqual('s3cret', 's3cret-longer')).resolves.toBe(false);
	});

	it('rejects a correct prefix', async () => {
		await expect(timingSafeEqual('s3c', 's3cret')).resolves.toBe(false);
	});

	it('handles empty strings without matching a real secret', async () => {
		await expect(timingSafeEqual('', '')).resolves.toBe(true);
		await expect(timingSafeEqual('', 's3cret')).resolves.toBe(false);
	});

	it('is not confused by non-ASCII input', async () => {
		await expect(timingSafeEqual('sécret', 'sécret')).resolves.toBe(true);
		await expect(timingSafeEqual('sécret', 'secret')).resolves.toBe(false);
	});
});

describe('isAuthorizedCronRequest', () => {
	it('authorizes a matching x-cron-key', async () => {
		await expect(isAuthorizedCronRequest(req({ 'x-cron-key': 'top' }), 'top')).resolves.toBe(true);
	});

	it('rejects a wrong key', async () => {
		await expect(isAuthorizedCronRequest(req({ 'x-cron-key': 'nope' }), 'top')).resolves.toBe(
			false
		);
	});

	it('rejects a missing header', async () => {
		await expect(isAuthorizedCronRequest(req(), 'top')).resolves.toBe(false);
	});

	it('fails closed when the secret is not configured', async () => {
		// A missing binding must not authorize every caller.
		await expect(isAuthorizedCronRequest(req({ 'x-cron-key': 'top' }), undefined)).resolves.toBe(
			false
		);
		await expect(isAuthorizedCronRequest(req({ 'x-cron-key': '' }), '')).resolves.toBe(false);
	});
});
