export interface EmailSender {
	send(opts: { to: string; subject: string; html: string }): Promise<void>;
}
