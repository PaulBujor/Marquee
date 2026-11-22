import { describe, expect, it } from 'vitest';
import { createPushSender } from './index';

const configured = {
	VAPID_PUBLIC_KEY: 'pub-base64url',
	VAPID_PRIVATE_KEY: '{"kty":"EC","crv":"P-256","d":"x"}',
	EMAIL_FROM: 'Marquee <hi@marquee.app>'
} as unknown as Env;

describe('createPushSender', () => {
	it('throws when either VAPID key is missing', () => {
		expect(() => createPushSender({ ...configured, VAPID_PRIVATE_KEY: '' } as Env)).toThrow(
			/VAPID_PRIVATE_KEY/
		);
		expect(() => createPushSender({ ...configured, VAPID_PUBLIC_KEY: '' } as Env)).toThrow(
			/VAPID_PUBLIC_KEY/
		);
	});

	it('returns a sender when the key pair is present', () => {
		const sender = createPushSender(configured);
		expect(typeof sender.send).toBe('function');
	});
});
