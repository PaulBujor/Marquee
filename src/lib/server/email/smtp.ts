import nodemailer from 'nodemailer';
import type { EmailSender } from './index';

export class SmtpSender implements EmailSender {
	private transporter: nodemailer.Transporter;

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
