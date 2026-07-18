import { ResendSender } from './resend';
import { SmtpSender } from './smtp';

export interface EmailSender {
	send(opts: { to: string; subject: string; html: string }): Promise<void>;
}

/**
 * Resolve the email transport from the environment (a *runtime* decision, so it
 * is correct under both `pnpm dev` and the built worker in `wrangler dev`).
 *
 * When `SMTP_HOST` is set we deliver over SMTP — locally that's Mailpit (see
 * `docker-compose.yml`; `.dev.vars` sets host/port), so no Resend key is needed
 * in dev. Otherwise we use Resend over HTTPS (production).
 */
export function createEmailSender(env: Env): EmailSender {
	// Fail hard on misconfiguration rather than silently sending from a wrong
	// address. `from` must be set everywhere (a Resend-verified sender in prod).
	const from = env.EMAIL_FROM;
	if (!from) throw new Error('EMAIL_FROM is not configured');

	if (env.SMTP_HOST) {
		return new SmtpSender(env.SMTP_HOST, Number(env.SMTP_PORT) || 1025, from);
	}
	if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured');
	return new ResendSender(env.RESEND_API_KEY, from);
}
