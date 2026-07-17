import { dev } from '$app/environment';
import { ResendSender } from './resend';
import { SmtpSender } from './smtp';

export interface EmailSender {
	send(opts: { to: string; subject: string; html: string }): Promise<void>;
}

/**
 * Resolve the environment-appropriate email transport.
 *
 * In dev we deliver to Mailpit over SMTP (see `docker-compose.yml`; host/port
 * come from `.dev.vars`, defaulting to `localhost:1025`) so no real Resend key
 * is ever needed locally. In production we use Resend over HTTPS.
 */
export function createEmailSender(env: Env): EmailSender {
	if (dev) {
		return new SmtpSender(env.SMTP_HOST || 'localhost', Number(env.SMTP_PORT) || 1025);
	}
	return new ResendSender(env.RESEND_API_KEY);
}
