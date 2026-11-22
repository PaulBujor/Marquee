import nodemailer from 'nodemailer';
import type { EmailSender } from './index';

export class SmtpSender implements EmailSender {
	private transporter: ReturnType<typeof nodemailer.createTransport>;

	constructor(
		host: string,
		port: number,
		private from: string
	) {
		this.transporter = nodemailer.createTransport({
			host,
			port,
			secure: false
		});
	}

	async send(opts: { to: string; subject: string; html: string }): Promise<void> {
		await this.transporter.sendMail({
			from: this.from,
			to: opts.to,
			subject: opts.subject,
			html: opts.html
		});
	}
}
