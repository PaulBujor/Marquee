import { describe, it, expect } from 'vitest';
import { createEmailSender } from './index';
import { SmtpSender } from './smtp';
import { ResendSender } from './resend';

describe('createEmailSender', () => {
	it('throws if EMAIL_FROM is not configured', () => {
		expect(() => createEmailSender({} as Env)).toThrow(/EMAIL_FROM/);
	});

	it('uses SMTP when SMTP_HOST is set', () => {
		const sender = createEmailSender({
			EMAIL_FROM: 'Marquee <a@b.com>',
			SMTP_HOST: '127.0.0.1',
			SMTP_PORT: '1025'
		} as Env);
		expect(sender).toBeInstanceOf(SmtpSender);
	});

	it('uses Resend when SMTP_HOST is absent', () => {
		const sender = createEmailSender({
			EMAIL_FROM: 'Marquee <a@b.com>',
			RESEND_API_KEY: 're_test'
		} as Env);
		expect(sender).toBeInstanceOf(ResendSender);
	});

	it('throws if neither SMTP nor Resend is configured', () => {
		expect(() => createEmailSender({ EMAIL_FROM: 'Marquee <a@b.com>' } as Env)).toThrow(
			/RESEND_API_KEY/
		);
	});
});
