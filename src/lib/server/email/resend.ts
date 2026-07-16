import { Resend } from 'resend';
import type { EmailSender } from './index';

export class ResendSender implements EmailSender {
	private resend: Resend;

	constructor(apiKey: string) {
		this.resend = new Resend(apiKey);
	}

	async send(opts: { to: string; subject: string; html: string }): Promise<void> {
		const { error } = await this.resend.emails.send({
			from: 'Marquee <noreply@marquee.app>',
			to: [opts.to],
			subject: opts.subject,
			html: opts.html
		});

		if (error) {
			throw new Error(`Failed to send email: ${error.message}`);
		}
	}
}
