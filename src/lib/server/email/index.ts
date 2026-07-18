import { ResendSender } from './resend';
import { SmtpSender } from './smtp';

export interface EmailSender {
	send(opts: { to: string; subject: string; html: string }): Promise<void>;
}

/**
 * Resolve the email transport: SMTP (Mailpit in dev) when `SMTP_HOST` is set,
 * otherwise Resend. `EMAIL_FROM` must be a Resend-verified sender in prod.
 */
export function createEmailSender(env: Env): EmailSender {
	const from = env.EMAIL_FROM;
	if (!from) throw new Error('EMAIL_FROM is not configured');

	if (env.SMTP_HOST) {
		return new SmtpSender(env.SMTP_HOST, Number(env.SMTP_PORT) || 1025, from);
	}
	if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured');
	return new ResendSender(env.RESEND_API_KEY, from);
}
