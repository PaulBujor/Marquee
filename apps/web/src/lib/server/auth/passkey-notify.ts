import { env, waitUntil } from '#lib/server/bindings.js';
import type { User } from '#lib/server/db/schema.js';
import { createEmailSender } from '#lib/server/email/index.js';
import { renderPasskeyChangedEmail } from '#lib/server/email/templates.js';

/**
 * Tells the account owner that a credential changed. Best-effort and out-of-band: it's the only signal
 * a user gets, so a stolen session that enrols its own passkey can't go unnoticed.
 */
export function notifyPasskeyChange(
	user: Pick<User, 'email'>,
	action: 'added' | 'removed',
	name: string
): void {
	if (!env.RESEND_API_KEY && !env.SMTP_HOST) return;
	try {
		const sender = createEmailSender(env);
		waitUntil(
			sender
				.send({
					to: user.email,
					subject:
						action === 'added'
							? 'A passkey was added to Marquee'
							: 'A passkey was removed from Marquee',
					html: renderPasskeyChangedEmail(action, name)
				})
				.catch((err) => console.error('passkey notification failed:', err))
		);
	} catch (err) {
		console.error('passkey notification setup failed:', err);
	}
}
